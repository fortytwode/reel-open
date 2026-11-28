import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "product_releases", Path(__file__).resolve().parents[1] / "scripts" / "sync-product-release.py"
)
syncer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(syncer)


class ProductReleaseTest(unittest.TestCase):
    def setUp(self):
        self.revision = "1" * 40
        self.dmg = "Reel-Notetaker-2.0.0-macOS-universal.dmg"
        self.content = {self.dmg: b"test installer"}
        self.content["SHA256SUMS.txt"] = f"{self.digest(self.dmg)}  {self.dmg}\n".encode()
        self.source = {
            "tag_name": "notetaker-v2.0.0", "draft": False, "prerelease": False,
            "html_url": "https://github.com/rocketshiphq/reel-open/releases/tag/notetaker-v2.0.0",
            "body": "Release notes", "assets": [
                {"name": name, "state": "uploaded", "digest": "sha256:" + self.digest(name)}
                for name in self.content
            ],
        }

    def digest(self, name):
        return hashlib.sha256(self.content[name]).hexdigest()

    def test_copies_only_selected_product_and_verifies_release(self):
        newer_recorder = {**self.source, "tag_name": "v8.0.0"}
        preview = {**self.source, "tag_name": "notetaker-v9.0.0", "prerelease": True}
        published = {**self.source, "tag_name": "v2.0.0",
                     "body": f"https://github.com/rocketshiphq/reel-open/tree/{self.revision}"}
        uploads = []

        def github(*args):
            self.assertEqual(args[0], "release")
            if args[1] == "download":
                self.assertEqual(args[2], "notetaker-v2.0.0")
                name = args[args.index("-p") + 1]
                (Path(args[-1]) / name).write_bytes(self.content[name])
                return ""
            self.assertEqual(args[1:3], ("create", "v2.0.0"))
            self.assertIn("rocketshiphq/notetaker-ai", args)
            self.assertIn(self.revision, Path(args[-1]).read_text())
            uploads.extend(Path(arg).name for arg in args[3:5])
            return "https://github.com/rocketshiphq/notetaker-ai/releases/tag/v2.0.0"

        with patch.object(syncer, "releases", side_effect=[[newer_recorder, preview, self.source], []]), \
                patch.object(syncer, "published_source", return_value=self.revision), \
                patch.object(syncer, "gh", side_effect=github), patch.object(syncer, "api", return_value=published):
            syncer.sync("notetaker")
        self.assertEqual(uploads, [self.dmg, "SHA256SUMS.txt"])

    def test_rejects_tag_outside_public_main(self):
        compare = {"merge_base_commit": {"sha": "2" * 40}}
        with patch.object(syncer, "api", side_effect=[{"sha": self.revision}, compare]):
            with self.assertRaisesRegex(SystemExit, "outside the public main"):
                syncer.published_source("notetaker-v2.0.0")

    def test_preserves_existing_nonmatching_release(self):
        different = {**self.source, "tag_name": "v2.0.0", "assets": [
            {**asset, "digest": "sha256:" + "0" * 64} for asset in self.source["assets"]
        ]}
        with patch.object(syncer, "releases", side_effect=[[self.source], [different]]), \
                patch.object(syncer, "published_source", return_value=self.revision), patch.object(syncer, "gh") as gh:
            with self.assertRaisesRegex(SystemExit, "Existing assets were preserved"):
                syncer.sync("notetaker")
            gh.assert_not_called()
