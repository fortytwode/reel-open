#!/usr/bin/env python3
"""Publish an existing public Reel release to its product repository."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

SOURCE = "rocketshiphq/reel-open"
PRODUCTS = {
    "recorder": ("rocketshiphq/recorder-ai", "Recorder", "v"),
    "notetaker": ("rocketshiphq/notetaker-ai", "Notetaker", "notetaker-v"),
}
VERSION = r"(\d+)\.(\d+)\.(\d+)"


def gh(*args):
    result = subprocess.run(["gh", *args], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(result.stderr.strip() or "GitHub command failed")
    return result.stdout


def api(endpoint, *args):
    return json.loads(gh("api", endpoint, *args))


def releases(repo):
    pages = api(f"repos/{repo}/releases?per_page=100", "--paginate", "--slurp")
    return [release for page in pages for release in page]


def published_versions(items, prefix):
    versions = []
    for item in items:
        match = re.fullmatch(re.escape(prefix) + VERSION, item["tag_name"])
        if match and not item["draft"] and not item["prerelease"]:
            versions.append((tuple(map(int, match.groups())), item))
    return versions


def release_assets(release, names):
    assets = {asset["name"]: asset for asset in release["assets"]}
    selected = {}
    for name in names:
        asset = assets.get(name, {})
        digest = asset.get("digest") or ""
        if asset.get("state") != "uploaded" or not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
            raise SystemExit(f"{release['tag_name']} has no uploaded asset with a verified digest for {name}")
        selected[name] = digest.removeprefix("sha256:")
    return selected


def published_source(tag):
    commit = api(f"repos/{SOURCE}/commits/refs/tags/{tag}")["sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise SystemExit("Could not resolve the public source revision")
    compare = api(f"repos/{SOURCE}/compare/{commit}...main?per_page=1")
    if compare["merge_base_commit"]["sha"] != commit:
        raise SystemExit(f"{tag} is outside the public main history")
    return commit


def matches_release(release, assets, revision):
    source_url = f"https://github.com/{SOURCE}/tree/{revision}"
    return (not release["draft"] and not release["prerelease"]
            and source_url in (release.get("body") or "")
            and release_assets(release, assets) == assets)


def sync(product, check=False):
    target, label, prefix = PRODUCTS[product]
    upstream = published_versions(releases(SOURCE), prefix)
    if not upstream:
        raise SystemExit(f"No stable source release found for {label} AI")
    version, source = max(upstream, key=lambda entry: entry[0])
    version_text = ".".join(map(str, version))
    tag = f"v{version_text}"
    source_tag = source["tag_name"]
    revision = published_source(source_tag)
    dmg = f"Reel-{label}-{version_text}-macOS-universal.dmg"
    assets = release_assets(source, (dmg, "SHA256SUMS.txt"))

    existing = releases(target)
    if any(v > version for v, _ in published_versions(existing, "v")):
        raise SystemExit(f"{target} already has a newer release")
    found = next((entry for entry in existing if entry["tag_name"] == tag), None)
    if found:
        if not matches_release(found, assets, revision):
            raise SystemExit(f"{target} {tag} differs from the stable source release. Existing assets were preserved.")
        print(f"{target} {tag} matches public source {revision}.")
        return
    if check:
        raise SystemExit(f"{target} {tag} is ready to sync from public source {revision}.")

    with tempfile.TemporaryDirectory(prefix="reel-release-") as directory:
        for name, expected in assets.items():
            gh("release", "download", source_tag, "-R", SOURCE, "-p", name, "-D", directory)
            with (Path(directory) / name).open("rb") as handle:
                if hashlib.file_digest(handle, "sha256").hexdigest() != expected:
                    raise SystemExit(f"GitHub download digest mismatch for {name}")
        checksum = (Path(directory) / "SHA256SUMS.txt").read_text().split()
        if checksum != [assets[dmg], dmg] and checksum != [assets[dmg], "*" + dmg]:
            raise SystemExit("The checksum file does not match the installer")
        if published_source(source_tag) != revision:
            raise SystemExit(f"{source_tag} moved during release sync")
        notes = Path(directory) / "release-notes.md"
        notes.write_text(
            (source.get("body") or "").rstrip() + "\n\n"
            + f"[Exact source commit](https://github.com/{SOURCE}/tree/{revision})"
            + f" · [Original release]({source['html_url']})\n"
        )
        print(gh(
            "release", "create", tag, *(str(Path(directory) / name) for name in assets),
            "-R", target, "--target", "main", "--latest", "--title", f"{label} AI {version_text} for Mac",
            "--notes-file", str(notes),
        ).strip())
    published = api(f"repos/{target}/releases/tags/{tag}")
    if not matches_release(published, assets, revision):
        raise SystemExit(f"Could not verify the published {target} release")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", choices=PRODUCTS)
    parser.add_argument("--check", action="store_true", help="Verify without publishing")
    args = parser.parse_args()
    sync(args.product, args.check)
