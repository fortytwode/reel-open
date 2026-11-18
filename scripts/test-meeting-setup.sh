#!/bin/zsh
set -eu
cd "${0:A:h}/.."
# Reuse the existing Debug core; do not build the application or touch user data.
core=".build/out/Products/Debug"
[[ -d "$core/ReelCore.swiftmodule" && -f "$core/libReelCore.a" ]] || {
  print -u2 'Missing existing Debug ReelCore build in .build/out/Products/Debug'
  exit 1
}
binary="$(mktemp -t reel-meeting-setup-smoke)"
trap 'rm -f "$binary"' EXIT
swiftc -swift-version 5 -parse-as-library -target "$(uname -m)-apple-macosx15.0" \
  -I "$core" Sources/Reel/Meetings/MeetingSetupModel.swift \
  scripts/tests/MeetingSetupSmoke.swift "$core/libReelCore.a" -o "$binary"
"$binary"
