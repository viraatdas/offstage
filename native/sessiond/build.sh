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
swiftc \
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

# Code-sign with a STABLE identity. TCC (Screen Recording, Accessibility) keys
# a permission grant to the binary's code identity, so the choice here decides
# whether a grant the user gives survives the next build.
#
#   Developer ID  — the grant is keyed to the Designated Requirement, which is
#                   the signing identifier plus the team. Rebuilding changes the
#                   cdhash but NOT the DR, so the grant SURVIVES. This is the
#                   only way the lane stays working across development.
#   ad-hoc ("-")  — the DR degenerates to the bare cdhash, so every rebuild
#                   silently drops Screen Recording and Accessibility and the
#                   lane goes dead until the user re-grants by hand.
#
# So a Developer ID identity is used when one is available, and ad-hoc is the
# fallback for machines that have none (CI, a contributor's laptop). Set
# OFFSTAGE_CODESIGN_IDENTITY to choose explicitly; set it to "-" to force ad-hoc.
identity="${OFFSTAGE_CODESIGN_IDENTITY:-}"
if [ -z "$identity" ]; then
  # First Developer ID Application identity in the keychain, if any.
  identity="$(security find-identity -v -p codesigning 2>/dev/null \
    | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
fi
if [ -z "$identity" ]; then
  identity="-"
  echo "codesign: no Developer ID found — signing ad-hoc." >&2
  echo "          TCC grants will reset on the next rebuild." >&2
fi

codesign --force --sign "$identity" --identifier dev.offstage.sessiond "$out"

# Report the Designated Requirement: this string, not the file, is what a TCC
# grant is actually attached to. If it changes between builds, grants reset.
echo "codesign: signed with ${identity}"
codesign --display --requirements - "$out" 2>&1 | sed -n 's/^designated => /codesign: DR = /p'
