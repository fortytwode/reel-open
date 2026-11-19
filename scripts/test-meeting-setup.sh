#!/bin/zsh
set -eu
cd "${0:A:h}/.."
# Reuse the existing Debug core; do not build the application or touch user data.
core="${REEL_SWIFT_SCRATCH_PATH:-.build}/out/Products/Debug"
coreBinary="$core/libReelCore.a"
[[ -f "$coreBinary" ]] || coreBinary="$core/ReelCore.o"
[[ -d "$core/ReelCore.swiftmodule" && -f "$coreBinary" ]] || {
  print -u2 "Missing Debug ReelCore build in $core"
  exit 1
}
binary="$(mktemp -t reel-meeting-setup-smoke)"
trap 'rm -f "$binary"' EXIT
swiftc -swift-version 5 -parse-as-library -target "$(uname -m)-apple-macosx15.0" \
  -I "$core" Sources/Reel/Meetings/{CalendarDiscovery,MeetingSetupModel}.swift \
  scripts/tests/MeetingSetupSmoke.swift "$coreBinary" -o "$binary"
"$binary"
