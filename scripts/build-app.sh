#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="Reel"
# One executable, two apps: Reel Recorder (screen recordings) and Reel Notetaker (meetings).
PRODUCT="${REEL_PRODUCT:-recorder}"
case "$PRODUCT" in
  recorder) BUNDLE_NAME="Reel" ;;
  notetaker) BUNDLE_NAME="Reel Notetaker" ;;
  *) echo "REEL_PRODUCT must be recorder or notetaker" >&2; exit 2 ;;
esac
DIST_DIR="${REEL_DIST_DIR:-$ROOT_DIR/dist}"
APP_PATH="$DIST_DIR/$BUNDLE_NAME.app"
INSTALL_PATH="/Applications/$BUNDLE_NAME.app"
INSTALL=false
CONFIG="${CONFIG:-release}"

usage() {
  cat <<'USAGE'
Usage: scripts/build-app.sh [--install]

Builds the Reel release executable and packages it as dist/Reel.app
(Reel Recorder) or, with REEL_PRODUCT=notetaker, dist/Reel Notetaker.app.
With --install, copies the app to /Applications after checking that an
existing installation is not running.

Environment:
  REEL_SIGN_IDENTITY  codesigning identity (default: first "Developer ID Application", then "Apple Development"
                      identity in the keychain, else ad hoc). A stable identity
                      keeps Screen Recording / Camera / Microphone grants across
                      rebuilds; ad hoc signatures change every build.
  CONFIG=debug        build the debug configuration.
  REEL_UNIVERSAL=1    build arm64 + x86_64 (scripts/release.sh sets this).
  REEL_TIMESTAMP=1    sign with Apple's secure timestamp (release.sh sets this; needs network).
  REEL_VERSION / REEL_BUILD_NUMBER
                      CFBundleShortVersionString / CFBundleVersion (default: VERSION file /
                      git commit count). Sparkle compares CFBundleVersion.
  REEL_PRODUCT       recorder (default) or notetaker. Both apps can be installed together.
  REEL_BUNDLE_ID     Reel Recorder's application identifier (default: org.reel.app).
                      Reel Notetaker uses it with ".notetaker" appended and shares
                      the Recorder's sign-in and meeting choices.
  REEL_APPCAST_URL / REEL_SPARKLE_PUBLIC_KEY
                      optional HTTPS update feed and its matching public key.
                      Automatic updates are disabled when no feed is supplied.

USAGE
}

while (($#)); do
  case "$1" in
    --install) INSTALL=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

cd "$ROOT_DIR"
ARCH_FLAGS=()
[[ "${REEL_UNIVERSAL:-0}" == "1" ]] && ARCH_FLAGS=(--arch arm64 --arch x86_64)
BUILD_FLAGS=()
[[ -n "${REEL_SWIFT_SCRATCH_PATH:-}" ]] && BUILD_FLAGS=(--scratch-path "$REEL_SWIFT_SCRATCH_PATH")
swift build ${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"} -c "$CONFIG" ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --product "$APP_NAME"
BIN_PATH="$(swift build ${BUILD_FLAGS[@]+"${BUILD_FLAGS[@]}"} -c "$CONFIG" ${ARCH_FLAGS[@]+"${ARCH_FLAGS[@]}"} --show-bin-path)"
PRODUCT_PATH="$BIN_PATH/$APP_NAME"
if [[ ! -x "$PRODUCT_PATH" ]]; then
  echo "Expected executable at $PRODUCT_PATH" >&2
  exit 1
fi

ICONSET_PATH="$DIST_DIR/AppIcon.iconset"
mkdir -p "$DIST_DIR"
if [[ -d "$APP_PATH" ]]; then
  mkdir -p "$DIST_DIR/build-backups"
  mv "$APP_PATH" "$DIST_DIR/build-backups/${BUNDLE_NAME// /-}-$(date +%Y%m%d-%H%M%S).app.disabled"
  # Keep only the five most recent backups.
  ls -1dt "$DIST_DIR"/build-backups/"${BUNDLE_NAME// /-}"-2*.app.disabled 2>/dev/null | tail -n +6 | while read -r old; do rm -rf "$old"; done
fi
mkdir -p "$APP_PATH/Contents/MacOS" "$APP_PATH/Contents/Resources"
if [[ -f "$ROOT_DIR/.reel/organization.json" ]]; then
  cp "$ROOT_DIR/.reel/organization.json" "$APP_PATH/Contents/Resources/organization.json"
fi
cp "$PRODUCT_PATH" "$APP_PATH/Contents/MacOS/$APP_NAME"
rm -rf "$ICONSET_PATH"
swift "$ROOT_DIR/scripts/make-icon.swift" "$ICONSET_PATH" "$PRODUCT"
iconutil -c icns "$ICONSET_PATH" -o "$APP_PATH/Contents/Resources/AppIcon.icns"

VERSION="${REEL_VERSION:-$(cat "$ROOT_DIR/VERSION" 2>/dev/null || echo 1.0)}"
BUILD="${REEL_BUILD_NUMBER:-$(git -C "$ROOT_DIR" rev-list --count HEAD 2>/dev/null || echo 1)}"
APPCAST_URL="${REEL_APPCAST_URL:-}"
SPARKLE_PUBLIC_KEY="${REEL_SPARKLE_PUBLIC_KEY:-}"
BUNDLE_ID="${REEL_BUNDLE_ID:-org.reel.app}"
python3 - "$APP_PATH/Contents/Info.plist" "$VERSION" "$BUILD" "$APPCAST_URL" "$SPARKLE_PUBLIC_KEY" "$BUNDLE_ID" "${REEL_SOURCE_REVISION:-$(git -C "$ROOT_DIR" rev-parse HEAD)}" "$PRODUCT" <<'PYINFO'
import plistlib
import re
import sys
from urllib.parse import urlsplit
path, version, build, feed, key, bundle, revision, product = sys.argv[1:]
if not re.fullmatch(r"[A-Za-z0-9-]+(?:[.][A-Za-z0-9-]+)+", bundle):
    raise SystemExit("Invalid REEL_BUNDLE_ID")
if feed:
    parts = urlsplit(feed)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password or not key:
        raise SystemExit("Auto-updates need an HTTPS REEL_APPCAST_URL and REEL_SPARKLE_PUBLIC_KEY")
notetaker = product == "notetaker"
name = "Reel Notetaker" if notetaker else "Reel Recorder"
info = {
    "CFBundleName": name if notetaker else "Reel", "CFBundleDisplayName": name,
    "CFBundleIdentifier": bundle + ".notetaker" if notetaker else bundle,
    # Both apps keep one sign-in and one set of meeting choices: the Recorder's.
    "ReelProduct": product, "ReelStateBundleID": bundle,
    "ReelSourceRevision": revision,
    "CFBundleExecutable": "Reel", "CFBundlePackageType": "APPL", "CFBundleVersion": build,
    "CFBundleShortVersionString": version, "LSMinimumSystemVersion": "15.0", "LSUIElement": not notetaker,
    "NSHighResolutionCapable": True, "CFBundleIconFile": "AppIcon",
    "LSApplicationCategoryType": "public.app-category.productivity",
    "NSScreenCaptureUsageDescription": "Reel records the screen or window you choose and shares it when you stop.",
    "NSCameraUsageDescription": "Reel shows your camera in a bubble and records it with your screen.",
    "NSMicrophoneUsageDescription": "Reel records your voice with your screen recordings.",
    "NSCalendarsFullAccessUsageDescription": "Choose which calendars Reel reads for meeting links. Screen recording works without calendar access.",
    "NSSpeechRecognitionUsageDescription": "Reel transcribes recordings on this Mac (older macOS versions only).",
    "CFBundleURLTypes": [{"CFBundleURLName": name, "CFBundleURLSchemes": ["reel-notetaker" if notetaker else "reel"]}],
    "SUEnableAutomaticChecks": bool(feed), "SUAllowsAutomaticUpdates": bool(feed),
    "SUScheduledCheckInterval": 86400,
}
if notetaker:
    info.update(
        NSScreenCaptureUsageDescription="Reel Notetaker records the meeting window you choose so it can write notes.",
        NSCameraUsageDescription="Reel Notetaker does not record your camera unless you turn it on.",
        NSMicrophoneUsageDescription="Reel Notetaker records your voice in meetings you choose to record.",
        NSCalendarsFullAccessUsageDescription="Choose which calendars Reel Notetaker reads for meeting links.",
        NSSpeechRecognitionUsageDescription="Reel Notetaker transcribes meetings on this Mac (older macOS versions only).",
    )
if feed:
    info.update(SUFeedURL=feed, SUPublicEDKey=key)
with open(path, "wb") as output:
    plistlib.dump(info, output)
PYINFO

# Sparkle.framework (SwiftPM binary target) goes next to the executable; Package.swift adds
# @executable_path/../Frameworks to the rpath.
if [[ ! -d "$BIN_PATH/Sparkle.framework" ]]; then
  echo "Sparkle.framework not found in $BIN_PATH" >&2
  exit 1
fi
mkdir -p "$APP_PATH/Contents/Frameworks"
ditto "$BIN_PATH/Sparkle.framework" "$APP_PATH/Contents/Frameworks/Sparkle.framework"

# Keep the same identity as installed releases. TCC retains the old code requirement
# when toggling a permission, so switching Apple Development -> Developer ID can leave
# an enabled Screen Recording entry that still denies capture. Ad hoc is a last resort.
SIGN_IDENTITY="${REEL_SIGN_IDENTITY:-$(security find-identity -v -p codesigning | awk -F'"' '/Developer ID Application/ {print $2; found=1; exit} /Apple Development/ && !development {development=$2} END {if (!found && development) print development}')}"
if [[ -z "$SIGN_IDENTITY" ]]; then
  echo "No Developer ID or Apple Development identity found; signing ad hoc. Permissions must be re-granted after each install." >&2
  SIGN_IDENTITY="-"
fi
echo "Signing with: $SIGN_IDENTITY"
if [[ "${REEL_TIMESTAMP:-0}" == "1" ]]; then TS_FLAG="--timestamp"; else TS_FLAG="--timestamp=none"; fi
# Hardened runtime requires a signing team to load bundled Sparkle. Ad hoc
# contributor builds have no Team ID and are only for local use.
SIGN_OPTIONS=()
if [[ "$SIGN_IDENTITY" != "-" ]]; then SIGN_OPTIONS=(--options runtime); fi

# Sign inside-out: Sparkle's helpers, then the framework, then the app.
sign() { codesign --force ${SIGN_OPTIONS[@]+"${SIGN_OPTIONS[@]}"} "$TS_FLAG" --sign "$SIGN_IDENTITY" "$@"; }
SPARKLE="$APP_PATH/Contents/Frameworks/Sparkle.framework/Versions/B"
for nested in "$SPARKLE/XPCServices/Installer.xpc" "$SPARKLE/XPCServices/Downloader.xpc" \
  "$SPARKLE/Autoupdate" "$SPARKLE/Updater.app"; do
  if [[ -e "$nested" ]]; then sign "$nested"; fi
done
sign "$APP_PATH/Contents/Frameworks/Sparkle.framework"
sign --entitlements "$ROOT_DIR/Resources/Reel.entitlements" "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
echo "Built $APP_PATH"

if [[ "$INSTALL" == true ]]; then
  if [[ -d "$INSTALL_PATH" ]] && pgrep -f "$INSTALL_PATH/Contents/MacOS/$APP_NAME" >/dev/null 2>&1; then
    echo "$BUNDLE_NAME is running from $INSTALL_PATH; quit it before installing." >&2
    exit 1
  fi
  if [[ -d "$INSTALL_PATH" ]]; then
    UPDATE_BACKUPS="$HOME/Library/Application Support/Reel/app-updates"
    mkdir -p "$UPDATE_BACKUPS"
    mv "$INSTALL_PATH" "$UPDATE_BACKUPS/${BUNDLE_NAME// /-}-$(date +%Y%m%d-%H%M%S).app.disabled"
  fi
  ditto "$APP_PATH" "$INSTALL_PATH"
  echo "Installed $INSTALL_PATH"
fi
