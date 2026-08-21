#!/bin/bash
# Compile offstage-sessiond into $1.
#
#   native/sessiond/build.sh /usr/local/libexec/offstage/offstage-sessiond
#
# Needs swiftc from the Xcode Command Line Tools. No SwiftPM, no third-party
# dependencies: the helper account must be able to run this binary with
# nothing else installed.
set -euo pipefail

out="${1:-}"
if [ -z "$out" ]; then
  echo "usage: build.sh <output-binary-path>" >&2
  exit 64
fi

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$(dirname "$out")"

# -swift-version 5: the daemon shares plain mutable state across a dispatch
# queue on purpose (one short-lived connection each). Swift 6 strict
# concurrency would demand a rewrite that buys nothing here.
#
# No -parse-as-library: main.swift is top-level code.
exec swiftc \
  -O \
  -swift-version 5 \
  -o "$out" \
  "$dir"/Protocol.swift \
  "$dir"/Ops.swift \
  "$dir"/Input.swift \
  "$dir"/Run.swift \
  "$dir"/Server.swift \
  "$dir"/main.swift \
  -framework CoreGraphics \
  -framework AppKit \
  -framework ApplicationServices
