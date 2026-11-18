#!/usr/bin/env python3
"""Materialize the public source files from a committed Reel revision."""

import argparse
import io
from pathlib import Path, PurePosixPath
import subprocess


ROOT = Path(__file__).resolve().parent.parent

FILES = set("""
.github/workflows/open-source-ci.yml
.github/workflows/web-recorder.yml
.gitignore
LICENSE
Package.resolved
Package.swift
README.md
THIRD_PARTY_NOTICES.md
VERSION
Resources/Reel.entitlements
Tests/CrossClient/cross-client.json
Tests/test_organization_configuration.py
deployment-adapter/README.md
docs/meetings-calendar-contract.md
docs/organization-configuration.md
docs/self-hosting.md
firebase.json
firebase/cors.json
firebase/firestore.rules
firebase/storage.rules
firebase/tests/.gitignore
firebase/tests/configure-emulator.mjs
firebase/tests/organization-rules.mjs
firebase/tests/package-lock.json
firebase/tests/package.json
firebase/tests/recorder-smoke.mjs
browser-extension/README.md
browser-extension/background.js
browser-extension/background.test.js
browser-extension/content.browser.test.cjs
browser-extension/content.js
browser-extension/icon128.png
browser-extension/manifest.json
browser-extension/organization.js
browser-extension/package.json
browser-extension/parser.js
browser-extension/parser.test.js
browser-extension/reel-relay.js
delivery-service/Dockerfile
delivery-service/README.md
delivery-service/app.py
delivery-service/build-context.sh
delivery-service/main.py
delivery-service/providers.py
delivery-service/requirements.txt
delivery-service/standalone_providers.py
delivery-service/test_calendar_credentials.py
delivery-service/test_delivery.py
delivery-service/test_gmail_recovery.py
delivery-service/test_orchestration.py
delivery-service/test_provider_selection.py
delivery-service/test_standalone_providers.py
desktop-windows/PACKAGING.md
desktop-windows/README.md
desktop-windows/build-portable.ps1
desktop-windows/config.json
desktop-windows/main.mjs
desktop-windows/package-lock.json
desktop-windows/package.json
desktop-windows/preload.cjs
desktop-windows/test-local.ps1
desktop-windows/native/.gitignore
desktop-windows/native/build-fixture.cmd
desktop-windows/native/build.cmd
desktop-windows/probe/.gitignore
desktop-windows/probe/README.md
desktop-windows/probe/package-lock.json
desktop-windows/probe/package.json
meeting-bot/.dockerignore
meeting-bot/Dockerfile
meeting-bot/Dockerfile.google-session
meeting-bot/README.md
meeting-bot/google_auth.py
meeting-bot/google_session_setup.py
meeting-bot/policy.py
meeting-bot/providers.py
meeting-bot/requirements.txt
meeting-bot/tests/browser_meet_controls.py
meeting-bot/transcribe.py
meeting-bot/worker.py
meeting-service/Dockerfile
meeting-service/README.md
meeting-service/app.py
meeting-service/build-context.sh
meeting-service/calendar_meetings.py
meeting-service/calendar_runtime.py
meeting-service/cloud_processing.py
meeting-service/requirements.txt
meeting-service/speech.py
organization.example.json
reel_organization.py
scripts/build-app.sh
scripts/configure-organization.py
scripts/export-open-source.py
scripts/fetch-web-model.py
scripts/make-icon.swift
scripts/test-meeting-setup.sh
scripts/tests/MeetingNotionSmoke.swift
scripts/tests/MeetingSetupSmoke.swift
scripts/tests/WindowPickerSmoke.swift
test_organization.py
web/favicon.svg
web/icons/reel-192.png
web/icons/reel-512.png
web/reel.webmanifest
web/vendor/hls.js.LICENSE
web/vendor/hls.min.js
web/vendor/mediapipe/LICENSE
web/vendor/mediapipe/README.txt
web/vendor/mediapipe/vision_bundle.mjs
web/vendor/mediapipe/wasm/vision_wasm_internal.js
web/vendor/mediapipe/wasm/vision_wasm_internal.wasm
web/vendor/mp4-muxer.LICENSE
web/vendor/mp4-muxer.mjs
""".split())

SOURCE_SUFFIXES = {
    "desktop-windows/capture": {".cjs", ".html", ".mjs"},
    "desktop-windows/native": {".cs"},
    "desktop-windows/probe": {".html", ".mjs"},
    "desktop-windows/src": {".mjs"},
    "desktop-windows/ui": {".css", ".html", ".mjs"},
    "web": {".css", ".html", ".js"},
    "web/reel": {".js"},
}
NODE_TEST_DIRS = {"desktop-windows/tests", "firebase/tests"}
PYTHON_TEST_DIRS = {"meeting-bot/tests", "meeting-service"}


def included(name):
    path = PurePosixPath(name)
    if any(part.startswith(".") for part in path.parts):
        return name in FILES
    parent = str(path.parent)
    return (
        name in FILES
        or (name.startswith(("Sources/Reel/", "Sources/ReelCore/", "Tests/ReelCoreTests/")) and path.suffix == ".swift")
        or path.suffix in SOURCE_SUFFIXES.get(parent, ())
        or (parent in NODE_TEST_DIRS and path.name.endswith(".test.mjs"))
        or (parent in PYTHON_TEST_DIRS and path.name.startswith("test_") and path.suffix == ".py")
    )


def git(*args, input_bytes=None):
    return subprocess.check_output(("git", *args), cwd=ROOT, input=input_bytes)


def export(ref, destination):
    if destination.is_symlink():
        raise ValueError("destination must be a regular directory")
    destination = destination.resolve()
    if destination.is_relative_to(ROOT):
        raise ValueError("destination must be outside the source checkout")
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise ValueError("destination must be a new or empty directory")

    commit = git("rev-parse", "--verify", "--end-of-options", f"{ref}^{{commit}}").decode().strip()
    files = {}
    for entry in git("ls-tree", "-r", "-z", "--full-tree", commit).split(b"\0"):
        if not entry:
            continue
        metadata, raw_name = entry.split(b"\t", 1)
        name = raw_name.decode("utf-8")
        if not included(name):
            continue
        mode, kind, oid = metadata.split()
        if kind != b"blob" or mode not in (b"100644", b"100755"):
            raise ValueError(f"public path must be a regular file: {name}")
        files[name] = (oid, int(mode, 8) & 0o777)

    missing = FILES - files.keys()
    if missing:
        raise ValueError("committed revision lacks public files: " + ", ".join(sorted(missing)))

    # Read raw objects so worktree filters and archive substitutions cannot alter the export.
    requests = b"".join(oid + b"\n" for oid, _ in files.values())
    contents = io.BytesIO(git("cat-file", "--batch", input_bytes=requests))
    destination.mkdir(parents=True, exist_ok=True)
    for name, (oid, mode) in files.items():
        header = contents.readline().split()
        if len(header) != 3 or header[:2] != [oid, b"blob"]:
            raise ValueError(f"unexpected Git object for {name}")
        size = int(header[2])
        blob = contents.read(size)
        if len(blob) != size or contents.read(1) != b"\n":
            raise ValueError(f"incomplete Git object for {name}")
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("xb") as output:
            output.write(blob)
        target.chmod(mode)
    return len(files), commit


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("ref", help="Committed source revision to export")
    parser.add_argument("destination", type=Path, help="New or empty directory outside the source checkout")
    args = parser.parse_args()
    try:
        count, commit = export(args.ref, args.destination)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Export failed: {error}\n")
    print(f"Exported {count} files from {commit} to {args.destination}")


if __name__ == "__main__":
    main()
