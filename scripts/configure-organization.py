#!/usr/bin/env python3
"""Render a deployment's client configuration and rules locally."""
import argparse
import hashlib
import json
import re
import shlex
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
LABEL = r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
HOST = rf"{LABEL}(?:\.{LABEL})+"
OAUTH = r"[A-Za-z0-9_-]+\.apps\.googleusercontent\.com"


def url(value, *, origin=False, local=False):
    if not isinstance(value, str) or re.search(r"[\s\\?#*]", value):
        raise ValueError("invalid URL")
    parts = urlsplit(value)
    loopback = parts.hostname in ("localhost", "127.0.0.1", "::1")
    if (not parts.hostname or parts.username is not None or parts.password is not None
            or (not loopback and not re.fullmatch(HOST, parts.hostname))
            or parts.scheme not in (("http", "https") if local and loopback else ("https",))
            or (origin and parts.path not in ("", "/"))):
        raise ValueError("invalid URL")
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    default_port = 443 if parts.scheme == "https" else 80
    port = f":{parts.port}" if parts.port is not None and parts.port != default_port else ""
    return f"{parts.scheme}://{host}{port}{parts.path.rstrip('/')}"


def valid_storage_bucket(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", value):
        return False
    parts = value.split(".")
    return (all(0 < len(part) <= 63 for part in parts)
            and not (len(parts) == 4 and all(part.isdigit() and int(part) <= 255 for part in parts)))


def render(source, storage_fragment=None, root=ROOT):
    config = json.loads(source.read_text(encoding="utf-8"))
    patterns = {"allowedEmailDomain": HOST, "projectID": r"[a-z][a-z0-9-]{4,28}[a-z0-9]",
                "apiKey": r"[A-Za-z0-9_-]+", "authDomain": HOST,
                "firestoreDatabase": r"(?:[a-z][a-z0-9-]*|\(default\))",
                "viewerPath": r"[A-Za-z0-9_-]+"}
    client = {}
    if not valid_storage_bucket(config.get("bucket")):
        raise ValueError("invalid bucket")
    client["bucket"] = config["bucket"]
    for key, pattern in patterns.items():
        if not isinstance(config.get(key), str) or not re.fullmatch(pattern, config[key]) or len(config[key]) > 253:
            raise ValueError(f"invalid {key}")
        client[key] = config[key]
    for key in ("googleClientID", "googleDesktopClientId"):
        value = config.get(key, "")
        if not isinstance(value, str) or (value and not re.fullmatch(OAUTH, value)):
            raise ValueError(f"invalid {key}")
        client[key] = value
    for key in ("viewerBase", "webBase"):
        client[key] = url(config[key], origin=True, local=True)
    for key in ("meetingServiceURL", "deliveryServiceURL", "speechServiceURL"):
        value = config.get(key, "")
        client[key] = url(value, origin=True) if value != "" else "https://unconfigured.invalid"
    origins = config["allowedOrigins"]
    if not isinstance(origins, list) or not origins:
        raise ValueError("allowedOrigins must list explicit origins")
    origins = [url(item, origin=True, local=True) for item in origins]
    notes = url(config["notesBaseURL"], local=True)
    client["notesBaseURL"] = notes
    env = {"REEL_ORGANIZATION_DOMAIN": client["allowedEmailDomain"], "REEL_FIREBASE_PROJECT": client["projectID"],
           "REEL_MEETING_ALLOWED_DOMAIN": client["allowedEmailDomain"],
           "REEL_ALLOWED_ORIGINS": ",".join(origins), "REEL_NOTES_BASE_URL": notes}
    rules = {}
    # DNS labels contain only letters, digits and internal hyphens. Quote every dot in RE2.
    domain_pattern = client["allowedEmailDomain"].replace(".", "[.]")
    for name in ("firestore.rules", "storage.rules"):
        template = (ROOT / "firebase" / name).read_text(encoding="utf-8")
        marker = "false /* __ORGANIZATION_DOMAIN__ */"
        if template.count(marker) != 1:
            raise ValueError(f"missing domain predicate in {name}")
        predicate = r"request.auth.token.email.lower().matches('^[^@\\s<>]+@" + domain_pattern + "$')"
        rules[name] = template.replace(marker, predicate)
    fragment = storage_fragment.read_text(encoding="utf-8") if storage_fragment else ""
    rules["storage.rules"] = rules["storage.rules"].replace("// __ADDITIONAL_STORAGE_RULES__", fragment)
    cors = json.loads((ROOT / "firebase/cors.json").read_text(encoding="utf-8"))
    cors[0]["origin"] = origins
    rules["cors.json"] = json.dumps(cors, indent=2) + "\n"
    public = json.dumps(client, indent=2) + "\n"
    outputs = {name: public for name in (".reel/organization.json", "web/organization.json", "desktop-windows/organization.json")}
    outputs[".reel/backend.env"] = "".join(f"{key}={shlex.quote(value)}\n" for key, value in env.items())
    outputs.update({f".reel/firebase/{name}": data for name, data in rules.items()})
    deployment = json.loads((ROOT / "firebase.json").read_text(encoding="utf-8"))
    deployment["storage"] = [{"target": "main", "rules": ".reel/firebase/storage.rules"}]
    deployment["firestore"] = [{"database": client["firestoreDatabase"], "rules": ".reel/firebase/firestore.rules"}]
    outputs["firebase.local.json"] = json.dumps(deployment, indent=2) + "\n"
    parts = urlsplit(client["webBase"])
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    matches = [f"{parts.scheme}://{host}/{page}*" for page in ("record", "notetaker")]
    extension = ROOT / "browser-extension"
    manifest = json.loads((extension / "manifest.json").read_text(encoding="utf-8"))
    manifest["homepage_url"] = client["webBase"]
    scope = hashlib.sha256(f'{client["projectID"]}\n{client["allowedEmailDomain"]}'.encode()).hexdigest()
    manifest["version_name"] = f'{manifest["version"]} ({scope})'
    manifest["host_permissions"].extend(matches)
    manifest["content_scripts"].append({"matches": matches, "js": ["organization.js", "reel-relay.js"], "run_at": "document_idle"})
    outputs[".reel/browser-extension/manifest.json"] = json.dumps(manifest, indent=2) + "\n"
    for name in ("organization.js", "parser.js", "content.js", "background.js", "reel-relay.js"):
        outputs[f".reel/browser-extension/{name}"] = (extension / name).read_text(encoding="utf-8")
    icon = (extension / "icon128.png").read_bytes()
    for name, data in outputs.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(data, encoding="utf-8")
    package = root / ".reel/browser-extension"
    (package / "icon128.png").write_bytes(icon)
    downloads = root / "web/downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    archive = downloads / f'reel-meeting-prompt-{manifest["version"]}.zip'
    members = [Path(name).name for name in outputs if name.startswith(".reel/browser-extension/")]
    with zipfile.ZipFile(archive, "w") as bundle:
        for name in sorted([*members, "icon128.png"]):
            bundle.writestr(zipfile.ZipInfo(name), (package / name).read_bytes(), compress_type=zipfile.ZIP_DEFLATED)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?", default=ROOT / "organization.local.json")
    parser.add_argument("--storage-fragment", type=Path, help="deployment-owned rules inside the bucket match")
    parser.add_argument("--output-dir", type=Path, default=ROOT, help="output tree for a staged build or emulator test")
    args = parser.parse_args()
    try:
        render(args.source, args.storage_fragment, args.output_dir)
    except (KeyError, ValueError, OSError, TypeError) as exc:
        parser.exit(1, f"Could not configure organization: {exc}\n")
