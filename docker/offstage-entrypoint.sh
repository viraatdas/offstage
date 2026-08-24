#!/bin/sh
#
# offstage-web entrypoint: bring up a virtual desktop, run the command on it,
# photograph what it drew, exit with the command's own status.
#
# Sequence:
#   1. start Xvfb on :$OFFSTAGE_DISPLAY_NUM and wait until it accepts clients
#      (polling xdpyinfo, not sleeping and hoping)
#   2. export DISPLAY and start fluxbox, so windows get mapped and focused
#   3. run "$@" in the background and wait on it, so a SIGTERM from
#      `docker stop` reaches us immediately instead of after the command ends
#   4. screenshot the root window into $OFFSTAGE_SCREENSHOT
#   5. exit with the command's status: never with the screenshot's
#
# Environment (all optional, all set by the container lane):
#   OFFSTAGE_DISPLAY_NUM  X display number, default 99
#   OFFSTAGE_SCREEN       Xvfb geometry, default 1280x900x24
#   OFFSTAGE_SCREENSHOT   where to write the end-of-run PNG; empty disables it
#   OFFSTAGE_QUIET        set to any value to suppress the banner
#   OFFSTAGE_BACKGROUND   root-window colour, default #1f2430
#
# Exit codes of our own (the command's own code always wins when it ran):
#   64  no command was given
#   70  Xvfb never came up: the lane treats this as `errored`, not `failed`

set -u

DISPLAY_NUM="${OFFSTAGE_DISPLAY_NUM:-99}"
SCREEN="${OFFSTAGE_SCREEN:-1280x900x24}"
SHOT="${OFFSTAGE_SCREENSHOT:-}"
LOGDIR="${OFFSTAGE_INTERNAL_LOGS:-/tmp/offstage}"

mkdir -p "$LOGDIR" 2>/dev/null || LOGDIR=/tmp

if [ "$#" -eq 0 ]; then
  echo "offstage-entrypoint: no command given" >&2
  exit 64
fi

XVFB_PID=""
WM_PID=""
CMD_PID=""

log() {
  [ -n "${OFFSTAGE_QUIET:-}" ] || echo "[offstage] $*"
}

# Kill a pid if it is still alive; never fail the script over it.
stop_pid() {
  [ -n "$1" ] || return 0
  kill -TERM "$1" 2>/dev/null || true
}

cleanup() {
  stop_pid "$WM_PID"
  stop_pid "$XVFB_PID"
}

# Grab the root window of the virtual display. Two independent implementations,
# because a screenshot that silently does not happen is worse than a slow one:
# ImageMagick's `import` first, then `xwd | convert`. Never fails the run.
screenshot() {
  [ -n "$SHOT" ] || return 0
  mkdir -p "$(dirname "$SHOT")" 2>/dev/null || true

  if command -v import >/dev/null 2>&1 &&
     import -display "$DISPLAY" -window root "$SHOT" >>"$LOGDIR/screenshot.log" 2>&1 &&
     [ -s "$SHOT" ]; then
    log "screenshot: $SHOT (import)"
    return 0
  fi

  if command -v xwd >/dev/null 2>&1 && command -v convert >/dev/null 2>&1 &&
     xwd -display "$DISPLAY" -root -silent >"$LOGDIR/root.xwd" 2>>"$LOGDIR/screenshot.log" &&
     convert "$LOGDIR/root.xwd" "$SHOT" >>"$LOGDIR/screenshot.log" 2>&1 &&
     [ -s "$SHOT" ]; then
    log "screenshot: $SHOT (xwd)"
    return 0
  fi

  echo "offstage-entrypoint: could not capture $SHOT" >&2
  [ -f "$LOGDIR/screenshot.log" ] && tail -n 20 "$LOGDIR/screenshot.log" >&2
  return 0
}

# docker stop / the lane's timeout path lands here. Take the picture anyway: a
# hung headed test is exactly when a human most wants to see the screen.
on_signal() {
  log "signal received; stopping the command"
  stop_pid "$CMD_PID"
  screenshot
  cleanup
  exit 143
}

Xvfb ":${DISPLAY_NUM}" -screen 0 "$SCREEN" -nolisten tcp >"$LOGDIR/xvfb.log" 2>&1 &
XVFB_PID=$!
DISPLAY=":${DISPLAY_NUM}"
export DISPLAY

# Up to 15s of 0.1s polls. Xvfb normally answers in well under a second; the
# generous ceiling is for a cold, heavily loaded VM.
tries=0
until xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if ! kill -0 "$XVFB_PID" 2>/dev/null; then
    echo "offstage-entrypoint: Xvfb exited before accepting clients on $DISPLAY" >&2
    tail -n 40 "$LOGDIR/xvfb.log" >&2 2>/dev/null || true
    exit 70
  fi
  if [ "$tries" -ge 150 ]; then
    echo "offstage-entrypoint: Xvfb did not accept clients on $DISPLAY within 15s" >&2
    tail -n 40 "$LOGDIR/xvfb.log" >&2 2>/dev/null || true
    cleanup
    exit 70
  fi
  sleep 0.1
done

fluxbox >"$LOGDIR/fluxbox.log" 2>&1 &
WM_PID=$!
# fluxbox needs a beat to own the root window; without this a screenshot taken
# by a very fast command can catch the display mid-handover.
sleep 0.4

# Paint the root window *after* the WM has claimed it: fluxbox clears the root
# on startup, so painting first would be undone. A flat, known colour makes
# screenshots comparable between runs instead of depending on X's default.
xsetroot -solid "${OFFSTAGE_BACKGROUND:-#1f2430}" 2>/dev/null || true

log "DISPLAY=$DISPLAY screen=$SCREEN wm=fluxbox artifacts=${OFFSTAGE_ARTIFACTS:-none}"
log "command: $*"

trap on_signal TERM INT

"$@" &
CMD_PID=$!
wait "$CMD_PID"
status=$?

screenshot
cleanup
exit "$status"
