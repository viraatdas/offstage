#!/bin/bash
# End-to-end smoke test for offstage-sessiond.
#
# Builds the daemon into a temp dir, runs it as the CURRENT user against a
# private socket dir, and drives every op over the unix socket. Prints
# PASS/FAIL per check and exits non-zero if anything failed.
#
# Safety: this may be run on the developer's own console session, so it never
# posts real input events (only the `input` validation path) and never sends
# `request-permissions` (which would raise TCC prompts on the visible screen).
# `screenshot` is only exercised when hello already reports the grant.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d /tmp/offstage-sessiond-smoke.XXXXXX)"
uid="$(id -u)"
bin="$tmp/offstage-sessiond"
sockdir="$tmp/sock"
log="$tmp/daemon.log"
daemon_pid=""

cleanup() {
  if [ -n "$daemon_pid" ] && kill -0 "$daemon_pid" 2>/dev/null; then
    kill "$daemon_pid" 2>/dev/null
    wait "$daemon_pid" 2>/dev/null
  fi
  chmod -R u+rwX "$tmp" 2>/dev/null
  rm -rf "$tmp"
}
trap cleanup EXIT

fails=0
say() { printf '%s\n' "$*"; }
check() {  # check <description> <shell-command...>
  if "$@" >/dev/null 2>&1; then say "PASS  $1"; else say "FAIL  $1"; fails=$((fails + 1)); fi
}

say "== build =="
if "$here/build.sh" "$bin" 2>"$tmp/build.log"; then
  say "PASS  build"
else
  say "FAIL  build"
  cat "$tmp/build.log" >&2
  exit 1
fi

mkdir -p "$sockdir"

say "== argument handling =="
# Wrong uid must exit 0 immediately without binding anything.
if "$bin" --uid 999999 --socket-dir "$sockdir" >/dev/null 2>&1; then
  say "PASS  exits 0 when getuid() != --uid"
else
  say "FAIL  exits 0 when getuid() != --uid"; fails=$((fails + 1))
fi

say "== start daemon =="
"$bin" --uid "$uid" --socket-dir "$sockdir" 2>"$log" &
daemon_pid=$!
sock="$sockdir/$uid.sock"
for _ in $(seq 1 50); do [ -S "$sock" ] && break; sleep 0.1; done
if [ -S "$sock" ]; then say "PASS  socket bound at $sock"; else say "FAIL  socket bound"; fails=$((fails + 1)); cat "$log" >&2; exit 1; fi

# A path that exists but this uid cannot read.
unreadable="$tmp/locked"
mkdir -p "$unreadable" && chmod 000 "$unreadable"

say "== protocol =="
SOCK="$sock" TMPROOT="$tmp" UNREADABLE="$unreadable" python3 - <<'PY'
import base64, json, os, socket, subprocess, sys, time

SOCK = os.environ["SOCK"]
TMPROOT = os.environ["TMPROOT"]
UNREADABLE = os.environ["UNREADABLE"]
fails = 0

def check(desc, cond, detail=""):
    global fails
    if cond:
        print("PASS  %s" % desc)
    else:
        print("FAIL  %s%s" % (desc, ("  -- " + str(detail)) if detail else ""))
        fails += 1

def call(req, half_close=False, timeout=30):
    """One request per connection: send a line, read every line, close.

    Note we never shutdown(SHUT_WR): a half-close is indistinguishable from a
    real disconnect at the daemon, and it treats that as cancellation.
    """
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(SOCK)
    s.sendall((json.dumps(req) + "\n").encode())
    buf = b""
    while True:
        chunk = s.recv(1 << 16)
        if not chunk:
            break
        buf += chunk
    s.close()
    return [json.loads(l) for l in buf.splitlines() if l.strip()]

def final(lines):
    return lines[-1] if lines else {}

def output(lines):
    return b"".join(base64.b64decode(l["data"]) for l in lines if l.get("event") == "output")

# ---- hello -----------------------------------------------------------------
h = final(call({"op": "hello"}))
check("hello ok", h.get("ok") is True, h)
check("hello daemon.protocol == 1", h.get("daemon", {}).get("protocol") == 1, h.get("daemon"))
check("hello user.uid == current uid", h.get("user", {}).get("uid") == os.getuid(), h.get("user"))
check("hello display has positive bounds and scale",
      h.get("display", {}).get("width", 0) > 0 and h.get("display", {}).get("scale", 0) >= 1,
      h.get("display"))
check("hello permissions present",
      set(h.get("permissions", {})) == {"screenCapture", "accessibility"}, h.get("permissions"))
print("INFO  display=%s session=%s permissions=%s"
      % (h.get("display"), h.get("session"), h.get("permissions")))

# ---- access ----------------------------------------------------------------
a = final(call({"op": "access", "path": TMPROOT}))
check("access readable dir", a.get("exists") and a.get("readable") and a.get("directory"), a)

a = final(call({"op": "access", "path": UNREADABLE}))
check("access unreadable dir -> readable false", a.get("exists") is True and a.get("readable") is False, a)

a = final(call({"op": "access", "path": os.path.join(TMPROOT, "no-such-thing")}))
check("access missing path -> exists false", a.get("exists") is False, a)

# ---- run: merged output, exit code ----------------------------------------
lines = call({"op": "run", "argv": ["/bin/sh", "-c", "echo out; echo err 1>&2; exit 3"]})
check("run emits a started event with a pid",
      lines and lines[0].get("event") == "started" and isinstance(lines[0].get("pid"), int),
      lines[:1])
check("run merges stdout+stderr in order", output(lines) == b"out\nerr\n", output(lines))
f = final(lines)
check("run exitCode 3", f.get("ok") is True and f.get("exitCode") == 3 and f.get("signal") is None
      and f.get("timedOut") is False and isinstance(f.get("durationMs"), int), f)

# ---- run: PATH lookup + env invariants ------------------------------------
lines = call({"op": "run", "argv": ["sh", "-c", 'printf "%s|%s|%s\\n" "$PWD" "$HOME" "$DISPLAY"'],
              "cwd": "/tmp", "env": {"DISPLAY": ":99"}})
got = output(lines).decode().strip()
check("run resolves argv[0] via PATH", final(lines).get("exitCode") == 0, final(lines))
check("run honours cwd and strips DISPLAY",
      got.startswith("/private/tmp|" + os.path.expanduser("~")) and got.endswith("|"), got)

# ---- run: timeout ----------------------------------------------------------
marker = "2718"
t0 = time.time()
f = final(call({"op": "run", "argv": ["/bin/sh", "-c", "sleep %s" % marker], "timeoutMs": 500}))
elapsed = time.time() - t0
check("run timeout reports timedOut true / exitCode null",
      f.get("ok") is True and f.get("timedOut") is True and f.get("exitCode") is None, f)
check("run timeout returns promptly (SIGTERM, not the 5s SIGKILL grace)", elapsed < 3.0, elapsed)
time.sleep(0.3)
survivors = subprocess.run(["pgrep", "-f", "sleep %s" % marker], capture_output=True).stdout.decode().split()
check("run timeout kills the whole process group", survivors == [], survivors)

# ---- run: spawn failure ----------------------------------------------------
f = final(call({"op": "run", "argv": ["offstage-no-such-binary-zzz"]}))
check("run missing binary -> spawn-failed",
      f.get("ok") is False and f.get("code") == "spawn-failed", f)

f = final(call({"op": "run", "argv": ["/bin/sh", "-c", "true"], "cwd": os.path.join(TMPROOT, "nope")}))
check("run missing cwd -> spawn-failed", f.get("code") == "spawn-failed", f)

# ---- apps ------------------------------------------------------------------
f = final(call({"op": "apps"}))
ok = f.get("ok") is True and isinstance(f.get("apps"), list)
if ok and f["apps"]:
    ok = set(f["apps"][0]) == {"pid", "name", "bundleId", "active", "hidden"}
check("apps returns regular-policy apps", ok, f.get("apps", [])[:1])
print("INFO  apps count=%d" % len(f.get("apps", [])))

# ---- input: validation only, never a real event ---------------------------
f = final(call({"op": "input", "actions": [{"type": "move", "x": 10, "y": 10}, {"type": "key", "key": "foo"}]}))
# The daemon checks AXIsProcessTrusted() before validating, so on a machine
# without the grant this legitimately answers tcc-accessibility instead.
check("input invalid action -> bad-request or tcc-accessibility, performed 0",
      f.get("ok") is False and f.get("code") in ("bad-request", "tcc-accessibility")
      and f.get("performed") == 0, f)
print("INFO  input invalid-action answered code=%s error=%s" % (f.get("code"), f.get("error")))

f = final(call({"op": "input", "actions": "not-an-array"}))
check("input non-array actions -> failure with performed 0",
      f.get("ok") is False and f.get("performed") == 0, f)

# ---- unknown op / malformed request ---------------------------------------
f = final(call({"op": "definitely-not-an-op"}))
check("unknown op -> bad-request", f.get("ok") is False and f.get("code") == "bad-request", f)

f = final(call({"nope": 1}))
check("missing op -> bad-request", f.get("code") == "bad-request", f)

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(30)
s.connect(SOCK)
s.sendall(b"this is not json\n")
buf = b""
while True:
    c = s.recv(1 << 16)
    if not c:
        break
    buf += c
s.close()
f = json.loads(buf.splitlines()[-1])
check("non-JSON request -> bad-request", f.get("code") == "bad-request", f)

# ---- oversize request ------------------------------------------------------
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(30)
s.connect(SOCK)
blob = b'{"op":"hello","pad":"' + b"x" * (2 << 20) + b'"}\n'
try:
    s.sendall(blob)
except (BrokenPipeError, ConnectionResetError):
    pass  # the daemon answers and closes before draining 2 MiB
buf = b""
try:
    while True:
        c = s.recv(1 << 16)
        if not c:
            break
        buf += c
except OSError:
    pass
s.close()
f = json.loads(buf.splitlines()[-1]) if buf.strip() else {}
check("request larger than 1 MiB -> bad-request", f.get("code") == "bad-request", f)

# ---- client disconnect mid-run cancels the child --------------------------
marker2 = "3141"
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(30)
s.connect(SOCK)
s.sendall((json.dumps({"op": "run", "argv": ["/bin/sh", "-c", "sleep %s" % marker2]}) + "\n").encode())
time.sleep(0.5)
s.close()
time.sleep(1.5)
survivors = subprocess.run(["pgrep", "-f", "sleep %s" % marker2], capture_output=True).stdout.decode().split()
check("client disconnect mid-run kills the child", survivors == [], survivors)

# ---- screenshot: only when the grant already exists ------------------------
if h.get("permissions", {}).get("screenCapture") is True:
    f = final(call({"op": "screenshot", "maxDimension": 320}))
    png = base64.b64decode(f.get("png", "")) if f.get("ok") else b""
    check("screenshot returns a PNG",
          f.get("ok") is True and png[:8] == b"\x89PNG\r\n\x1a\n", {k: v for k, v in f.items() if k != "png"})
    check("screenshot respects maxDimension",
          max(f.get("width", 0), f.get("height", 0)) == 320, (f.get("width"), f.get("height")))
else:
    print("SKIP  screenshot (hello.permissions.screenCapture is false)")

# request-permissions is deliberately NOT exercised: it raises TCC prompts.
print("SKIP  request-permissions (would raise TCC prompts on this session)")

sys.exit(1 if fails else 0)
PY
py_status=$?
[ "$py_status" -ne 0 ] && fails=$((fails + 1))

say "== --once =="
oncedir="$tmp/once"
mkdir -p "$oncedir"
"$bin" --uid "$uid" --socket-dir "$oncedir" --once 2>>"$log" &
once_pid=$!
for _ in $(seq 1 50); do [ -S "$oncedir/$uid.sock" ] && break; sleep 0.1; done
once_out="$(printf '{"op":"hello"}\n' | nc -U "$oncedir/$uid.sock" 2>/dev/null | tail -1)"
if printf '%s' "$once_out" | grep -q '"ok":true'; then
  say "PASS  --once answers hello over nc -U"
else
  say "FAIL  --once answers hello over nc -U  -- $once_out"; fails=$((fails + 1))
fi
for _ in $(seq 1 50); do kill -0 "$once_pid" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$once_pid" 2>/dev/null; then
  say "FAIL  --once exits after one connection"; fails=$((fails + 1)); kill "$once_pid" 2>/dev/null
else
  say "PASS  --once exits after one connection"
fi

say "== shutdown =="
kill "$daemon_pid" 2>/dev/null
wait "$daemon_pid" 2>/dev/null
if kill -0 "$daemon_pid" 2>/dev/null; then say "FAIL  daemon stopped"; fails=$((fails + 1)); else say "PASS  daemon stopped"; fi
daemon_pid=""

say "== daemon log =="
sed 's/^/      /' "$log"

if [ "$fails" -ne 0 ]; then
  say ""
  say "SMOKE FAILED ($fails failing check group(s))"
  exit 1
fi
say ""
say "SMOKE PASSED"
