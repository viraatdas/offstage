# offstage

[![CI](https://github.com/viraatdas/offstage/actions/workflows/ci.yml/badge.svg)](https://github.com/viraatdas/offstage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@viraatdas/offstage)](https://www.npmjs.com/package/@viraatdas/offstage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Give your coding agent its own invisible Mac desktop.**

Agents can do real GUI work now: `xcodebuild test` against a real scheme,
booting an iOS simulator, launching your built `.app` and clicking through it,
watching a headed Chromium reproduce a layout bug. Left alone, every one of
those seizes your display and your keyboard.

offstage goes in front of every one of them. It reads the command, works out
what isolation that command actually needs, and runs it there.

```bash
npm i -g @viraatdas/offstage

offstage doctor                        # which lanes work on this machine
offstage route -- npx playwright test  # where would this go? (nothing runs)
offstage run   -- npx playwright test  # send it there, get one normalized result
```

## What it decides

A command goes in. A place to run it comes out.

```
                          your command
                                │
                                ▼
  ┌───────────────────────────────────────────────────────────┐
  │ router                                                    │
  │ reads argv and a few config files                         │
  │ executes nothing, ever                                    │
  └─────────────────────────────┬─────────────────────────────┘
  ┌───────────────────┬─────────┴─────────┬───────────────────┐
  ▼                   ▼                   ▼                   ▼
  REFUSED             SESSION             CONTAINER           HEADLESS
  nothing runs        a second macOS      a Linux box with    runs right where
  anywhere            account, logged in  an Xvfb virtual     you already are
                      in the background   display

  installer           xcodebuild          --headed            npm test
  .pkg / .dmg         xcrun simctl        headless: false     vitest
  hdiutil             open -a             WebGL / GPU flags   plain puppeteer
                      osascript
```

Three places to run something, and one refusal. That is the whole product.
Your screen is never touched by any of the three, and a refused command does
not run anywhere at all.

The session lane is the interesting one: a full macOS GUI session your agent
drives, screenshotting what it sees, clicking, typing, reading the app list,
while you keep working in your own session. Works standalone and as an agent
tool for **Claude Code**, **Codex**, and **opencode**.

## The three lanes

**`headless` runs the command right where you are, and that is the point.**
`npx playwright test` and a plain `puppeteer.launch()` already open no window
and steal no focus. Wrapping them in a container buys nothing and costs
container startup every run. Most commands land here.

**`container` is a Linux container with an Xvfb virtual display.** For web work
that genuinely needs a head: `--headed`, `headless: false` in a config, WebGL
and GPU flags, Chrome extension loading, `cypress open`. A real display, just
not yours.

**`session` is a second macOS account, logged in and sitting in the
background.** `xcodebuild` and `xcrun simctl` and XCUITests cannot run in a
Linux container; they need a real macOS window server. But they do not need a
fresh machine, only a display that is not yours. macOS already has one of those:
another account with its own window server, its own framebuffer, and its own
keyboard and mouse stream.

```
                one Mac, two live GUI sessions, at the same time

 ┌─ your session, on the console ─────┐  ┌─ helper session, in the background ┐
 │ your apps and windows              │  │ offstage-sessiond                  │
 │ your keyboard and mouse            │  │ the app under test                 │
 │ your screen                        │  │ its own window server              │
 │                                    │  │ its own framebuffer                │
 │ the offstage CLI                   ───▶ its own input stream               │
 └────────────────────────────────────┘  └────────────────────────────────────┘
                                        ▲
                                        │
              one unix socket, owned by the helper account, at
                       /tmp/offstage-session/<uid>.sock
```

There is no Xvfb for macOS and there cannot be one. Its window server is not a
wire protocol you can reimplement, there is no `$DISPLAY` to redirect, and
screen capture is gated per session by the OS. What macOS does have is several
GUI sessions at once via fast user switching, which is what the session lane
uses. [Under the hood](#under-the-hood-the-macos-work) has the four reasons in
full, how the framebuffer is read, and why input cannot reach your screen.

Two rules across all three. Asking for **more** isolation than the router chose
always works (`--lane container`); asking for less is refused. And if a lane's
substrate is missing, the run stops and tells you how to fix it. offstage never
quietly falls back to your real screen.

## Driving a real app

GestureEngine is a real macOS utility, a trackpad-gesture engine whose app is an
`LSUIElement` menu-bar tool. Exactly the kind of thing an agent wants to test,
and exactly the kind of thing that used to seize your screen. The whole loop
runs from one terminal while you keep working:

```console
$ offstage run -- swift test -c release            # passed | headless | in place
$ offstage run -- ./Scripts/build-app.sh           # passed | headless | in place
$ offstage session launch --fresh build/GestureEngine.app
  ✓ launched "build/GestureEngine.app" in the helper session: registered after 1.2s
    GestureEngine pid 13836 [dev.viraat.GestureEngine]
$ offstage session screenshot --max 1000           # its window, on the hidden desktop
$ offstage session input '[{"type":"click","x":1178,"y":157}]'
$ offstage session screenshot                      # toggle flipped: Listening → Paused
```

Nothing appeared on screen at any point. Every screenshot in that sequence is
the *other* account's desktop.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/viraatdas/offstage/main/scripts/install.sh | sh
```

Installs Node.js guidance if missing, installs `@viraatdas/offstage` globally,
checks your PATH, runs `offstage doctor`, and on macOS offers the session-lane
setup below. By hand: `npm i -g @viraatdas/offstage && offstage doctor`. From a
clone: `npm ci && npm link`.

The headless and container lanes work immediately. The session lane needs one
setup, once, and it is the next section.

## Setting up the session lane

The session lane drives a second, ordinary macOS account (default
`computeruse`) logged in **in the background**: its own window server, its own
framebuffer, its own keyboard and mouse stream. A small Swift daemon,
`offstage-sessiond`, runs inside that account and listens on a unix socket at
`/tmp/offstage-session/<uid>.sock`. Your session talks to it over that socket.
The wire protocol is in
[`native/sessiond/README.md`](native/sessiond/README.md).

```bash
sudo offstage session setup --create
```

One command does everything macOS allows:

1. **Creates the helper account** non-interactively, with a generated
   24-character password (shown once, stored mode `0600` at
   `~/.config/offstage/session.json`). An empty password could never log in
   under FileVault, so a real one is generated instead.
2. **Compiles the Swift daemon** from `native/sessiond/` (`swiftc`, shipped
   with the Xcode Command Line Tools).
3. **Suppresses the first-login Setup Assistant** (`.skipbuddy` plus the
   "already seen" keys), because nobody should click through region, Apple ID
   and Siri panes for an account driven by a robot.
4. **Pre-grants both TCC permissions** (Screen Recording and Accessibility) by
   writing rows shaped exactly like System Settings' own into
   `/Library/Application Support/com.apple.TCC/TCC.db`, carrying the daemon's
   code requirement. This needs **Full Disk Access** on the terminal running
   setup, since SIP otherwise blocks even root from opening that database.
   Without it the script prints why and falls back to manual toggles. It probes
   before writing and never fails the install over this.
5. **Installs the binary** into the helper account's own home
   (`~/.offstage/bin/offstage-sessiond`), **bootstraps the LaunchAgent** into
   its GUI domain, and shows the fast-user-switching menu so what remains is
   one click.

The whole root script is printed before it runs. You are about to type a
password, and "trust me" is not an acceptable thing for a tool to say.

**What is left for you:** switch to the helper account from the user menu once,
then switch straight back. That first login starts a daemon that is already
trusted. Confirm with `offstage session status`, which exits 0 when the lane is
ready.

If either permission still shows ungranted, your terminal lacked Full Disk
Access during setup. Grant it and re-run setup, or switch into the helper
account once and approve both toggles for `offstage-sessiond` in
System Settings → Privacy & Security.

### Zero-touch reboots with `--auto-login`

After a reboot the helper session is gone until someone logs it in once.
`--auto-login` arms macOS auto-login (`sysadminctl`) for the helper account, so
every boot brings it up by itself and you log into your own account as usual.
Two honest trade-offs: FileVault refuses auto-login outright (setup reports
that rather than pretending), and the helper desktop appears briefly at boot.
The daemon refuses input while its session is the console one, so nothing can
type on your screen through it either way.

### Why the daemon can update itself

The binary lives where the account that runs it owns it, so
`offstage session update` is a file copy the daemon performs on itself over its
own socket. No password, no admin prompt behind your back. A swapped binary
would not inherit the TCC grants either: the record carries a code requirement,
and a replacement that fails it gets nothing.

### Filesystem access is separate from TCC

The helper account is a different uid and your home is `0750`, so grant read
access one tree at a time:

```bash
offstage session share ~/code/myrepo    # read-only ACL, traverse-only on ancestors
offstage session unshare ~/code/myrepo  # revoke exactly what share granted
```

Share never grants write. A run writes to its own `.offstage/runs/<id>`
artifacts directory, which the lane opens per run, including anything the
command leaves there such as an `.xcresult` bundle or a video.

### Input never touches your screen

Input is posted with `CGEvent.post(tap: .cgSessionEventTap)`, the per-session
entry point. The window server routes it to that session's key window and
nowhere else. The global HID tap always routes to the console session, which is
your screen, and is unreachable here by construction. The daemon refuses input
entirely (`on-console`) if its own session is somehow the one on screen, failing
closed, and (`no-target`) when nothing there has focus.

### Installing your own app into the helper account

The refused row is about *distributable artifacts*: `.dmg` mounts, `.pkg`
installers, anything whose job is rewriting the machine both accounts share.
Your own app under development is different. It is just another GUI process,
and it runs on the second account straight from your build directory
(`session launch build/App.app`), exactly as GestureEngine does above.

To "install" it into the helper account anyway, skip the installer and copy the
bundle into that account's own Applications folder. No sudo, no refusal:

```bash
offstage run --lane session -- sh -c 'mkdir -p /Users/computeruse/Applications && cp -R build/GestureEngine.app /Users/computeruse/Applications/'
offstage session launch --fresh /Users/computeruse/Applications/GestureEngine.app
```

Three notes from doing this for real:

- Use the helper account's absolute home path (`/Users/computeruse/...`).
  Inside the session lane `$HOME` is an unresolved shell expansion to the
  router, and relative paths resolve against the helper's home, not yours.
- Kill old instances before relaunching (`offstage session quit MyApp`), which
  waits until the app has actually left the session's app list. LaunchServices
  gets confused by several copies of one bundle id registering at once.
- A freshly copied bundle can take tens of seconds to register while macOS
  verifies the new file. Pass `--wait-ms 60000` instead of retrying.

## Commands

```bash
offstage doctor                                  # per-lane availability + fixes
offstage route  -- <cmd> [--headed] [--cwd dir]  # which lane, why, executes nothing
offstage run    -- <cmd> [--lane L] [--timeout ms] [--headed] [--cwd dir]
offstage probe  <path>                           # signing verdict for a macOS app target

offstage session status                          # account/session/socket/daemon/grants; exit 69 if not ready
offstage session setup [flags]                   # the one-command install (above)
offstage session share <dir> / unshare <dir>     # grant/revoke read-only tree access
offstage session screenshot [--out f] [--max px] # capture the HELPER session's display
offstage session input '<json actions>'          # or: click X Y / type "text" / key "cmd+q"
offstage session launch <app> [--fresh] [--wait-ms ms]  # open an app and WAIT until it registers; reports its pid
offstage session quit <app> [--force] [--wait-ms ms]    # quit an app in the helper session and WAIT until it is gone
offstage session open <target> [args...]         # sugar for: run --lane session -- open …
offstage session apps                            # apps running in the helper session
offstage session update                          # rebuild + swap the daemon, no password
```

Every command takes `--json`. The JSON envelope goes to stdout and human lines
go to stderr, so `offstage run --json -- npm test | jq .status` works. Exit
codes: `run` exits 0 for passed, the command's own non-zero code for failed
(or 1 if it had none), 70 for errored, 69 for skipped. `status` exits 0 or 69 so
scripts can gate on it. Bad invocations exit 64.

Coordinates for `click` and `input` are **points**, not pixels. Divide a pixel
coordinate by the screenshot's reported scale.

## For agents

Working *on* this repository? Read [`AGENTS.md`](AGENTS.md) first.

offstage is first a tool *for* agents. The same operations are MCP tools over
stdio, so Claude Code, Codex and opencode can all call them.

- **Claude Code plugin**: `/plugin marketplace add viraatdas/offstage` then
  `/plugin install offstage@offstage`. Ships the skill and the MCP server, no
  build step.
- **Claude Code CLI**: `claude mcp add offstage -- npx -y --package=@viraatdas/offstage@latest offstage-mcp`
- **Codex** (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.offstage]
  command = "npx"
  args = ["-y", "--package=@viraatdas/offstage@latest", "offstage-mcp"]
  ```

- **opencode** (`opencode.json`, project or `~/.config/opencode/`):

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "offstage": {
        "type": "local",
        "command": ["npx", "-y", "--package=@viraatdas/offstage@latest", "offstage-mcp"]
      }
    }
  }
  ```

Tools: `offstage_doctor`, `offstage_route`, `offstage_run`, `offstage_probe`,
plus `offstage_session_status`, `offstage_session_launch`,
`offstage_session_screenshot`, `offstage_session_input`,
`offstage_session_apps`, `offstage_session_quit`. There is deliberately no
setup tool over MCP: setup runs `sudo` and needs a human at a terminal.

An agent's loop for GUI work: **launch** (waits until the app registers),
screenshot, decide, input, screenshot. Points not pixels, and never drive the
console session.

The rule that keeps it honest, worth pasting into any project's AGENTS.md:

```markdown
Before running anything that could open a window or steal focus: Playwright/
Puppeteer/Cypress/WebDriver, --headed, screen/video capture, xcodebuild,
xcrun simctl, open/-a, osascript, launching a built .app: use the offstage
MCP tools. status:'skipped' means the substrate is missing: report the fix,
never re-run the command directly to get past it, and never launch apps or run
GUI commands outside offstage: that puts them on the user's screen.
```

## How the router picks a lane

It never runs the command. Deciding is argv inspection plus a few small
read-only file probes, which is why it is cheap enough to do on every
invocation.

The router does not match a command onto a lane directly. It collects
**signals**, individual quotable observations like `argv: --headed` or
`playwright.config.ts: headless: false`, and then weighs them. That is what
lets it explain itself: the lane comes from the strongest signal, and every
other observation is still there to print.

```
  npx playwright test --headed
             │
             ▼
  ┌────────────────────────┐   argv tokens, package.json scripts,
  │ collect signals        │   playwright / vitest / wdio configs,
  └───────────┬────────────┘   local scripts the command names
              │
              ▼
   argv: --headed                    argues container, and it is
                                     literal argv, not a guess
   playwright is headless by         argues headless, but only as
   default                           a tool default
              │
              ▼
  ┌────────────────────────┐   session > container > headless
  │ weigh them             │   a refusal beats all three
  └───────────┬────────────┘   literal argv beats an inferred default
              │
              ▼
   lane:    container
   reason:  written by the signal that won
   signals: every observation, still printed
```

That is exactly what the CLI hands back:

```console
$ offstage route -- npx playwright test --headed
command:    npx playwright test --headed
lane:       container
confidence: high
reason:     The command asks for a headed browser, which means a real window
            and stolen focus if it runs here; the container lane opens that
            window against an Xvfb virtual display instead.
signals:
  - argv: --headed
```

Three things worth knowing about how it weighs them:

**Precedence is `session` > `container` > `headless`, and a refusal beats all
three.** A spare macOS display beats a Linux one, either beats your screen, and
nothing beats not running a machine-changing command at all.

**It reads files but never evaluates them.** A config that computes `headless`
from an env var is invisible by construction, because a router that evaluated
your config to find out whether it opens a window could open a window while
deciding. So it keeps the cheap lane, drops to `confidence: low`, and names the
expression it could not evaluate instead of reporting the tool's default as
though it had read yours.

**Recording video is not a head.** `--video=on` looks like it needs a screen and
does not: Playwright pulls frames out of the browser over CDP and muxes them
with its own ffmpeg, so a headless run writes the same `.webm`. Only capture of
a *desktop or another window* needs a display.

### What the refusal actually checks

A command that would change the machine itself gets no lane. Session isolation
shares your OS and disk with you, so it cannot honestly contain that, and
offstage has no lane that can. The refusal applies on every lane and no flag
overrides it.

Two triggers, independent. Either one on its own refuses.

**The program.** offstage resolves `argv[0]` to a real file the way the lane
would execute it, then asks what that file is. Four ways in, and the signal
tells you which one caught it:

| What you type | How it is identified | The signal you get |
| --- | --- | --- |
| `installer` | the literal name | `argv: installer` |
| `deploy-tool`, a symlink sitting on `PATH` | `PATH` walk, then `realpath` | `argv: deploy-tool (resolves to installer)` |
| `./setup-helper`, a symlink to `/usr/sbin/installer` | `realpath` | `argv: setup-helper (resolves to installer)` |
| `./nice-name`, `cp`ed from `/usr/sbin/installer` | SHA-256 of the bytes | `argv: nice-name (identical copy of installer)` |

The first three rows apply to every tool the router knows, not just the refused
ones. A symlink named `run-thing` pointing at `/usr/bin/osascript` routes to the
session lane and says `argv: run-thing (resolves to osascript)`.

The fourth row is narrower on purpose. Hashing is scoped to `installer` and
`hdiutil`, the two tools where being wrong is unrecoverable. It exists because a
copy keeps no link back to its origin: `realpath` points at the copy itself and
the basename is whatever the copier chose, so only the content is honest. Size
is compared first, so nothing is hashed unless it is already exactly as long as
one of those two, and anything over 8 MiB is never read at all.

Start to finish:

```
  argv[0]
     │
     ├─ contains a "/" ──▶ realpath it ───────────────┐
     │                                                │
     └─ a bare name ─────▶ walk PATH: first           │
                           executable regular file    │
                           wins, 64 dirs max,         │
                           stat only, no subprocess   │
                                                      ▼
                              ┌─────────────────────────────────────┐
                              │ is that file installer or hdiutil,  │
                              │ by name?                            │
                              └──────────┬───────────────┬──────────┘
                                     yes │               │ no
                                         ▼               ▼
                                    REFUSED      exactly the same size
                                                 as one of them?
                                                     │        │ no
                                                 yes │        └──▶ routed
                                                     ▼             like any
                                                 SHA-256 of        other
                                                 the bytes         command
                                                 matches it?
                                                     │        │ no
                                                 yes │        └──▶ routed
                                                     ▼             normally
                                                 REFUSED
```

The `PATH` walk is `stat` only. No `which`, no shell, no subprocess: first
executable regular file in `PATH` order wins, bounded to 64 directories, which
is the file `execa` would go on to run.

**The arguments.** A token naming a `.pkg` or a `.dmg` refuses on its own,
whatever the program is, because the payload is the dangerous part. `echo
Foo.pkg` is refused, deliberately.

```console
$ ln -s /usr/sbin/installer ./setup-helper
$ offstage route -- ./setup-helper -pkg Foo.pkg -target /
command:    ./setup-helper -pkg Foo.pkg -target /
lane:       REFUSED (no lane can isolate this)
confidence: high
reason:     setup-helper (resolves to installer): a symlink, a rename, or a
            byte-identical copy does not change what this binary does. It
            applies a macOS installer package to a target volume, which is a
            deliberate change to the machine it runs on. The session lane is
            only a second account on your own OS and disk, and offstage has no
            lane that isolates that, so it refuses to run this rather than
            risk your machine. Run it directly yourself if you accept the
            risk.
signals:
  - argv: no browser, GPU or macOS-native signal found
  - argv: setup-helper (resolves to installer)
  - argv: Foo.pkg

offstage will refuse to run this automatically, on any lane. See reason above.
```

A shell's `-c` and an interpreter's `-c`/`-e` are read as text, so
`sh -c "installer -pkg Foo.pkg -target /"` is refused on what is inside the
string.

### What the refusal does not catch

All three were run against the real binaries, not assumed:

- **A script file.** `sh deploy.sh`, where `deploy.sh` runs the installer, is
  not refused. Neither is `./deploy.sh`. Deciding would mean interpreting the
  script, and no static classifier does that reliably. Makefiles, npm scripts
  and compiled binaries are opaque for the same reason.
- **A modified copy.** Append one byte to a copy of `installer` and the digest
  stops matching, so the program check misses it. `./tweaked -pkg Foo.pkg` is
  still refused, but by the `.pkg` argument rather than by the program, and
  `./tweaked --help` is not refused at all.
- **A copy of a GUI tool.** Content matching covers the two refused tools only,
  so `cp /usr/bin/osascript ./copied-osa` then `./copied-osa -e '…'` is not
  recognized as `osascript` and routes headless, which means in place. The
  symlink and rename cases *are* caught.

So the refusal is a guard against *naming* these tools, not a sandbox, and it is
not where the safety comes from. The lanes are, and none of them claims to
contain a change to the machine itself. That is exactly why this is a refusal
instead of a fourth lane.

## Under the hood: the macOS work

The session lane rests on a few OS behaviours that are worth stating exactly,
partly so you can check them, partly because most of them cost real
investigation to find. Everything measured below was measured on **macOS 26.3
(build 25D125), Apple silicon**.

### There is no Xvfb for macOS, and there cannot be

Xvfb works because X11 is a documented wire protocol over a socket: anyone may
implement a server, any client may connect to any server, and `$DISPLAY` names
which one. macOS has none of those four properties.

1. **No protocol.** The window server is `SkyLight.framework`, whose export
   surface is **2,388 symbols** (`_SLSAddTrackingRegion`,
   `_SLSAccessWindowBackingStore`, and so on). AppKit calls those in-process and
   they marshal over a Mach port. Undocumented, and unstable across releases.
2. **No `$DISPLAY`.** A process finds the window server through the Mach
   bootstrap namespace of its launchd session, not an address. `launchctl
   managername` returns `Aqua` in a GUI session; a `Background` session cannot
   obtain a window server connection at all, which is the familiar "not
   connected to a window server" failure. The lookup is namespace-based, so
   there is nothing to redirect.
3. **Nothing to replace.** SkyLight is not a file on disk; it lives in the dyld
   shared cache. SIP, library validation and the hardened runtime block
   injecting into signed system processes, so there is no `LD_PRELOAD` seam.
4. **TCC is session-keyed regardless.** Screen capture and event injection are
   gated per session, enforced outside the calling process.

So what macOS offers is a headless *session*, not a headless *server*: a real
window server rendering to a framebuffer nobody is watching. That is what a CI
Mac with no monitor is, and it is what the second account gives you.

### The framebuffer, and reading it

A background Aqua session has a real window server with a real backing store.
Apps render into it normally, they just render where no display is attached.
Reading it is ordinary screen capture, done from inside that session:

- The daemon calls
  [`CGPreflightScreenCaptureAccess()`](<https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()>)
  first, because invoking the capture tool without the grant triggers the system
  prompt inside a session nobody is looking at, where it can never be answered.
- Capture itself is `/usr/sbin/screencapture -x -t png`, and `-x` suppresses the
  shutter sound. Downscaling, when you pass `--max`, is
  `/usr/bin/sips --resampleHeightWidthMax`.
- Geometry comes from
  [`CGDisplayBounds`](<https://developer.apple.com/documentation/coregraphics/cgdisplaybounds(_:)>)
  for points and
  [`CGDisplayCopyDisplayMode`](<https://developer.apple.com/documentation/coregraphics/cgdisplaycopydisplaymode(_:)>)
  for the backing scale, as `pixelWidth / width`.

**A trap worth naming.** On macOS 26 `CGDisplayPixelsWide()` returns the *point*
width for a Retina display, 1728 rather than 3456, so it cannot be used to
derive the scale factor. The display
mode's `pixelWidth / width` is the ratio that is actually backing-store
accurate. This is why `session screenshot` reports `scale` separately, and why
input coordinates are points: divide a pixel coordinate from the image by
`scale` before clicking with it.

### Why input lands there and only there

Core Graphics lets you post a synthetic event at one of several taps, described
in
[`CGEventTapLocation`](https://developer.apple.com/documentation/coregraphics/cgeventtaplocation).
Two of them matter here, and the difference is the entire safety argument:

- `.cghidEventTap` is the HID-level tap. Events posted there enter the machine
  as though the hardware produced them, which means they land on **the console
  session**: your screen. offstage never uses it.
- `.cgSessionEventTap` is the per-session tap. An event posted from a process
  inside session N enters session N's own stream, and the window server routes
  it to that session's key window.

So the daemon posts with
[`CGEvent.post(tap: .cgSessionEventTap)`](<https://developer.apple.com/documentation/coregraphics/cgevent/post(tap:)>),
from inside the helper session, and there is no code path that posts anywhere
else. Belt and braces on top of that: before injecting anything it asks
[`CGSessionCopyCurrentDictionary()`](<https://developer.apple.com/documentation/coregraphics/cgsessioncopycurrentdictionary()>)
for `kCGSSessionOnConsoleKey`, and refuses outright if its own session turns out
to be the one on screen. That check fails closed.

### The Screen Sharing route, and why it was not taken

Before the second-account approach, the obvious idea was Apple's own virtual
display. `screensharingd` really does build one per connection, and its symbols
name all three pieces: a virtual framebuffer (`VirtualFrameBuffer()`,
`SSAgentInfo_VirtualFrameBuffer`), a login session (`create login window session
if necessary`), and synthetic input routed into it
(`VirtualDisplayHIDFilter.c`, `VirtualDisplayHIDFilterStart`). The count is
tracked and capped by `RFBMaxVirtualDisplays`.

Which one you get is the client's choice, and `ScreenSharing.framework` exports
four selectors for it:

```
kSSSessionSelect_ConnectToConsole            = "ConnectToConsole"
kSSSessionSelect_RequestConsole              = "RequestConsole"
kSSSessionSelect_ConnectToVirtualDisplay     = "ConnectToVirtualDisplay"
kSSSessionSelect_DontConnectToVirtualDisplay = "DontConnectToVirtualDisplay"
```

Those strings do not appear in `screensharingd` itself, so they are client-side
state and the wire encoding of the choice is separate and still unidentified.

Getting there means authenticating. On 127.0.0.1:5900 the daemon announces
`RFB 003.889` and offers security types **30, 33, 36, 35**:

- **Type 30 is legacy Apple/ARD auth**: Diffie-Hellman (generator 2, 1024-bit
  modulus supplied by the server), the shared secret MD5'd into an AES-128 key,
  and a 128-byte credential block encrypted ECB. This was implemented and
  **verified working** against a real daemon, then deleted, because working is
  exactly the problem. Type 30 predates the session selectors, so the server has
  nothing to read and falls back to *switching the console* to the
  authenticating user. Measured directly: `/dev/console` ownership changed, a
  second `loginwindow` appeared, the session persisted after disconnect, and the
  framebuffer came back as `3456x2234`, the physical display. It takes the
  screen it is supposed to protect.
- **Types 33, 35 and 36 are SASL SRP**, and the local account record names the
  parameters outright: `SRP-RFC5054-4096-SHA512-PBKDF2`. That is the 4096-bit
  group from [RFC 5054](https://www.rfc-editor.org/rfc/rfc5054), SHA-512, with
  the password stretched through PBKDF2. For these the client speaks first, and
  sweeping the sub-type byte (0 to 255 under type 33, 0 to 63 under 35 and 36)
  produced exactly one value that ever answers: 30, the one that takes the
  console. No SRP handshake byte was ever obtained.

Reaching a virtual display therefore needs both an SRP implementation and the
unknown encoding of `ConnectToVirtualDisplay`, both private and both free to
change in any macOS release, to save one click after a reboot. Meanwhile the
cheaper question turned out to answer itself: **a non-console session is fully
drivable as-is.** Screenshot, click, keyboard, drag and scroll all work in a
background Aqua session, and a headed Chromium ran a Playwright spec to
completion in one while the console user kept working. No protocol archaeology
required.

The full write-up, including the options that were priced and rejected, is in
[`docs/macos-sessions.md`](docs/macos-sessions.md).

### Corroboration from an unexpected direction

OpenAI's Codex Computer Use ships a macOS agent that does *not* isolate
anything. It links ScreenCaptureKit and drives the accessibility tree in the
**user's own session**, and its UI string is literally "Codex is Using Your
Mac". The `CGSSession*` symbols it references are queries about the session it
is already in, and it ships a lock-screen guardian plus a login authorization
plugin precisely because it needs the real session alive. A well-resourced team
building exactly this did not find a headless path either.

### What the app list taught us

Two findings from driving a real app, both of which changed the daemon:

- **`LSUIElement` apps are invisible to a naive app list.** A menu-bar tool
  declares
  [`LSUIElement`](https://developer.apple.com/documentation/bundleresources/information-property-list/lsuielement)
  and therefore gets the `accessory` case of
  [`NSApplication.ActivationPolicy`](https://developer.apple.com/documentation/appkit/nsapplication/activationpolicy-swift.enum)
  rather than `regular`. A list that reports only regular apps makes every
  launch of such a tool look like a failure. An agent that saw "launched but not
  running" relaunched six times, then abandoned isolation and opened the app on
  the user's screen. `session apps` now reports accessory apps too, each entry
  carrying its `policy`, and `session launch` waits for real registration rather
  than trusting `open`'s exit code.
- **`NSWorkspace` lies from a daemon.** The first fix polled `NSWorkspace`,
  which in a launchd-daemon context served frozen snapshots: Calculator
  frontmost, the menu bar reading "Calculator", and the list insisting neither
  existed. The daemon reads Launch Services directly (`lsappinfo`) instead,
  which is always current.

## What comes back

Every lane returns the same envelope (`src/contract/index.ts`). `status` is one
of four values, and the difference between them is what an agent should do
next:

| `status` | What happened | What to do |
| --- | --- | --- |
| `passed` | ran, exit 0 | nothing |
| `failed` | ran, and was red | read `failures[]` or `command.log`, fix the code. Retrying wastes time |
| `errored` | the run itself cannot be trusted: spawn failure, timeout, dead substrate | retry |
| `skipped` | the substrate was missing, so nothing ran anywhere | apply the fix in `diagnostics` |

`failures[]` is populated for **Playwright, Vitest and Jest only**. Everything
else comes back with an empty list, a full `command.log`, and a diagnostic
saying nothing was recognized. Abstention beats fabrication.

Each run persists a validated `result.json` under `.offstage/runs/<id>/`.

## Probe: is ad-hoc signing enough?

`offstage probe MyApp.xcodeproj` answers one question before you promise anyone
a macOS test setup:

- **`adhoc-ok`**: every entitlement the app requests is satisfied by ad-hoc
  signing, so `codesign -s -` is enough and no Apple credentials are needed
  anywhere.
- **`needs-signing-lane`**: the app declares restricted entitlements (protected
  resources, virtualization, hypervisor) that only a provisioning-profile-backed
  Developer ID carries. Getting that identity to the signing step is a much
  larger project.

This is a fact about the app's entitlements, so the answer holds however you run
the tests. offstage does not sign anything and has no signing lane. The probe is
here so nobody commits to a date before knowing which of the two jobs they
signed up for.

Read `confidence` before repeating a verdict. `low` means "found no blocker",
not "proved there is none".

## Status: what has actually been verified

Tests pass on machines without the substrates present (they skip loudly, not
fail), so "suite green" does not mean "lane works". What has been run for real:

| Lane | Live evidence |
| --- | --- |
| `headless` | real child processes, real timeouts, real log backpressure |
| `container` | a genuinely headed Chromium inside the container while the host's visible-app set stayed byte-identical before and after |
| `session` | all five verification rungs inside the real `computeruse` session: screenshots of the hidden desktop; clicks landing on intended Calculator buttons (`75`); typed strings, drag and scroll confirmed by before/after screenshots; a headed Chromium completing a Playwright spec while the console user kept typing into their own apps. Delivery checked against the window server's own log: every synthetic event landed in the helper session, zero reached the console. |

Setup-specific evidence (measured 2026-08-21, macOS 26.3): the system TCC db
holds both services path-keyed; root-with-Full-Disk-Access can write it (probed
with a non-mutating `BEGIN IMMEDIATE; ROLLBACK`); the daemon's exported
requirement matches stored grant blobs **byte-for-byte**; `sysadminctl
-autologin` exists and FileVault refuses it on this machine; CGSession-based
switching is gone on 26.3, so the one human switch remains honest. Not yet done:
executing the full sudo script on a fresh machine end to end.

`doctor` also measures the kernel's pipe buffers, because a degraded kernel
passes every lane probe and still cannot run the work the lanes are for. On
2026-08-24 a machine under heavy multi-agent load handed out 512- and
1024-byte pipes to every new process, which deadlocks Xcode's toolchain probe:
local `xcodebuild` builds printed their banner and hung forever, on every
lane, with no error. The probe measured exactly 512 there and 16384 on healthy
machines; the warning names the condition and the one observed fix (a reboot).
Freeing memory, clearing caches, `purge`, and quitting apps were all measured
and none moved the capacity by a byte.

Two findings from driving a real app changed the daemon itself, and they are
written up under [What the app list taught us](#what-the-app-list-taught-us).

## Development

```bash
npm ci                          # Node 20+
npm run build                   # tsc -> dist/
npm test                        # vitest; skips gated on absent substrates
npm run typecheck
bash native/sessiond/smoke.sh   # builds and drives the session daemon locally
```

Conventions that matter, with the full rules in [`AGENTS.md`](AGENTS.md): ESM
and NodeNext (`import type`, `.js` extensions); vitest globals off; code
touching the outside world takes the impure part as an injected seam; every
module boundary lives in `src/contract/index.ts`; `isAvailable()` never throws,
`run()` never throws, and neither ever falls back to the user's real screen. No
file goes over 1,000 lines. Tests live in `tests/`, where `*.fixtures.ts` is
shared setup that is typechecked but never collected, and `tests/fixtures/**` is
sample code the lanes execute, excluded from both.

```
src/contract/     lane + result contract, run-directory helpers
src/router/       classify(command) -> lane + reason
  signal.ts         what one observation is
  views.ts          expand a command into everything worth inspecting
  flags.ts          read one argv token, whole tokens only
  bins.ts           the binaries the router recognizes, by name
  signals.ts        collect the evidence, and read the argv itself
  macos.ts          macOS GUI work, and the refusals
  tools.ts          Playwright / Vitest / Cypress / Puppeteer defaults
  webdriver.ts      WebDriver, which has to be read rather than guessed
  configs.ts        what a file on disk says about `headless`
  inspect.ts        the read-only filesystem seam
src/lanes/        headless | session | container implementations
src/session/      host side of the session lane: discovery, RPC client, setup
src/probe/        entitlements probe: is ad-hoc signing enough for this app?
src/cli/          api.ts (doctor/route/run/probe), session.ts (bring the lane
                  up), session-control.ts (drive it), index.ts, render.ts
src/mcp/          the MCP server, over the same API
native/sessiond/  the Swift daemon (its own README has the wire protocol)
docker/           the Xvfb image for the container lane
skills/           Claude Code skill
tests/            vitest suites + fixture corpus
```

## License

MIT
