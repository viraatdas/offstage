#!/bin/sh
# offstage uninstaller — reverses what install.sh and `offstage session setup`
# did.
#
#   sh scripts/uninstall.sh              # dry run: prints every command, runs nothing
#   sh scripts/uninstall.sh --yes        # runs the daemon teardown for real (still asks about npm)
#   sh scripts/uninstall.sh --yes --remove-npm-package   # also removes the npm package, no prompt
#
# What this never does: delete the helper macOS account. It only prints the
# `sysadminctl -deleteUser` command — see the README for why the account
# is left for you to remove by hand.
#
# POSIX sh, safe to re-run.

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

# --------------------------------------------------------------- options --
YES=0
REMOVE_NPM=0
HELPER_USER="${OFFSTAGE_SESSION_USER:-computeruse}"

while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) YES=1 ;;
    --remove-npm-package) REMOVE_NPM=1 ;;
    --user)
      shift
      HELPER_USER="${1:-}"
      ;;
    --user=*) HELPER_USER="${1#--user=}" ;;
    --help | -h)
      cat <<'USAGE'
Usage: uninstall.sh [--yes] [--remove-npm-package] [--user NAME]

  (no args)               dry run: print every command, run nothing
  --yes                   actually bootout the daemon and remove its files
  --remove-npm-package    also run "npm rm -g @viraatdas/offstage" without asking
  --user NAME             helper account name, if not the default "computeruse"
USAGE
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      exit 64
      ;;
  esac
  shift
done

os="$(uname -s)"
case "$os" in
  Darwin) platform=macos ;;
  *) platform=other ;;
esac

# ------------------------------------------------------- session daemon --
step "1. Session lane daemon"
if [ "$platform" != macos ]; then
  info "not macOS — nothing session-lane related was installed here."
else
  # `offstage session setup` installs the LaunchAgent into the HELPER account's
  # own ~/Library/LaunchAgents and bootstraps it into that account's GUI
  # domain (gui/<helper uid>), never the caller's. Mirror that exactly.
  helper_user="${OFFSTAGE_SESSION_USER:-computeruse}"
  helper_uid="$(id -u "$helper_user" 2>/dev/null || true)"
  helper_home="$(dscl . -read "/Users/$helper_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
  if [ -z "$helper_uid" ]; then
    warn "helper account '$helper_user' does not exist — nothing to boot out."
    helper_uid="<uid>"
    helper_home="/Users/$helper_user"
  fi
  gui_target="gui/${helper_uid}/dev.offstage.sessiond"
  plist_path="${helper_home}/Library/LaunchAgents/dev.offstage.sessiond.plist"
  libexec_dir="/usr/local/libexec/offstage"

  boot_cmd="sudo launchctl bootout ${gui_target}"
  rm_plist_cmd="sudo rm -f ${plist_path}"
  rm_libexec_cmd="sudo rm -rf ${libexec_dir}"

  info "this script only ever calls sudo when you pass --yes; each sudo prompt is separate."
  printf '  %s\n' "$boot_cmd"
  printf '  %s\n' "$rm_plist_cmd"
  printf '  %s\n' "$rm_libexec_cmd"

  if [ "$YES" = 1 ]; then
    step "Running the daemon teardown"
    if eval "$boot_cmd"; then
      ok "daemon booted out of ${gui_target}"
    else
      warn "launchctl bootout failed or nothing was loaded there — check with:"
      printf '    launchctl print %s\n' "$gui_target"
    fi
    if eval "$rm_plist_cmd"; then
      ok "removed ${plist_path}"
    else
      warn "could not remove ${plist_path} (already gone, or permission denied)."
    fi
    if eval "$rm_libexec_cmd"; then
      ok "removed ${libexec_dir}"
    else
      warn "could not remove ${libexec_dir} (already gone, or permission denied)."
    fi
  else
    info "dry run — nothing above was executed. Re-run with --yes to run it for real."
  fi
fi

# ------------------------------------------------------------- npm package --
step "2. npm package"
npm_rm_cmd="npm rm -g @viraatdas/offstage"
if [ "$REMOVE_NPM" = 1 ]; then
  info "running: $npm_rm_cmd"
  if npm rm -g @viraatdas/offstage; then
    ok "removed @viraatdas/offstage"
  else
    warn "npm rm -g failed or it was not installed globally under this npm prefix."
  fi
elif [ "$YES" = 1 ] && [ -t 0 ]; then
  printf 'Also remove the npm package (%s)? [y/N] ' "$npm_rm_cmd"
  read -r answer
  case "$answer" in
    [yY] | [yY][eE][sS])
      if npm rm -g @viraatdas/offstage; then
        ok "removed @viraatdas/offstage"
      else
        warn "npm rm -g failed or it was not installed globally under this npm prefix."
      fi
      ;;
    *)
      info "left in place. Remove later with: $npm_rm_cmd"
      ;;
  esac
else
  info "left in place. Remove with: $npm_rm_cmd"
  info "or re-run this script with --remove-npm-package to skip this prompt."
fi

# ------------------------------------------------------------ helper user --
step "3. Helper macOS account"
warn "this script never deletes the helper account — do that yourself, deliberately, once"
warn "you have confirmed nothing else still uses it:"
printf '    sudo sysadminctl -deleteUser %s\n' "$HELPER_USER"
printf '  (add -keepHome if you want to keep its home directory around first)\n'

step "Done"
if [ "$YES" = 1 ]; then
  ok "uninstall steps ran. Confirm with: launchctl print gui/$(id -u)/dev.offstage.sessiond ; offstage doctor"
else
  ok "dry run complete — nothing was changed. Re-run with --yes to apply it."
fi
