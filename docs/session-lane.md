# The session lane — a second macOS account as the off-screen display

## What it is

macOS has no Xvfb and cannot have one (see [macos-sessions.md](macos-sessions.md)).
What it does have is **multiple simultaneous GUI sessions**: with fast user
switching, a second local account can be logged in and sitting in the
background with its own window server connection, its own framebuffer, its own
keyboard/mouse event stream, and its own running apps. Nothing that happens in
that session reaches the console user's screen or focus.

The session lane uses exactly that. A helper account (default: `computeruse`,
uid 502 on the machine this was built on) is logged in once and left in the
background. offstage installs a small daemon, **`offstage-sessiond`**, into that
account's session as a LaunchAgent. The daemon listens on a unix socket; the
host-side lane (running as you) connects to it to launch commands, capture the
session's screen, and inject keyboard/mouse events — all inside the other
session, never yours.

```text
  your session (console, uid 501)          computeruse session (background, uid 502)
  ───────────────────────────────          ─────────────────────────────────────────
  offstage run --lane session -- open -a Safari
      │                                      launchd (gui/502)
      │  unix socket                           └─ offstage-sessiond   ← LaunchAgent
      └──────────────────────────────────────────►  │
         /tmp/offstage-session/502.sock             ├─ spawns: open -a Safari   (its windows render
                                                    │                            to 502's framebuffer)
                                                    ├─ screencapture -x         (502's screen, not yours)
                                                    └─ CGEventPost              (502's HID stream, not yours)
```

Verified facts this design rests on (macOS 26.3, Apple silicon):

- `IOConsoleUsers` lists both sessions; the background one has
  `kCGSSessionOnConsoleKey: false` and `kCGSessionLoginDoneKey: true`. It is a
  full logged-in Aqua session, not a login window.
- A backgrounded session keeps a live framebuffer, keeps running GUI apps, and
  accepts injected input (measured on a backgrounded uid 501 session, see
  `macos-sessions.md`).
- `launchctl asuser <uid>` reaches that session's GUI launchd domain, but needs
  root on every call. That is why the daemon exists: root is needed **once**,
  at install, to bootstrap the LaunchAgent; every later call is a socket
  connection as an ordinary user.

## What it is not

It is **session isolation, not machine isolation**. Same OS, same kernel, same
disk. Use it to keep windows, focus, and input off your screen. Do not use it
to test an installer that might damage the system — that is what the `vm` lane
and its 27–69 GB Tart image are for. The router encodes this: `.dmg`, `.pkg`,
`installer`, and `hdiutil` still route to `vm`; everything else macOS-native
routes to `session`.

TCC is per session and per binary. Screen capture and event injection by the
daemon require **Screen Recording** and **Accessibility** to be granted to
`offstage-sessiond` *inside the helper account's session*. Apple offers no way
to grant those from another account or from the command line; the one-time
setup asks you to switch to the helper account once, approve two prompts, and
switch back. `offstage session status` reports both grants, and the lane
reports `errored` with the exact fix when one is missing. Nothing falls back to
your screen.

## Filesystem reality

The helper account is a different uid. Your home directory is `0750`, so
`computeruse` cannot read `~/code/myrepo` — and therefore cannot run
`npx playwright test` in it — until you grant read access to that one tree:

```bash
offstage session share ~/code/myrepo     # read-only ACL for the helper account on that tree
```

`share` adds macOS ACL entries (`chmod +a`): *traverse-only* (`search`) on each
ancestor directory so the path is reachable, and *read* on the tree itself.
It never grants write. Everything a run writes goes to `$OFFSTAGE_ARTIFACTS`,
which is the run's own `.offstage/runs/<id>` directory; the lane grants the
helper account write access to that directory — and only that directory — per
run, because the lane's user owns it. The repository stays read-only to the
helper account, exactly like the container lane's read-only mount.

The lane checks readability through the daemon (`access` op) before running and
returns `errored` with the `share` command when it is missing.

## The daemon: `offstage-sessiond`

One Swift binary, no runtime dependencies (the helper account cannot read your
`node`, and must not depend on it). Source lives in `native/sessiond/`, is
shipped in the npm package, and is compiled by `offstage session setup` with
`swiftc` from the Xcode Command Line Tools.

### Invocation

```
offstage-sessiond --uid <n> [--socket-dir <dir>] [--once]
```

- Exits `0` immediately if `getuid() != uid`. The LaunchAgent is installed in
  the helper account's own `~/Library/LaunchAgents`, so this is belt and braces.
- Creates `<socket-dir>` (default `/tmp/offstage-session`) with mode `0755` if
  absent. If it exists and is not owned by the daemon's uid, exits `78`
  (`EX_CONFIG`) with a message — never binds inside a directory someone else
  controls.
- Binds `<socket-dir>/<uid>.sock`, unlinking a stale socket first, and sets
  mode `0660` with group `staff` (gid 20). Anyone in `staff` on this machine can
  drive the session; that is the trust model of a single-user laptop and is
  stated here on purpose.
- Logs one line per request to stderr. The LaunchAgent redirects it to
  `<helper home>/Library/Logs/offstage-sessiond.log` — persistent and owned by
  the helper account. (Not `/tmp`: launchd does not create parent directories
  for its log redirect, and `/tmp` is cleared on reboot.)
- `--once` serves a single connection and exits; used by tests.

### Wire protocol

JSON Lines over the socket. **One request per connection.** The client sends
exactly one JSON object terminated by `\n`. The daemon answers with zero or
more *event* lines, then exactly one *final* line, then closes. The client may
close early; the daemon treats that as cancellation.

Every final line has `"ok": true` or `"ok": false`. A failure final line is
`{"ok": false, "error": "<human sentence>", "code": "<kebab-code>", "fix": "<optional command>"}`.
Codes: `bad-request`, `spawn-failed`, `tcc-screen-capture`,
`tcc-accessibility`, `not-found`, `internal`.

Unknown `op` → `bad-request`. Any request larger than 1 MiB → `bad-request`.

#### `hello`

```json
{"op":"hello"}
```
→
```json
{"ok":true,"op":"hello",
 "daemon":{"version":"1","pid":4242,"protocol":1},
 "user":{"uid":502,"name":"computeruse","home":"/Users/computeruse"},
 "session":{"onConsole":false,"managerName":"Aqua"},
 "display":{"width":1728,"height":1117,"scale":2},
 "permissions":{"screenCapture":true,"accessibility":false}}
```

`display` is the main display's bounds in **points** and its backing scale.
`permissions` come from `CGPreflightScreenCaptureAccess()` and
`AXIsProcessTrusted()` — read-only, no prompt. `session.onConsole` comes from
`CGSessionCopyCurrentDictionary()[kCGSessionOnConsoleKey]`.

#### `access`

```json
{"op":"access","path":"/Users/viraat/code/app"}
```
→
```json
{"ok":true,"exists":true,"readable":false,"writable":false,"directory":true}
```
Uses `access(2)` with `R_OK` / `W_OK` (plus `X_OK` for directories), so it
answers for the daemon's real uid including ACLs.

#### `run`

```json
{"op":"run","argv":["npx","playwright","test","--headed"],"cwd":"/Users/viraat/code/app",
 "env":{"OFFSTAGE_ARTIFACTS":"/Users/viraat/code/app/.offstage/runs/x","CI":"1"},
 "timeoutMs":600000}
```
Events, in order, as output arrives (stdout and stderr **merged**, sharing one
pipe so ordering is preserved):
```json
{"event":"started","pid":5120}
{"event":"output","data":"<base64 bytes>"}
```
Final:
```json
{"ok":true,"exitCode":1,"signal":null,"timedOut":false,"durationMs":8421}
```

Rules:
- Environment = the daemon's own environment (that is what carries the Aqua
  session's window-server bootstrap) **overlaid** with `env` from the request,
  then: `DISPLAY` is always removed; `HOME`, `USER`, `LOGNAME`, `TMPDIR` are
  always the helper account's own, never the caller's. If the request has no
  `PATH`, the daemon uses
  `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`.
- `argv[0]` is resolved through that `PATH` (spawn via `/usr/bin/env`, or
  resolve and `posix_spawn` directly — implementer's choice; the observable
  behaviour is "PATH lookup with the effective environment").
- The child runs in its **own process group / session** (`POSIX_SPAWN_SETSID`).
  On timeout, the daemon sends `SIGTERM` to the group, waits 5 s, then
  `SIGKILL`, and reports `timedOut: true, exitCode: null`. On client disconnect
  mid-run, the same kill sequence, no final line (nobody is listening).
- `exitCode` is `null` when the child died by signal; `signal` then names it
  (`"SIGKILL"`).
- A spawn failure (missing binary, unreadable `cwd`) is a final
  `{"ok":false,"code":"spawn-failed","error":...}` with the OS error text, and
  `fix` set to the `offstage session share <cwd>` command when the cause is
  `EACCES` on `cwd`.

#### `screenshot`

```json
{"op":"screenshot","maxDimension":1280}
```
→
```json
{"ok":true,"png":"<base64>","width":1728,"height":1117,"scale":2}
```
Implemented with `/usr/sbin/screencapture -x -t png <tmp>` inside the daemon's
session (so it captures **that** session's framebuffer), then optionally
downscaled with `sips --resampleHeightWidthMax <maxDimension>` for agents with
small image budgets. `width`/`height` are the *returned* image's pixel size. If
`CGPreflightScreenCaptureAccess()` is false, or the capture produces no file,
the final line is `{"ok":false,"code":"tcc-screen-capture", ...}` with the fix
text: "switch to the <user> account once and allow Screen Recording for
offstage-sessiond in System Settings → Privacy & Security".

#### `input`

```json
{"op":"input","actions":[
  {"type":"move","x":640,"y":400},
  {"type":"click","x":640,"y":400,"button":"left","count":1,"modifiers":["cmd"]},
  {"type":"drag","fromX":100,"fromY":100,"toX":300,"toY":300},
  {"type":"scroll","x":640,"y":400,"dx":0,"dy":-5},
  {"type":"type","text":"hello world"},
  {"type":"key","key":"cmd+shift+t"},
  {"type":"wait","ms":250}
]}
```
→ `{"ok":true,"performed":7}`, or on the first failing action
`{"ok":false,"code":"bad-request","error":"action 3: unknown key 'foo'","performed":3}`.

- Coordinates are **points** in global display space, origin top-left of the
  main display — the same space `hello.display` and the screenshot (divided by
  `scale`) describe.
- Events are posted with `CGEvent.post(tap: .cghidEventTap)` from inside the
  session, so they enter the helper session's HID stream only.
- Before the first action the daemon checks `AXIsProcessTrusted()`; false →
  `{"ok":false,"code":"tcc-accessibility","performed":0, ...}` with the fix
  text for Accessibility.
- `click` defaults: `button: "left"`, `count: 1`, `modifiers: []`. Buttons:
  `left | right | middle`. A click is move → down → up (repeated `count` times
  with the click-count field set, so double-clicks register).
- `type` posts Unicode key events (`keyboardSetUnicodeString`) in chunks of at
  most 20 UTF-16 units, 2 ms apart, so long strings are not dropped.
- `key` is `[modifier+]*name`. Modifiers: `cmd`, `ctrl`, `alt` (alias `opt`,
  `option`), `shift`, `fn`. Names: single characters `a`–`z`, `0`–`9`,
  punctuation on a US layout; `enter`/`return`, `tab`, `esc`/`escape`, `space`,
  `backspace`/`delete`, `forwarddelete`, `up`, `down`, `left`, `right`,
  `home`, `end`, `pageup`, `pagedown`, `f1`–`f12`. Unknown name → `bad-request`.
- `scroll` uses `CGEvent(scrollWheelEvent2Source:units:.line, ...)`, `dy` positive = scroll down content (natural), matching what a trackpad swipe down does.
- `wait` sleeps; max 10 000 ms per action.

#### `apps`

`{"op":"apps"}` → `{"ok":true,"apps":[{"pid":5120,"name":"Safari","bundleId":"com.apple.Safari","active":true,"hidden":false}]}`
from `NSWorkspace.shared.runningApplications`, regular-activation-policy apps only.

#### `request-permissions`

`{"op":"request-permissions"}` → same shape as `hello.permissions`, after calling
`CGRequestScreenCaptureAccess()` and `AXIsProcessTrustedWithOptions(prompt: true)`.
The prompts appear **in the helper session**, where the user sees them on their
next switch. Idempotent.

## Host side: `src/session/`

| file | job |
| --- | --- |
| `discover.ts` | Which account, which uid, does it have a GUI session, is it on console, is the socket there. Parses `ioreg -n Root -d1 -a` (plist) → `IOConsoleUsers`; `dscl . -read /Users/<name> UniqueID NFSHomeDirectory`. Pure functions over captured text, plus one thin exec seam, so it is unit-tested against recorded output. |
| `client.ts` | Typed RPC over the socket: `hello()`, `access()`, `run()` with an `onOutput` callback, `screenshot()`, `input()`, `apps()`, `requestPermissions()`. Connection per call, as the protocol says. Zod-validates every final line. |
| `setup.ts` | Generates the LaunchAgent plist and the root install script; drives `swiftc`; applies `share` ACLs. Nothing here shells out without an injected exec, so it is testable. |
| `index.ts` | Re-exports + `SESSION_DEFAULTS` (`user: 'computeruse'`, `socketDir: '/tmp/offstage-session'`, `label: 'dev.offstage.sessiond'`, `installDir: '/usr/local/libexec/offstage'`). |

Configuration precedence: `OFFSTAGE_SESSION_USER` env → `~/.config/offstage/session.json` `{ "user": "..." }` → default `computeruse`.

## The lane: `src/lanes/session/index.ts`

Implements `LaneRunner` with `lane: 'session'`.

`isAvailable()` — in order, stopping at the first failure and returning its `reason` + `fix`:

1. `process.platform === 'darwin'` — else "the session lane is macOS-only".
2. The helper account exists — else fix: `offstage session setup --create`.
3. It has a GUI session with `LoginDone` — else fix: "log `<user>` in once with fast user switching (user menu → `<Full Name>`), then switch back; the session keeps running in the background".
4. It is **not** on console — else reason: "the helper session is currently the one on your screen; switch back to your own account". (Running there would put windows on the visible display.)
5. The socket answers `hello` — else fix: `offstage session setup`.
6. `hello.permissions.screenCapture && accessibility` — **not** required for availability (a run that never captures can still work), but reported in `detail` with the fix; `screenshot`/`input` ops enforce their own.

`run(req)`:

1. `isAvailable()`; if not → `skippedResult`.
2. `access(req.cwd)` readable — else `errored` with `fix: offstage session share <cwd>`.
3. `chmod +a "<user> allow read,write,append,delete,add_file,add_subdirectory,search,readattr,writeattr,readextattr,writeextattr,file_inherit,directory_inherit" <artifactsDir>` — the lane owns that directory. Failure → `errored`.
4. `run` op with `env = req.env minus DISPLAY, plus OFFSTAGE_ARTIFACTS=<artifactsDir>, OFFSTAGE_LANE=session`. Stream output to `<artifactsDir>/command.log` (reuse `LogSink`/`CappedText` semantics from the headless lane, or the same caps: 4 MB captured, 8 MB buffered).
5. Afterwards, best-effort `screenshot` → `<artifactsDir>/screen.png`, artifact kind `screenshot`. A TCC failure becomes one diagnostic line, not an error.
6. `status = statusFromExitCode`, `failures = parseFailures(output, { cwd })` from the headless parser on `failed`, diagnostics: which account and session id ran it, whether the screenshot was taken, and the standing reminder that this is session isolation, not a VM.

`run()` never throws; the daemon being unreachable mid-run is `errored`.

## Router policy

`LANES = ['headless', 'session', 'container', 'vm']`. Precedence when signals
disagree: `vm` > `session` > `container` > `headless`.

- Every macOS-native signal that previously argued `vm` now argues `session`:
  `xcodebuild`, `xcrun`, `xcrun simctl`, `uitest-scheme`, `xcode-target`,
  `app-binary`, `open-app`, `open-other`, `safaridriver`, `osascript`,
  `instruments`. Clauses say: "…runs in the session lane — a second, logged-in
  macOS account whose display and input are its own — so the window never
  reaches your desktop. Pass `--lane vm` for a disposable machine."
- Signals that imply **changing the machine** keep arguing `vm`: `dmg-path`,
  `hdiutil`, and new `pkg-path` (`*.pkg`) and `installer` (`bin === 'installer'`).
- `vm` + `session` together → `vm` wins (clean state beats cheap), with a note.
- `session` + `container` together (e.g. `open -a Safari` plus `--headed`) → `session` wins; note says a macOS app cannot run in a Linux container.
- The refusal rule is unchanged: the only refused override is `--lane headless` on
  work routed away from headless. `--lane session`, `--lane container`,
  `--lane vm` are all screen-safe and always honoured; the diagnostic says when
  the router would have chosen differently.

## CLI and MCP surface

```
offstage session status            # account, session, socket, permissions, display — and the fix for each gap
offstage session setup [--user U] [--create]   # compile daemon, sudo-install LaunchAgent, bootstrap, request permissions
offstage session share <dir>       # read-only ACL for the helper account on a tree
offstage session screenshot [--out file.png] [--max 1280]
offstage session input '<json actions>'        # or: offstage session click X Y / type "text" / key "cmd+q"
offstage session apps
offstage session open <app-or-path> [-- args]  # sugar for: offstage run --lane session -- open ...
offstage run --lane session -- <cmd>           # the lane, explicitly
```

Every subcommand takes `--json` with the usual stdout/stderr split. `status`
exits 0 when the lane is available, 69 otherwise, so scripts can gate on it.

MCP tools (all via `src/cli/api.ts`, same as everything else):
`offstage_session_status`, `offstage_session_screenshot` (returns an image
content block plus JSON), `offstage_session_input` (`actions` array as above),
`offstage_session_apps`. `offstage_run` with `lane: "session"` already covers
launching. The skill tells agents: *screenshot → decide → input → screenshot*,
coordinates in points, and never to drive the user's own session.

`setup` needs `sudo` for exactly four things — copying the binary into
`/usr/local/libexec/offstage/`, writing the plist into the helper account's
`~/Library/LaunchAgents/` (creating that directory and `~/Library/Logs` if the
account has never finished a first login), pre-creating the socket directory
`/tmp/offstage-session` owned by the helper account, and
`launchctl bootstrap gui/<uid>`. It prints the
script before running it, runs it with `sudo` attached to the terminal, and is
refused over MCP (no terminal to type a password into) with the message "run
`offstage session setup` in a terminal".

## Verification ladder

Recorded in [verified.md](verified.md) as it is climbed:

1. daemon compiles; `--once` round-trips every op against a test client on the
   developer's own session (no injection performed there — `input` is only
   exercised for argument validation and the Accessibility check).
2. LaunchAgent bootstrapped into the helper session; `hello` reports
   `onConsole: false`; `run` of `open -a TextEdit` starts TextEdit under the
   helper uid while the console screen shows nothing.
3. Screen Recording granted → `screenshot` returns a PNG of a desktop that is
   not the console's.
4. Accessibility granted → `input` types into TextEdit and the next screenshot
   shows the text.
5. `offstage run --lane session -- npx playwright test --headed` against a
   shared repo: Chromium window in the helper session, `failures[]` parsed,
   console untouched.
