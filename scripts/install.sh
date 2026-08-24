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
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m')
  RED=$(printf '\033[31m')
  GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m')
  BLUE=$(printf '\033[34m')
  RESET=$(printf '\033[0m')
else
  BOLD=""
  RED=""
  GREEN=""
  YELLOW=""
  BLUE=""
  RESET=""
fi

step() { printf '\n%s\n' "${BOLD}$*${RESET}"; }
info() { printf '%s\n' "${BLUE}==>${RESET} $*"; }
ok()   { printf '%s\n' "${GREEN}OK${RESET}  $*"; }
warn() { printf '%s\n' "${YELLOW}!!${RESET}  $*"; }
fail() { printf '%s\n' "${RED}XX${RESET}  $*" >&2; }

OFFSTAGE_VERSION="${OFFSTAGE_VERSION:-latest}"

# ------------------------------------------------------------- platform --
step "1. Platform"
os="$(uname -s)"
case "$os" in
  Darwin)
    platform=macos
    ok "macOS detected: all three lanes (headless, container, session) apply."
    ;;
  Linux)
    platform=linux
    warn "Linux detected: only the headless and container lanes apply here."
    warn "The session lane ('offstage session ...') is macOS-only; it is skipped below."
    ;;
  *)
    platform=other
    warn "Unrecognized OS '$os': proceeding best-effort; macOS-only steps are skipped."
    ;;
esac

# ------------------------------------------------------------------ node --
step "2. Node.js"
if ! command -v node >/dev/null 2>&1; then
  fail "node not found on PATH."
  if [ "$platform" = macos ]; then
    if command -v brew >/dev/null 2>&1; then
      printf '  fix: brew install node\n'
    else
      printf '  fix: install Homebrew (https://brew.sh), then: brew install node\n'
      printf '  or:  install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts\n'
    fi
  else
    printf '  fix: install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts\n'
    printf '  or use your distro package manager for a Node.js build >= 20\n'
  fi
  exit 1
fi

node_version="$(node -v)"
node_major="$(printf '%s' "$node_version" | sed -e 's/^v//' -e 's/\..*$//')"
case "$node_major" in
  '' | *[!0-9]*)
    fail "could not parse a version number out of 'node -v' ($node_version)."
    printf '  fix: check node -v yourself; offstage needs Node.js >= 20.\n'
    exit 1
    ;;
esac
if [ "$node_major" -lt 20 ]; then
  fail "node $node_version found, but offstage needs >= 20."
  if [ "$platform" = macos ] && command -v brew >/dev/null 2>&1; then
    printf '  fix: brew upgrade node   (or: brew install node@20 && brew link --overwrite node@20)\n'
  elif command -v nvm >/dev/null 2>&1; then
    printf '  fix: nvm install --lts && nvm use --lts\n'
  else
    printf '  fix: install nvm (https://github.com/nvm-sh/nvm), then: nvm install --lts && nvm use --lts\n'
  fi
  exit 1
fi
ok "node $node_version"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found on PATH (it normally ships with node)."
  printf '  fix: reinstall node from https://nodejs.org, Homebrew, or nvm.\n'
  exit 1
fi

# --------------------------------------------------------------- install --
step "3. Install @viraatdas/offstage@${OFFSTAGE_VERSION}"
info "npm install -g @viraatdas/offstage@${OFFSTAGE_VERSION}"
if npm install -g "@viraatdas/offstage@${OFFSTAGE_VERSION}"; then
  ok "installed/upgraded @viraatdas/offstage@${OFFSTAGE_VERSION}"
else
  fail "npm install -g failed: see the npm output above."
  printf '  a common cause is a global npm dir you cannot write to; fix by pointing\n'
  printf '  npm at a directory you own instead of using sudo:\n'
  printf '    mkdir -p ~/.npm-global\n'
  printf '    npm config set prefix ~/.npm-global\n'
  printf '    export PATH="$HOME/.npm-global/bin:$PATH"   # add this to your shell profile too\n'
  printf '  then re-run this installer.\n'
  exit 1
fi

# ------------------------------------------------------------------ path --
step "4. Verify offstage is on PATH"
npm_prefix="$(npm config get prefix 2>/dev/null || printf '')"
bin_dir="${npm_prefix}/bin"
OFFSTAGE_BIN=""

if command -v offstage >/dev/null 2>&1; then
  OFFSTAGE_BIN="offstage"
  ok "offstage is on PATH: $(command -v offstage)"
elif [ -n "$npm_prefix" ] && [ -x "${bin_dir}/offstage" ]; then
  OFFSTAGE_BIN="${bin_dir}/offstage"
  warn "offstage was installed at ${bin_dir}/offstage, but that directory is not on your PATH."
  printf '  fix: add this to your shell profile (~/.zshrc, ~/.bashrc, ~/.profile):\n'
  printf '    export PATH="%s:$PATH"\n' "$bin_dir"
  printf '  using the full path for the rest of this script.\n'
else
  fail "offstage binary not found at ${bin_dir}/offstage after a successful npm install."
  printf '  fix: run \"npm config get prefix\" and check <prefix>/bin/offstage exists;\n'
  printf '       if npm installs elsewhere in your setup, add that bin dir to PATH.\n'
  exit 1
fi

# ---------------------------------------------------------------- doctor --
step "5. offstage doctor"
if ! "$OFFSTAGE_BIN" doctor; then
  warn "doctor exited non-zero: that is unexpected (it is a report, not a gate)."
  printf '  fix: re-run \"%s doctor\" and read the fix line under each unavailable lane.\n' "$OFFSTAGE_BIN"
fi

# --------------------------------------------------------- xcode clt/mac --
if [ "$platform" = macos ]; then
  step "6. Xcode Command Line Tools"
  if xcode-select -p >/dev/null 2>&1; then
    ok "Xcode Command Line Tools installed: $(xcode-select -p)"
  else
    warn "Xcode Command Line Tools not found."
    printf '  the session lane compiles a small Swift daemon (native/sessiond) that drives\n'
    printf '  the helper-account session; that build needs swiftc, which ships with the CLT.\n'
    printf '  fix: xcode-select --install\n'
  fi

  # ------------------------------------------------------- session lane --
  step "7. Session lane (helper macOS account)"
  if [ "${OFFSTAGE_SKIP_SESSION:-0}" = "1" ]; then
    info "OFFSTAGE_SKIP_SESSION=1: skipping the setup prompt."
    printf '  run it later with: %s session setup --create\n' "$OFFSTAGE_BIN"
  elif [ ! -t 0 ]; then
    info "stdin is not a terminal (non-interactive shell): skipping the setup prompt."
    printf '  run it later with: %s session setup --create\n' "$OFFSTAGE_BIN"
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
  step "6. Session lane"
  info "macOS-only: skipping (this is $os)."
fi

# --------------------------------------------------------------- agents --
step "8. Wire it up for an agent"
cat <<'WIRING'
MCP server (Claude Code, Codex, or any MCP client):
  claude mcp add offstage -- npx -y --package=@viraatdas/offstage@latest offstage-mcp

Claude Code plugin (also registers the MCP server, no build step required):
  /plugin marketplace add viraatdas/offstage
  /plugin install offstage@offstage
WIRING

step "Done"
ok "offstage is installed. Try: $OFFSTAGE_BIN route -- npx playwright test --headed"
