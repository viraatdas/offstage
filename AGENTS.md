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

Three lanes, and no fourth. Work that could change the machine itself is
refused rather than routed: a command naming an installer, a `.dmg`/`.pkg`, or
`hdiutil` is refused on every lane with no override, and the router's `reason`
says why.

The refusal reads the command, not the program behind it. `argv[0]` is resolved
on disk (through `PATH`, a symlink, a rename, or a copy) and inline `-c`/`-e`
code is inspected, but a script file, a Makefile, an npm script or a compiled
binary is opaque to it. Do not describe it as a sandbox, and do not add a lane
or a flag that weakens it.

offstage does not run virtual machines, and nothing in it should imply that it
does. A `vm` lane existed once and was deleted in 0.3.0 because it never drove
a real macOS guest; do not reintroduce one, and do not describe a lane, a
verdict, or a doc in terms of a VM.

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
Recording and Accessibility, system-level records that a terminal with Full
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
- No source file goes over 1,000 lines. `src/router/` and `src/cli/` are each
  split into modules that form a directed graph with no cycles: leaf modules
  (`signal.ts`, `flags.ts`, `bins.ts`) know nothing about their callers, and
  the collectors above them import downward only. When a file is getting long,
  find the seam that already exists in it rather than adding a barrel that
  re-exports everything.
- The session lane's own verbs are not in `src/cli/api.ts`. `api.ts` is
  doctor/route/run/probe; `src/cli/session.ts` brings the session lane up and
  `src/cli/session-control.ts` drives one that is already up. What they share
  is `ApiDeps`, read through `withDefaults`.

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
