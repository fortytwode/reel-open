import hashlib
import io
import json
import re
import runpy
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
render = runpy.run_path(str(ROOT / "scripts/configure-organization.py"))["render"]


class OrganizationConfigurationTests(unittest.TestCase):
    def test_second_organization_clients_rules_and_backend_match(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = json.loads((ROOT / "organization.example.json").read_text())
            config.update(allowedEmailDomain="research.second.example", projectID="demo-second", privateKey="test-only")
            source = root / "input.json"
            source.write_text(json.dumps(config))
            render(source, root=root)
            client = (root / "web/organization.json").read_text()
            for path in [".reel/organization.json", "desktop-windows/organization.json"]:
                self.assertEqual((root / path).read_text(), client)
            self.assertEqual(json.loads(client)["projectID"], "demo-second")
            self.assertNotIn("privateKey", client)
            env = (root / ".reel/backend.env").read_text()
            self.assertIn("REEL_ORGANIZATION_DOMAIN=research.second.example", env)
            self.assertIn("REEL_MEETING_ALLOWED_DOMAIN=research.second.example", env)
            self.assertIn("REEL_FIREBASE_PROJECT=demo-second", env)
            for name in ("storage.rules", "firestore.rules"):
                rules = (root / ".reel/firebase" / name).read_text()
                pattern = re.search(r"token.email.lower\(\).matches\('([^']+)'\)", rules)[1].replace("\\\\", "\\")
                self.assertTrue(re.fullmatch(pattern, "user@research.second.example"))
                for bad in ("a@researchXsecond.example", "a@org.example", "a@research.second.example.attacker", "x@y@research.second.example"):
                    self.assertIsNone(re.fullmatch(pattern, bad))
            self.assertEqual(json.loads((root / ".reel/firebase/cors.json").read_text())[0]["origin"], config["allowedOrigins"])

    def test_browser_only_install_does_not_require_optional_platforms_or_services(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = json.loads((ROOT / "organization.example.json").read_text())
            optional = ("googleClientID", "googleDesktopClientId", "meetingServiceURL", "deliveryServiceURL", "speechServiceURL")
            for key in optional:
                config.pop(key)
            source = root / "input.json"
            source.write_text(json.dumps(config))
            render(source, root=root)
            client = json.loads((root / "web/organization.json").read_text())
            self.assertEqual(client["projectID"], config["projectID"])
            self.assertEqual(client["allowedEmailDomain"], config["allowedEmailDomain"])
            self.assertEqual(client["googleClientID"], "")
            self.assertEqual(client["googleDesktopClientId"], "")
            for key in optional[2:]:
                self.assertEqual(client[key], "https://unconfigured.invalid")

    def test_firebase_deployment_selects_configured_database_and_rule_paths(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            config = json.loads((ROOT / "organization.example.json").read_text())
            source = root / "input.json"
            source.write_text(json.dumps(config | {"firestoreDatabase": "team-notes"}))
            render(source, root=root)
            deployment = json.loads((root / "firebase.local.json").read_text())
            self.assertEqual(deployment["firestore"], [{"database": "team-notes", "rules": ".reel/firebase/firestore.rules"}])
            self.assertEqual(deployment["storage"], [{"target": "main", "rules": ".reel/firebase/storage.rules"}])

    def test_extension_manifest_targets_the_configured_web_host(self):
        extension = ROOT / "browser-extension"
        generic = json.loads((extension / "manifest.json").read_text())
        self.assertNotIn("homepage_url", generic)
        self.assertEqual(len(generic["content_scripts"]), 1)
        for web_base, match in (("https://recorder.second.example", "https://recorder.second.example/record*"),
                                ("http://localhost:5000", "http://localhost/record*")):
            with self.subTest(web_base=web_base), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config = json.loads((ROOT / "organization.example.json").read_text())
                source = root / "input.json"
                source.write_text(json.dumps(config | {"webBase": web_base, "privateKey": "test-only"}))
                render(source, root=root)
                package = root / ".reel/browser-extension"
                manifest = json.loads((package / "manifest.json").read_text())
                self.assertEqual(manifest["homepage_url"], web_base)
                scope = hashlib.sha256(f'{config["projectID"]}\n{config["allowedEmailDomain"]}'.encode()).hexdigest()
                self.assertEqual(manifest["version_name"], f'{generic["version"]} ({scope})')
                self.assertEqual(manifest["host_permissions"], [*generic["host_permissions"], match])
                self.assertEqual(manifest["content_scripts"], [*generic["content_scripts"], {
                    "matches": [match], "js": ["organization.js", "reel-relay.js"], "run_at": "document_idle",
                }])
                self.assertEqual({path.name for path in package.iterdir()}, {
                    "manifest.json", "organization.js", "parser.js", "content.js", "background.js",
                    "reel-relay.js", "icon128.png",
                })
                for path in package.iterdir():
                    if path.name != "manifest.json":
                        self.assertEqual(path.read_bytes(), (extension / path.name).read_bytes())
                self.assertNotIn("test-only", (package / "manifest.json").read_text())

    def test_renderer_uses_utf8_with_a_windows_legacy_default_encoding(self):
        original_encoding = io.text_encoding
        def windows_encoding(encoding, stacklevel=2):
            return "cp1252" if encoding is None else original_encoding(encoding, stacklevel)
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            with patch("io.text_encoding", windows_encoding):
                render(ROOT / "organization.example.json", root=root)
            for name in ("background.js", "content.js", "parser.js", "reel-relay.js"):
                self.assertEqual((root / ".reel/browser-extension" / name).read_bytes(),
                                 (ROOT / "browser-extension" / name).read_bytes())

    def test_storage_bucket_names_need_not_be_dns_hostnames(self):
        for bucket in ("northwind-recordings", "northwind_recordings", "demo-reel.firebasestorage.app"):
            with self.subTest(bucket=bucket), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config = json.loads((ROOT / "organization.example.json").read_text())
                source = root / "input.json"
                source.write_text(json.dumps(config | {"bucket": bucket}))
                render(source, root=root)
                self.assertEqual(json.loads((root / "web/organization.json").read_text())["bucket"], bucket)
        for bucket in ("ab", "Bad-Bucket", "bad/bucket", "192.168.0.1", "a" * 64):
            with self.subTest(bucket=bucket), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config = json.loads((ROOT / "organization.example.json").read_text())
                source = root / "input.json"
                source.write_text(json.dumps(config | {"bucket": bucket}))
                with self.assertRaises(ValueError):
                    render(source, root=root)

    def test_invalid_policy_produces_no_deployment_files(self):
        for bad in ({"allowedEmailDomain": ".*"}, {"allowedEmailDomain": "bad.'example"}, {"allowedOrigins": ["*"]},
                    {"deliveryServiceURL": "http://api.second.example"}, {"apiKey": ""}):
            with self.subTest(bad=bad), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                config = json.loads((ROOT / "organization.example.json").read_text())
                source = root / "input.json"
                source.write_text(json.dumps(config | bad))
                with self.assertRaises(ValueError):
                    render(source, root=root)
                self.assertFalse((root / "web").exists())
