---
name: offstage
description: Run browser, UI and macOS app work without taking over the user's screen. Use before any command that could open a window or steal focus (Playwright, Puppeteer, Cypress, WebDriver, `--headed` or `headless: false` runs, screen or video capture, `xcodebuild`, `xcrun simctl`, XCUITests, iOS/macOS simulators, `open -a`, `osascript`, or launching a built `.app`. offstage decides whether the command is already safe to run in place, needs a Linux container with a virtual display, or needs the macOS session lane (a second logged-in account whose display, focus and input are its own)) and refuses to run it on the real screen, or at all, when the isolation it needs is missing.
---

# offstage

**A window opening on the user's desktop, mid-conversation, is a bug.** Their
keyboard focus is taken, whatever they were doing is interrupted, and they did
not consent to it. offstage exists so that never happens by accident.

## The one thing to know

Most browser test commands are **already headless**. `npx playwright test` opens
no window. Wrapping it in a container buys nothing and costs container startup
on every run. So offstage's most common answer is "run it right here, and here
is why that was already safe", and that is the answer you should want.

Do not reach for a container reflexively, and do not skip the check because a
command "looks headless". Ask offstage.

## Use it

If the `offstage_*` MCP tools are available, prefer them. Otherwise shell out to
the CLI: identical behaviour, same code path.

| Step | MCP tool | CLI |
| --- | --- | --- |
| Where would this go? (nothing runs) | `offstage_route` | `offstage route -- <cmd>` |
| Run it off-screen | `offstage_run` | `offstage run -- <cmd>` |
| Which lanes work on this machine? | `offstage_doctor` | `offstage doctor` |
| Is ad-hoc signing enough for this macOS app? | `offstage_probe` | `offstage probe <path>` |
| Is the macOS session lane ready? | `offstage_session_status` | `offstage session status` |
| See the helper session's screen | `offstage_session_screenshot` | `offstage session screenshot` |
| Click/type in the helper session | `offstage_session_input` | `offstage session click / type / key` |
| What is running in it? | `offstage_session_apps` | `offstage session apps` |

`route` is free and side-effect-free: it reads argv and a few small config
files and never executes a line of the repository. When you are unsure whether
a command is safe, call it before you call `run`, and definitely before you
reach for a plain `Bash` call.

```
offstage run -- npx playwright test              # headless: runs in place
offstage run -- npx playwright test --headed     # container: Xvfb, not your screen
offstage run -- xcodebuild test -scheme App      # session: the other macOS account's screen
offstage run -- hdiutil attach App.dmg           # refused: could change the machine, no lane isolates that
```

## Reading the answer

Every run returns the same envelope, whichever substrate produced it:

- `status`: `passed` / `failed` / `errored` / `skipped`. **`failed` means the
  tests ran and something was red; `errored` means the run cannot be trusted at
  all.** Retrying an `errored` run can help. Retrying a `failed` one just wastes
  the user's time: read `failures[]` and fix the code.
- `skipped` means **nothing ran anywhere**. The substrate was missing. Never
  report a `skipped` run as a pass, and never re-run the command outside
  offstage to "get past it": that is exactly the screen theft offstage
  prevents. Show the user the `fix` line from `diagnostics` instead.
- `offstage_route` can also come back with `refuse` set: the command could
  change the machine itself (an installer, a `.dmg`/`.pkg`, `hdiutil`), and
  offstage has no lane that isolates that. `offstage_run` on that command
  comes back `errored` with `diagnostics[0]` starting `Refused:` and nothing
  executed, on any lane. There is no `lane` argument that gets past it. Tell
  the user offstage will not run it; running it directly is their call to
  make, not something to do on their behalf.
- `failures[]` is populated for **Playwright, Vitest and Jest only**. Empty for
  Mocha, pytest, `go test`, Cypress, `xcodebuild` and everything else: that is
  deliberate abstention, not a bug. `status` and `command.log` are still true.
- `diagnostics` says what isolation was applied and why. Quote it when the
  answer surprises the user.

## When a lane is unavailable

`offstage doctor` prints the exact command that fixes each gap: `orb start`,
`colima start`, a `brew install`. Give the user that line and stop. Do **not**:

- re-run the command directly with `Bash` because the container would not start;
- pass `--lane headless` to force work past a routing decision (offstage
  refuses it, by design, and there is no flag that overrides the refusal);
- strip `--headed` from the user's command to make it fit the headless lane.

## Confidence is part of the answer

A decision can come back `confidence: 'low'`. That means the repository computes
its own headedness at runtime, `headless: process.env.HEADED !== '1'`, and
offstage will not execute a config file to find out. It keeps the cheap lane and
says so. If the user reports that a window opened anyway, re-run with `--headed`
and it goes to the container lane; that is the intended repair, not a defect.

## What offstage cannot see

offstage routes on what it can **read**: argv, config files, `package.json`
scripts, and a script the command names. Two things fall outside that, and both
matter to you:

- **A Makefile target or a shell script.** `make e2e` or `./run.sh` that hides
  `--headed` inside routes to the headless lane, because offstage does not parse
  those files. If you know the underlying command opens a window, either run
  that command through offstage directly, or pass `--headed` / `headed: true`.
- **A shell expansion.** `npx playwright test $FLAGS` comes back
  `confidence: 'low'` with the expansion quoted. Treat low confidence as "check
  this", not as a verdict.

Reporting this rather than guessing is deliberate. Do not work around it by
running the command outside offstage.

## macOS: the session lane

macOS has no Xvfb and cannot have one. What it has is **a second GUI session**:
another local account, logged in, sitting in the background with its own window
server, its own framebuffer and its own keyboard/mouse stream. That is the
`session` lane: the default for `xcodebuild`, `xcrun simctl`, XCUITests,
`open -a`, `osascript`, `safaridriver` and launching a built `.app`. Windows
open there. Nothing reaches the user's display and nothing takes their focus.

```
offstage_run  { lane: "session", cwd, command: ["open", "-a", "Safari"] }
offstage run --lane session -- npx playwright test --headed
```

### Launching an app: use offstage_session_launch, never `open` outside

To start a built `.app` for GUI testing, call **`offstage_session_launch`**
(`offstage session launch <name-or-path>`) rather than `offstage_run -- open`.
It waits until the app has actually registered with the session, the reply
carries its pid, instead of returning the moment LaunchServices accepts the
request. First launches can be slow (Gatekeeper verifies the bundle); if it
times out, take a screenshot and retry once. Never fall back to launching the
app yourself: anything launched outside offstage opens on the USER's screen.

For the same reason, never exec the binary inside `App.app/Contents/MacOS/`
directly, even through the session lane: it bypasses LaunchServices, so the app
may never appear in `offstage_session_apps`. Launch bundles as bundles.

**"Installing" the user's app into the guest account** (when they want it
tested from an installed location) is a copy, not an installer: `.pkg`/`.dmg`
are refused outright, but this is not that:

```
offstage_run { lane:"session", command:["sh","-c","mkdir -p /Users/computeruse/Applications && cp -R build/App.app /Users/computeruse/Applications/"] }
offstage_session_launch { target: "/Users/computeruse/Applications/App.app", fresh: true, waitMs: 60000 }
```

Use absolute paths under the helper account's home; kill old instances
(`pkill -x App` via the session lane) before relaunching; expect a freshly
copied bundle to register slowly (hence the generous `waitMs`).

It is **session isolation, not machine isolation**, same kernel, same disk.
Anything that could change the machine (`.dmg`, `.pkg`, `installer`,
`hdiutil`) is refused outright: offstage has no lane that isolates that, so it
does not run the command anywhere rather than force it into `session`. If the
user needs that, tell them offstage cannot do it and to run it directly
themselves if they accept the risk.

### The loop: screenshot → decide → input → screenshot

`offstage_session_input` is fire-and-forget: it reports how many actions it
performed and nothing about what they hit. The only way to know is to look.

1. `offstage_session_screenshot`: see the helper session's screen.
2. Decide what to click or type.
3. `offstage_session_input`: one array of actions.
4. `offstage_session_screenshot` again: confirm it did what you meant.

**Coordinates are points, not pixels.** The screenshot reports `width`,
`height` and `scale`; divide a pixel coordinate by `scale` to get the point the
daemon expects. Origin is the top-left of the helper session's main display.

### If an app launches but then disappears

Some apps quit shortly after starting when a permission they require (Input
Monitoring for anything that watches trackpad/keyboard events, for example)
was never granted **inside the helper account**. TCC is per session: the user
may have approved the app years ago in their own session and have no idea the
background account needs the same toggle. The fix is one switch inside that
session, or `offstage session launch` will keep reporting a clean launch
followed by the process vanishing.

### Two things to tell the user rather than work around

- **`errored` with an `offstage session share` fix.** The helper account is a
  different uid and the user's home is `0750`, so it cannot read their
  repository until they grant it: `offstage session share ~/code/theirrepo`.
  That command is theirs to run: it changes ACLs on their files. Do not try to
  chmod around it, and do not re-run the command outside offstage.
- **`skipped` with an `offstage session setup` fix.** Setup compiles a small
  daemon and installs it with `sudo`, and it prompts for a password, so there is
  no MCP tool for it: the user runs `offstage session setup --create` in a
  terminal. That one command creates the account, suppresses its first-login
  screens, and pre-grants Screen Recording and Accessibility when the terminal
  has Full Disk Access. If it reports those grants were skipped (no FDA), the
  fallback is one manual visit: switch into the helper account once and approve
  both toggles in System Settings → Privacy & Security.
  `offstage_session_status` reports both grants either way.

### Never the user's own session

Every session tool drives the **helper** account. There is no parameter that
points them at the console session, and asking for one is asking to take over
the user's keyboard. If the helper session is currently the one on screen, the
lane reports itself unavailable and refuses: relay that, do not look for
another way in.

## macOS apps

Before promising a user a macOS app test setup, run `offstage probe <path to
.xcodeproj / .app / .dmg>`. It answers one question: `adhoc-ok` (ad-hoc signing
carries every entitlement the app requests, so no Apple credentials are needed)
or `needs-signing-lane` (the app declares entitlements only a real Developer ID
can carry, which is a much larger project). offstage does not sign anything, so
this is a fact about the app, not about offstage. Read `confidence` and each
trigger's `certainty` before repeating the verdict: a `low`-confidence
`adhoc-ok` means "found no blocker", not "proved there is none".
