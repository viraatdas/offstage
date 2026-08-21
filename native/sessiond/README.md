# `offstage-sessiond`

A single Swift binary that lives inside one macOS Aqua session — normally a
background helper account logged in via fast user switching — and lends that
session out over a unix socket. The host-side lane (`src/lanes/session/`)
connects to it to launch commands, capture the screen, and inject
keyboard/mouse events **in that session**, never on the console user's screen.

The full design and the wire protocol are in
[`docs/session-lane.md`](../../docs/session-lane.md); this file is the build,
install, and hand-test reference, plus the places where the implementation
refines the spec.

## Files

| file | job |
| --- | --- |
| `Protocol.swift` | wire types, error codes, `Conn` (framing, JSON lines, EPIPE latch) |
| `Ops.swift` | identity, `hello`, `access`, `apps`, `screenshot`, `request-permissions` |
| `Input.swift` | `input`: keycode/modifier tables, all-or-nothing validation, CGEvent posting |
| `Run.swift` | `run`: PATH resolution, `posix_spawn`, merged-pipe streaming, timeout/cancel |
| `Server.swift` | op dispatch, per-connection lifecycle |
| `main.swift` | argument parsing, socket dir/permission checks, bind, accept loop |
| `build.sh` | compile into `$1` |
| `smoke.sh` | build + run + drive every op, PASS/FAIL per check |

## Build

```bash
native/sessiond/build.sh /usr/local/libexec/offstage/offstage-sessiond
```

which is exactly:

```bash
swiftc -O -swift-version 5 \
  -o "$out" \
  native/sessiond/Protocol.swift \
  native/sessiond/Ops.swift \
  native/sessiond/Input.swift \
  native/sessiond/Run.swift \
  native/sessiond/Server.swift \
  native/sessiond/main.swift \
  -framework CoreGraphics \
  -framework AppKit \
  -framework ApplicationServices
```

No SwiftPM, no third-party dependencies — the helper account cannot read the
caller's `node` and must not need it. `-parse-as-library` is **not** used:
`main.swift` is top-level code. `-swift-version 5` is deliberate; the daemon
shares plain mutable state across a dispatch queue (one short-lived connection
each) and Swift 6 strict concurrency would demand a rewrite that buys nothing.

The build is warning-clean except for one deprecation notice on
`posix_spawn_file_actions_addchdir_np`, which is kept on purpose: the
undecorated `posix_spawn_file_actions_addchdir` does not exist on the older
SDKs this source may be compiled against.

## Invocation

```
offstage-sessiond --uid <n> [--socket-dir <dir>] [--once]
```

| exit | meaning |
| --- | --- |
| `0` | `getuid() != --uid` (belt and braces), or `--once` finished, or `--help`/`--version` |
| `64` | bad arguments |
| `70` | `socket()` / `bind()` / `listen()` / `accept()` failed |
| `78` | `--socket-dir` exists but is not a directory owned by this uid — never bind inside a directory someone else controls |

The socket is `<socket-dir>/<uid>.sock`, mode `0660`, group `staff` (gid 20).
A stale socket is unlinked first. One line per request goes to stderr.

## LaunchAgent

Installed into the **helper account's own** `~/Library/LaunchAgents/dev.offstage.sessiond.plist`
and bootstrapped with `launchctl bootstrap gui/<uid> <plist>` (root needed once,
at install; every later call is just a socket connection).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.offstage.sessiond</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/libexec/offstage/offstage-sessiond</string>
    <string>--uid</string>
    <string>502</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>/tmp/offstage-session/502.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/offstage-session/502.log</string>
</dict>
</plist>
```

`LimitLoadToSessionType: Aqua` is what keeps the daemon out of a
`Background`/`LoginWindow` context, so `CGMainDisplayID()` and `CGEventPost`
have a window server to talk to.

**Setup must create `/tmp/offstage-session` owned by the helper uid before
bootstrapping.** launchd opens `StandardOutPath` before `exec` and does not
create parent directories; without the directory the log silently goes
nowhere. `/tmp` is also cleared on reboot, so the directory has to be
re-created on each boot — the daemon itself re-creates it at startup (mode
`0755`), but the launchd log redirect for that first boot-time launch will
already have failed. Either accept the missing first log or point
`StandardOutPath` somewhere persistent.

## Hand-testing with `nc -U`

```bash
sock=/tmp/offstage-session/502.sock

printf '{"op":"hello"}\n'                                   | nc -U "$sock"
printf '{"op":"access","path":"/Users/me/code/app"}\n'       | nc -U "$sock"
printf '{"op":"apps"}\n'                                     | nc -U "$sock"
printf '{"op":"run","argv":["/bin/sh","-c","echo hi; exit 3"]}\n' | nc -U "$sock"
printf '{"op":"screenshot","maxDimension":1280}\n'           | nc -U "$sock" | tail -1 \
  | python3 -c 'import sys,json,base64;open("/tmp/shot.png","wb").write(base64.b64decode(json.load(sys.stdin)["png"]))'
```

`run` output arrives as base64 `output` events; to read it:

```bash
printf '{"op":"run","argv":["/bin/ls","-l","/"]}\n' | nc -U "$sock" \
  | python3 -c 'import sys,json,base64
for l in sys.stdin:
    o=json.loads(l)
    if o.get("event")=="output": sys.stdout.write(base64.b64decode(o["data"]).decode())
    elif "ok" in o: print(o)'
```

Use plain `nc -U` — **not** `nc -N -U`. `-N` half-closes the socket after
stdin EOF, and the daemon cannot tell a half-close from a real disconnect, so
it would treat the request as cancelled (see "Client disconnect" below).

Run `bash native/sessiond/smoke.sh` for the full automated pass. It is safe on
a console session: it never posts real input events, never sends
`request-permissions`, and only takes a screenshot when `hello` already
reports the Screen Recording grant.

## Where the implementation refines the spec

- **`input` is all-or-nothing.** The spec's example reports failure "on the
  first failing action" with a non-zero `performed`. This implementation
  parses and validates the *entire* action list before posting anything, so a
  malformed list performs **nothing** and always reports `"performed": 0`.
  Half-executing a synthetic input sequence leaves the session in a state
  nobody asked for (a mouse button down, a modifier stuck); refusing the whole
  batch is the safer contract, and the successful shape (`{"ok":true,
  "performed":N}`) is unchanged.
- **`AXIsProcessTrusted()` is checked before validation**, per spec. A daemon
  without Accessibility answers `tcc-accessibility` even for a malformed
  action list, because it could not have posted anything either way.
- **PATH lookup happens in-process.** `posix_spawnp` searches the *parent's*
  `PATH`, not the child environment's, so `argv[0]` is resolved against the
  effective `PATH` explicitly and handed to `posix_spawn` as an absolute path.
  Observable behaviour matches the spec's "PATH lookup with the effective
  environment".
- **`display.scale` comes from `CGDisplayCopyDisplayMode()`**
  (`pixelWidth / width`), not from `CGDisplayPixelsWide()`. On macOS 26.3
  `CGDisplayPixelsWide()` returns the *point* width for a Retina display
  (1728, not 3456), which would yield `scale: 1`.
- **`session.onConsole`** is read from `CGSessionCopyCurrentDictionary()` under
  the key `kCGSSessionOnConsoleKey` (double S — that is the spelling in the
  returned dictionary); the documented constant name `kCGSessionOnConsoleKey`
  is accepted as a fallback.
- **`timedOut: true` forces `exitCode: null`** even if the child happened to
  exit cleanly during the SIGTERM grace period, so a timeout is never
  mistakable for a normal exit. `signal` still names the signal that landed
  (`SIGTERM` normally, `SIGKILL` after the 5 s escalation).
- **Bounds not stated in the spec:** `input` `click.count` is capped at 5,
  `wait.ms` at 10 000 (spec), `screenshot.maxDimension` must be a positive
  integer, `run.timeoutMs` must be a positive integer.
- **`scroll`** passes `dy` straight to `wheel1` and `dx` to `wheel2` of
  `CGEvent(scrollWheelEvent2Source:units:.line,...)`, so positive `dy` is what
  a natural trackpad swipe down does.

## Behaviour the host side needs to know

- **Signal masks.** Connections are served on libdispatch worker threads,
  which run with almost every signal blocked, and both the mask and ignored
  dispositions survive `exec`. `run` therefore spawns with
  `POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF` in addition to
  `POSIX_SPAWN_SETSID`. Without them a timed-out child ignores `SIGTERM` and
  only dies to the `SIGKILL` five seconds later.
- **Client disconnect.** The daemon detects the client going away two ways: a
  failed write (EPIPE — `SIGPIPE` is ignored process-wide) and EOF on the
  client socket. Either one cancels a running `run`: `SIGTERM` to the process
  group, 5 s, `SIGKILL`, and **no final line**. Clients must keep the socket
  fully open until they have read the final line.
- **One request per connection.** The daemon reads one `\n`-terminated line
  (cap 1 MiB → `bad-request`), answers, and closes. `client.ts` should open a
  connection per call.
- **Child environment**: the daemon's own environment (it carries the Aqua
  session's window-server bootstrap) overlaid with the request's `env`, then
  `DISPLAY` removed and `HOME`/`USER`/`LOGNAME`/`TMPDIR` forced to the helper
  account's own. If the request carries no `PATH`, the daemon uses
  `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin` (launchd's
  own `PATH` is too minimal to find `npx`).
- **`access` uses `access(2)`** with the real uid, so `chmod +a` ACLs from
  `offstage session share` are honoured. For a directory, `readable` means
  `R_OK && X_OK`.
- **`screenshot` checks `CGPreflightScreenCaptureAccess()` first** and returns
  `tcc-screen-capture` without ever invoking `/usr/sbin/screencapture`, because
  invoking it without the grant can raise a TCC prompt in that session.
  Downscaling is `/usr/bin/sips --resampleHeightWidthMax N`; `width`/`height`
  are read from the returned PNG's IHDR, so they describe the *returned*
  image, and `scale` is the display's backing scale.
- **`apps`** returns only `.regular` activation-policy apps; `name` and
  `bundleId` may be `null`.
