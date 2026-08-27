#!/bin/sh
# offstage installer.
#
#   curl -fsSL https://raw.githubusercontent.com/viraatdas/offstage/main/scripts/install.sh | sh
#
# POSIX sh, safe to re-run: it upgrades the npm package in place and skips
# anything already done. No step silently swallows a failure: every branch
# that can fail prints what happened and the exact next command to run.
#
# Env vars:
#   OFFSTAGE_VERSION       npm version or dist-tag to install (default: latest)
#   OFFSTAGE_SKIP_SESSION  set to 1 to skip the "offstage session setup" prompt
#
# This script never calls sudo itself. `offstage session setup` does, and it
# prompts you for it directly when you run it (below, or later by hand).

set -u

# ---------------------------------------------------------------- output --
# Color for humans only: NO_COLOR and CI are respected, and anything that is
# not a terminal gets plain text. COLOR carries what the wordmark may use;
# the BOLD/GREEN/... variables carry the step decoration.
COLOR=none
BOLD=""
DIM=""
RED=""
GREEN=""
YELLOW=""
BLUE=""
RESET=""
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ] && [ "${CI:-}" = "" ]; then
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  BLUE=$(printf '\033[34m')
  RESET=$(printf '\033[0m')
  case "${COLORTERM:-}${TERM:-}" in
    *truecolor* | *24bit*) COLOR=truecolor ;;
    *256color*) COLOR=ansi256 ;;
  esac
fi

step() { printf '\n%s\n' "${BOLD}▸ $*${RESET}"; }
info() { printf '  %s %s\n' "${BLUE}·${RESET}" "$*"; }
ok()   { printf '  %s %s\n' "${GREEN}✓${RESET}" "$*"; }
warn() { printf '  %s %s\n' "${YELLOW}!${RESET}" "$*"; }
fail() { printf '  %s %s\n' "${RED}✗${RESET}" "$*" >&2; }
fix()  { printf '    %s\n' "$*"; }

# -------------------------------------------------------------- wordmark --
# The brand wordmark, one color per row along the brand ramp
# (violet -> fuchsia -> amber). The per-row codes are precomputed so the
# installer needs no arithmetic: truecolor rows are the ramp itself, the
# 256-color rows are the nearest xterm palette entries, and everything else
# sees plain art.
wordmark() {
  wm_1=' ████   ██████  ██████   █████  ███████   █████    █████  ███████'
  wm_2='██  ██  ██      ██      ██         ██    ██   ██  ██      ██'
  wm_3='██  ██  ████    ████     ████      ██    ███████  ██ ███  █████'
  wm_4='██  ██  ██      ██          ██     ██    ██   ██  ██  ██  ██'
  wm_5=' ████   ██      ██      █████      ██    ██   ██   █████   ███████'
  case "$COLOR" in
    truecolor)
      printf '%s\n' \
        "$(printf '\033[38;2;124;58;237m%s\033[0m' "$wm_1")" \
        "$(printf '\033[38;2;171;64;238m%s\033[0m' "$wm_2")" \
        "$(printf '\033[38;2;217;70;239m%s\033[0m' "$wm_3")" \
        "$(printf '\033[38;2;231;114;125m%s\033[0m' "$wm_4")" \
        "$(printf '\033[38;2;245;158;11m%s\033[0m' "$wm_5")"
      ;;
    ansi256)
      printf '%s\n' \
        "$(printf '\033[38;5;99m%s\033[0m' "$wm_1")" \
        "$(printf '\033[38;5;135m%s\033[0m' "$wm_2")" \
        "$(printf '\033[38;5;171m%s\033[0m' "$wm_3")" \
        "$(printf '\033[38;5;168m%s\033[0m' "$wm_4")" \
        "$(printf '\033[38;5;214m%s\033[0m' "$wm_5")"
      ;;
    *)
      printf '%s\n' "$wm_1" "$wm_2" "$wm_3" "$wm_4" "$wm_5"
      ;;
  esac
}

printf '\n'
wordmark
printf '\n  %s\n' "${DIM}keep your screen yours${RESET}"

OFFSTAGE_VERSION="${OFFSTAGE_VERSION:-latest}"

# ------------------------------------------------------------- platform --
step "1 · Platform"
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    platform=macos
    if [ "$arch" = arm64 ]; then
      ok "macOS on Apple Silicon: the supported platform. All three lanes (headless, container, session) apply."
    else
      warn "macOS on $arch. offstage currently targets the Mac on Apple Silicon (arm64):"
      warn "the headless lane is meaningful here, the others are untested on this hardware."
    fi
    ;;
  Linux)
    platform=linux
    warn "Linux detected. offstage currently targets the Mac on Apple Silicon (arm64):"
    warn "the headless and container lanes apply here; the session lane is macOS-only and skipped below."
    ;;
  *)
    platform=other
    warn "Unrecognized OS '$os': proceeding best-effort; macOS-only steps are skipped."
    ;;
esac

# ------------------------------------------------------------------ node --
step "2 · Node.js"
if ! command -v node >/dev/null 2>&1; then
  fail "node not found on PATH."
  if [ "$platform" = macos ]; then
    if command -v brew >/dev/null 2>&1; then
      fix "fix: brew install node"
    else
      fix "fix: install Homebrew (https://brew.sh), then: brew install node"
      fix "or:  install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts"
    fi
  else
    fix "fix: install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts"
    fix "or use your distro package manager for a Node.js build >= 20"
  fi
  exit 1
fi

node_version="$(node -v)"
node_major="$(printf '%s' "$node_version" | sed -e 's/^v//' -e 's/\..*$//')"
case "$node_major" in
  '' | *[!0-9]*)
    fail "could not parse a version number out of 'node -v' ($node_version)."
    fix "fix: check node -v yourself; offstage needs Node.js >= 20."
    exit 1
    ;;
esac
if [ "$node_major" -lt 20 ]; then
  fail "node $node_version found, but offstage needs >= 20."
  if [ "$platform" = macos ] && command -v brew >/dev/null 2>&1; then
    fix "fix: brew upgrade node   (or: brew install node@20 && brew link --overwrite node@20)"
  elif command -v nvm >/dev/null 2>&1; then
    fix "fix: nvm install --lts && nvm use --lts"
  else
    fix "fix: install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts && nvm use --lts"
  fi
  exit 1
fi
ok "node $node_version"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found on PATH (it normally ships with node)."
  fix "fix: reinstall node from https://nodejs.org, Homebrew, or nvm."
  exit 1
fi

# --------------------------------------------------------------- install --
step "3 · Install @viraatdas/offstage@${OFFSTAGE_VERSION}"
info "npm install -g @viraatdas/offstage@${OFFSTAGE_VERSION}"
if npm install -g "@viraatdas/offstage@${OFFSTAGE_VERSION}"; then
  ok "installed/upgraded @viraatdas/offstage@${OFFSTAGE_VERSION}"
else
  fail "npm install -g failed: see the npm output above."
  fix "a common cause is a global npm dir you cannot write to; fix by pointing"
  fix "npm at a directory you own instead of using sudo:"
  fix "  mkdir -p ~/.npm-global"
  fix "  npm config set prefix ~/.npm-global"
  fix "  export PATH=\"$HOME/.npm-global/bin:\$PATH\"   # add this to your shell profile too"
  fix "then re-run this installer."
  exit 1
fi

# ------------------------------------------------------------------ path --
step "4 · Verify offstage is on PATH"
npm_prefix="$(npm config get prefix 2>/dev/null || printf '')"
bin_dir="${npm_prefix}/bin"
OFFSTAGE_BIN=""

if command -v offstage >/dev/null 2>&1; then
  OFFSTAGE_BIN="offstage"
  ok "offstage is on PATH: $(command -v offstage)"
elif [ -n "$npm_prefix" ] && [ -x "${bin_dir}/offstage" ]; then
  OFFSTAGE_BIN="${bin_dir}/offstage"
  warn "offstage was installed at ${bin_dir}/offstage, but that directory is not on your PATH."
  fix "fix: add this to your shell profile (~/.zshrc, ~/.bashrc, ~/.profile):"
  fix "  export PATH=\"${bin_dir}:\$PATH\""
  fix "using the full path for the rest of this script."
else
  fail "offstage binary not found at ${bin_dir}/offstage after a successful npm install."
  fix "fix: run \"npm config get prefix\" and check <prefix>/bin/offstage exists;"
  fix "     if npm installs elsewhere in your setup, add that bin dir to PATH."
  exit 1
fi

# ---------------------------------------------------------------- doctor --
step "5 · offstage doctor"
if ! "$OFFSTAGE_BIN" doctor; then
  warn "doctor exited non-zero: that is unexpected (it is a report, not a gate)."
  fix "fix: re-run \"$OFFSTAGE_BIN doctor\" and read the fix line under each unavailable lane."
fi

# --------------------------------------------------------- xcode clt/mac --
if [ "$platform" = macos ]; then
  step "6 · Xcode Command Line Tools"
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode Command Line Tools installed: $(xcode-select -p)"
  else
    warn "Xcode Command Line Tools not found."
    fix "the session lane compiles a small Swift daemon (native/sessiond) that drives"
    fix "the helper-account session; that build needs swiftc, which ships with the CLT."
    fix "fix: xcode-select --install"
  fi

  # ------------------------------------------------------- session lane --
  step "7 · Session lane (helper macOS account)"
  if [ "${OFFSTAGE_SKIP_SESSION:-0}" = "1" ]; then
    info "OFFSTAGE_SKIP_SESSION=1: skipping the setup prompt."
    fix "run it later with: $OFFSTAGE_BIN session setup --create"
  elif [ ! -t 0 ]; then
    info "stdin is not a terminal (non-interactive shell): skipping the setup prompt."
    fix "run it later with: $OFFSTAGE_BIN session setup --create"
  else
    cat <<'SESSION_PITCH'
The session lane runs macOS GUI work (xcodebuild, simulators, `open -a`, ...)
inside a second account, so windows and input never reach your screen.
One command sets it up; it creates the helper account, pre-grants the two
macOS privacy permissions when your terminal has Full Disk Access, and
suppresses the new account's first-login screens:

SESSION_PITCH
    printf 'Set it up now? It needs sudo once. [y/N] '
    read -r answer
    case "$answer" in
      [yY] | [yY][eE][sS])
        info "running: $OFFSTAGE_BIN session setup --create"
        info "you will be prompted for your sudo password."
        if "$OFFSTAGE_BIN" session setup --create; then
          ok "session setup finished."
          step "One step to finish, once"
          cat <<'STEPS'
  Switch to the helper account from the user menu (top-right of the menu
  bar), and switch straight back. That first login starts the daemon;
  everything else is already done. Confirm with:
       offstage session status
STEPS
        else
          fail "session setup failed: see its own output above for the exact next command."
        fi
        ;;
      *)
        info "skipped. Run it later with: $OFFSTAGE_BIN session setup --create"
        ;;
    esac
  fi
else
  step "6 · Session lane"
  info "macOS-only: skipping (this is $os)."
fi

# --------------------------------------------------------------- agents --
step "8 · Wire it up for an agent"
cat <<'WIRING'
MCP server (Claude Code, Codex, or any MCP client):
  claude mcp add offstage -- npx -y --package=@viraatdas/offstage@latest offstage-mcp

Claude Code plugin (also registers the MCP server, no build step required):
  /plugin marketplace add viraatdas/offstage
  /plugin install offstage@offstage
WIRING

# ------------------------------------------------------------------ done --
# The welcome screen is the installer's last word: the wordmark again, the
# three lanes, and the first commands to try. Skipped when only a stub could
# run (it is cosmetic; a failure there must never fail an install).
step "Done"
if ! "$OFFSTAGE_BIN" welcome; then
  ok "offstage is installed. Try: $OFFSTAGE_BIN route -- npx playwright test --headed"
fi
