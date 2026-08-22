# AGENTS.md

This is the source of truth for how an agent (Claude Code, Codex, or anything
else working in this repository) should operate here. If something in this
file conflicts with what you'd otherwise do, follow this file.

## What offstage is

offstage routes browser, UI, and macOS test commands away from the console
user's real screen. It looks at a command, decides which isolation substrate
it actually needs, and runs it there instead of on the machine's display.
Most commands are already headless and just run in place; offstage exists to
catch the ones that would open a window or steal focus.

## The three lanes

- `headless`: no isolation. The command already opens no window, so it runs
  in place. This is the default and the common case.
- `container`: a Linux container with an Xvfb virtual display, for web work
  that genuinely needs a headed browser (`--headed`, `headless: false`,
  WebGL/GPU flags, extension loading).
- `session`: a second, logged-in macOS user account with its own window
  server, framebuffer, and input stream, for macOS-native work that opens
  windows but does not change the machine (`xcodebuild`, `xcrun simctl`,
  XCUITests, `open -a`, `osascript`). The README's session section is the
  design summary; `native/sessiond/README.md` has the daemon's wire protocol.

There is no fourth lane for work that could change the machine itself. An
installer, a `.dmg`/`.pkg`, or `hdiutil` is refused outright: nothing runs, on
any lane, and the router's `reason` says why. There used to be a `vm` lane for
this; it was removed because it never drove a real macOS guest (git history
keeps that record).

## Build, test, smoke test

```bash
npm ci                    # Node 20+
npm run build              # tsc -> dist/
npm test                   # vitest run
npm run typecheck
bash native/sessiond/smoke.sh   # builds and drives the session daemon locally, no real session needed
```

`npm test` should be fully green on a clean clone with no Docker and no
macOS helper session set up: tests gated on an absent substrate skip rather
than fail. `native/sessiond/smoke.sh` builds the Swift daemon into a temp
directory, drives it as the current user against a private socket, and
prints `SMOKE PASSED`. It does not require the `computeruse` helper account
to exist.

## The session lane's permission model, briefly

The session lane drives a second macOS account (default `computeruse`) kept
logged in in the background via fast user switching. A small Swift daemon,
`offstage-sessiond`, runs inside that account's session and listens on a unix
socket; the host side connects to it to launch commands, capture the screen,
and inject input, all inside the other account. Setup needs root exactly once,
to create the account, pre-grant the daemon's two TCC permissions (Screen
Recording and Accessibility — system-level records that a terminal with Full
Disk Access may write directly), and bootstrap its LaunchAgent; when the
invoking terminal lacks Full Disk Access, those grants fall back to a one-time
human approval from inside the helper account's own session. The helper
account cannot read the caller's files until `offstage session share <dir>`
grants it read-only access to one tree at a time. Full details: the README's
session section, and `native/sessiond/README.md` for the wire protocol.

## Repo conventions

- The Swift daemon (`native/sessiond/`) has no third-party dependencies. It
  is one binary, compiled with `swiftc` from the Xcode Command Line Tools,
  because the helper account cannot be assumed to have Node or anything else
  installed.
- Code that touches the outside world (spawning a process, reading a file,
  making a network call) is written as a pure function with the impure part
  injected as a seam (an `exec` function, a `createClient` factory, and
  similar). That is what makes the router, the lanes, and the session host
  side unit-testable without a real Docker daemon, a real helper session, or
  a real subprocess.
- Tests live in `tests/` and are written with vitest. Vitest globals are
  off: import `describe`, `it`, and `expect` from `vitest` explicitly.
  `tests/fixtures/**` is sample code the lanes actually execute; it is
  excluded from both vitest collection and the TypeScript program, so it can
  import packages this repository does not install.
- Every module boundary is defined once, in `src/contract/index.ts`. A lane
  implements `LaneRunner`; `isAvailable()` never throws or mutates anything,
  `run()` never throws, and `run()` never falls back to the user's real
  screen when its substrate is unavailable.

## Hard rules

- Never run a headed browser or a macOS GUI command directly. Route it
  through offstage (`offstage route` to check, `offstage run` to execute, or
  the equivalent MCP tools). This applies to Playwright, Puppeteer, Cypress,
  WebDriver, `--headed` or `headless: false` runs, screen or video capture,
  `xcodebuild`, `xcrun simctl`, XCUITests, simulators, `open -a`, `osascript`,
  and launching a built `.app`.
- Never weaken the session lane's isolation guarantees. Input is posted with
  `CGEvent.post(tap: .cgSessionEventTap)`, never the global HID tap, because
  the HID tap always lands on the console session, which defeats the entire
  point of the lane. The daemon refuses to post input when its own session is
  on the console, and that check fails closed. Do not add a fallback path, a
  bypass flag, or a "just this once" exception to either of these.
- Never claim something is verified without evidence. The README's "Status"
  section is the record, and it distinguishes what was measured on a real
  machine from what is only exercised by fixtures. When you change a lane,
  update it with what you actually ran and observed, not what you expect to be
  true.
