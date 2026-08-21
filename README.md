# offstage

[![CI](https://github.com/viraatdas/offstage/actions/workflows/ci.yml/badge.svg)](https://github.com/viraatdas/offstage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@viraatdas/offstage)](https://www.npmjs.com/package/@viraatdas/offstage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Run browser and macOS test commands without them stealing your screen.**

An agent runs `npx playwright test --headed` and a Chromium window jumps in
front of what you were doing. Or it runs `xcodebuild test` and a Simulator
takes over your desktop. offstage looks at the command, decides where it can
actually run safely, and sends it there instead. Most commands are already
headless and just run in place: offstage's job is to catch the ones that
aren't.

```bash
npm i -g @viraatdas/offstage

offstage doctor                        # which lanes work on this machine
offstage route -- npx playwright test  # where would this go? (nothing runs)
offstage run   -- npx playwright test  # send it there, get one normalized result
```

## The three lanes

| Lane | What runs it | Used for |
| --- | --- | --- |
| `headless` | nothing extra, runs in place | Playwright/Puppeteer without `--headed`. Already safe. |
| `container` | a Linux container with Xvfb | `--headed`, `headless: false`, WebGL/GPU flags, extension loading. |
| `session` | a second logged-in macOS account | `xcodebuild`, `xcrun simctl`, XCUITests, `open -a`, `osascript`. macOS-native work that opens windows but doesn't touch the machine itself. |

Anything that could change the machine itself, an installer, a `.dmg`/`.pkg`,
`hdiutil`, is refused outright instead of routed anywhere. Session isolation
shares your OS and disk with you, so it can't honestly contain that, and
offstage has no lane that can. Nothing runs, on any lane, and the reason says
why. Run the command directly yourself if you accept the risk.

`offstage route` tells you which lane a command would use and why, without
running it. `offstage run` actually runs it there. Asking for *more* isolation
than the router picked always works (`--lane container` on something routed to
`headless`); asking for less is refused outright, nothing runs, and there's no
flag to override the refusal.

If a lane's substrate isn't available (no Docker running, session not set up),
the run stops and tells you the fix. offstage never falls back to running the
command on your real screen.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/viraatdas/offstage/main/scripts/install.sh | sh
```

Installs the CLI, checks Node >= 20 and your PATH, runs `offstage doctor`, and
on macOS offers to set up the session lane. See [`docs/install.md`](docs/install.md)
for what that involves.

Or by hand:

```bash
npm i -g @viraatdas/offstage
offstage doctor
```

From a clone:

```bash
npm ci && npm link   # prepare builds dist/, npm link puts both binaries on your PATH
```

## Using each lane

```bash
offstage run -- npx playwright test              # headless, or container if it opens a window
offstage run -- xcodebuild test -scheme MyApp     # routes to the session lane on macOS
offstage probe MyApp.xcodeproj                    # is ad-hoc VM testing enough, or do you need a signing lane?
```

`--json` puts the result envelope on stdout and moves every human-readable
line to stderr, so `offstage run --json -- npm test | jq .status` is safe to
pipe.

The `session` lane needs a one-time setup step before it works. That's covered
in detail below, since it's the part people get stuck on.

## The auth model: how the session lane gets permission to act

The `session` lane drives a second, ordinary macOS user account (default name
`computeruse`) that stays logged in in the background via fast user switching.
It has its own window server, its own framebuffer, its own keyboard/mouse
stream. A small Swift daemon, `offstage-sessiond`, runs inside that account
and listens on a unix socket at `/tmp/offstage-session/<uid>.sock`. Your own
session talks to it over that socket to launch commands, take screenshots, and
inject input, all inside the other account.

### Setup needs root exactly once

```bash
offstage session setup --create
```

This is the only step that touches `sudo`. It installs the daemon binary into
the helper account's own home, at `~/.offstage/bin/offstage-sessiond`, and
bootstraps a LaunchAgent into that account's GUI domain. Everything after this
needs no root and no password.

That location is deliberate. The account that runs the daemon owns it, so
updates are a file copy the daemon performs on itself:

```bash
offstage session update
```

That rebuilds the daemon, installs it, and restarts it, without a password. A
binary the helper account owns is one that anything running as that account
could swap, so it is worth being precise about what that does and does not
give away: it would not inherit the daemon's Screen Recording or Accessibility
grants, because those are keyed to the binary's code signature, not its path.
An unsigned or differently signed replacement gets nothing.

### Two permissions only a human can grant

macOS gates screen capture and synthetic input behind two TCC permissions:
**Screen Recording** and **Accessibility**. There is no API to grant these
programmatically, not even as root: SIP blocks writing to the permission
database directly. A person has to switch into the helper account once, open
`System Settings > Privacy & Security`, and toggle both on for
`offstage-sessiond`.

Switch accounts with fast user switching (the menu bar user menu, or the login
window). Don't log the helper account out entirely, that ends its session and
kills the daemon with it.

### Why granting the permission doesn't need a restart-as-root

The daemon reads both TCC answers once and caches them for the life of the
process, so a grant made after it started is invisible until it restarts.
Restarting normally needs `launchctl kickstart`, which needs root, which would
mean an admin password prompt appearing behind your back on your own screen.
Instead the daemon exposes a `restart` op over the socket: it replies, then
exits with status 70. Its LaunchAgent is configured `KeepAlive { SuccessfulExit:
false }`, so launchd immediately starts it again, now with the fresh grants.
No root, no password, after the initial setup.

### Why the build has to be code signed

A TCC grant is keyed to the binary's Designated Requirement (DR), not to where
the binary sits on disk: a build placed at an entirely different path still
carries a grant already made to the same identity, as long as it satisfies the
same DR. Built with a Developer ID identity, the DR is the signing identifier
plus the team ID, and that doesn't change when you rebuild. Grants survive
rebuilds. Built ad hoc, the DR degenerates to the binary's raw hash, so every
rebuild changes it, silently drops both grants, and the lane goes dead until
someone re-grants them.

Use a Developer ID identity if you have one. `OFFSTAGE_CODESIGN_IDENTITY`
overrides which identity gets used; set it to `-` to force ad hoc (useful for
local iteration, bad for anything you'll rebuild often).

### Filesystem access is separate from TCC

The helper account is a different uid and can't read your home directory by
default. Grant it read access to one tree at a time:

```bash
offstage session share ~/code/myrepo
```

This adds a read-only ACL. It never grants write. Anything a run produces goes
into that run's own artifacts directory, which the lane grants write access to
per run.

### Input never touches your screen

Input is posted with `CGEvent.post(tap: .cgSessionEventTap)`, the per-session
event entry point. An event posted this way enters the posting process's own
session and the window server routes it to that session's key window, so it
lands inside the helper session and nowhere else. The global HID tap
(`.cghidEventTap`) is never used: it always routes to whichever session is on
the console, which is your screen, so using it would defeat the entire point
of the lane.

An earlier version posted with `CGEvent.postToPid`, targeting the frontmost
app's process directly. That produced zero real deliveries and was dropped:
it had only looked correct because it was tested by a process posting to
itself, which always succeeds and proves nothing about delivery across
processes.

The daemon refuses to post rather than guess wrong: error code `on-console`
if its own session is currently the one on the console (so "post into the
helper session" would actually mean "post into yours"), and `no-target` if no
app is frontmost to receive the event. Each `input` call also returns a
`performed` count, so a partial failure tells you exactly how many actions
landed before it stopped.

### Check it worked

```bash
offstage session status
```

Reports the account, whether its session is logged in, whether the daemon is
running, and both TCC grants. If something's missing, it prints the exact
command or manual step to fix it.

See [`docs/session-lane.md`](docs/session-lane.md) for the full design, wire
protocol, and verification ladder.

## Status

Everything below is implemented. What varies is how much of it has actually
been run for real, not just tested against fixtures:

| Lane | State |
| --- | --- |
| `headless` | verified live: real processes, real timeouts, real log backpressure |
| `container` | verified live: a headed Chromium ran inside it while the host screen stayed untouched |
| `session` | live-verified inside the actual helper (`computeruse`) session: Accessibility is granted, input lands on the helper session's frontmost app (confirmed against the window server's own delivery log, and none reached the console session), and a grant made mid-run is picked up by the socket `restart` op with no root. Screen Recording is not yet granted on the test machine, so the full screenshot-of-typed-input loop is **not yet verified end to end**, and the headed-Playwright-through-session path specifically is **not proven**. |

[`docs/verified.md`](docs/verified.md) has the detail, lane by lane, including
what was checked by hand versus only through the test suite.

## For agents

Working on this repository yourself? Read [`AGENTS.md`](AGENTS.md) first;
it's the single source of truth for build, test, and the hard rules. This
section is about using offstage from another project, as a tool.

The same four operations are exposed as MCP tools over stdio by
`offstage-mcp`: `offstage_doctor`, `offstage_route`, `offstage_run`,
`offstage_probe`, plus four for the session lane: `offstage_session_status`,
`offstage_session_screenshot`, `offstage_session_input`,
`offstage_session_apps`. They call the same code the CLI calls, so a human and
an agent get the same answer about what's safe to run in place.

- **Claude Code**: `/plugin marketplace add viraatdas/offstage` then
  `/plugin install offstage@offstage`. Ships the `offstage` skill (triggers on
  browser, UI, simulator, and macOS app work) and registers the MCP server,
  which runs the published package with `npx`, so installing the plugin needs
  no build step.
- **Codex**: see [`docs/codex.md`](docs/codex.md) for the `~/.codex/config.toml`
  block and the `AGENTS.md` text.

## Development

```bash
npm ci          # Node 20+
npm run build   # tsc -> dist/
npm test        # vitest
npm run typecheck
bash native/sessiond/smoke.sh   # builds and drives the session daemon locally
```

Two things worth knowing:

- Vitest globals are off. Import what you use:
  `import { describe, it, expect } from 'vitest'`.
- `tests/fixtures/**` is sample code the lanes actually execute (Playwright
  specs, Xcode projects, plists). It's excluded from vitest collection and
  from the TypeScript program, so it can import packages this repo doesn't
  install.

## The contract

Every module boundary in offstage is defined in
[`src/contract/index.ts`](src/contract/index.ts). A lane implements:

```ts
interface LaneRunner {
  readonly lane: Lane;                       // 'headless' | 'session' | 'container'
  isAvailable(): Promise<LaneAvailability>;  // { available, reason?, fix? }
  run(req: LaneRequest): Promise<LaneResult>;
}
```

and every lane returns the same result shape, whatever substrate it drove:

```ts
interface LaneResult {
  lane: Lane;
  status: 'passed' | 'failed' | 'errored' | 'skipped';
  exitCode: number | null;
  startedAt: string;          // ISO-8601 UTC
  durationMs: number;
  artifactsDir: string;
  logPath: string | null;
  artifacts: { kind: 'log' | 'screenshot' | 'video' | 'xcresult' | 'other'; path: string }[];
  failures: { test?: string; message: string; file?: string; line?: number }[];
  diagnostics: string[];
}
```

`failed` means the command ran and something was red. `errored` means the run
itself can't be trusted (spawn failure, timeout, substrate died). Retry an
`errored` run; retrying a `failed` one just wastes time. `skipped` means the
substrate wasn't available, so nothing ran anywhere.

`failures[]` is populated for Playwright, Vitest, and Jest only. Everything
else (Mocha, pytest, `go test`, Cypress, `xcodebuild`, ...) comes back with an
empty `failures[]`, but `status`, `exitCode`, and the full `command.log` are
still correct, and `diagnostics` says plainly that nothing was recognized. See
[`docs/reporter-coverage.md`](docs/reporter-coverage.md).

### Path conventions

The same result has to describe a run that happened on the host, in a
container, or in the session lane's other account, so path fields have fixed
rules:

| Field | Kind | Rule |
| --- | --- | --- |
| `LaneRequest.cwd` | absolute (host) | repository root the command runs against |
| `LaneRequest.artifactsDir` | absolute (host) | run-scoped output directory the lane owns |
| `LaneResult.artifactsDir` | absolute (host) | echoes the request |
| `LaneResult.logPath` | absolute (host) | must be inside `artifactsDir`, or `null` |
| `LaneResult.artifacts[].path` | absolute (host) | must be inside `artifactsDir` |
| `LaneResult.failures[].file` | repository-relative | POSIX separators, relative to `cwd`, never absolute |

Artifacts are things the run produced, so an absolute host path is the only
one still valid once the substrate (container) is gone. Failure paths
point at your source, which lives at different absolute prefixes on the host
and in the guest, so repository-relative is the only form everyone can
resolve. `parseLaneResult()` enforces this; use `artifactPath()` and
`toRepoRelative()` from [`src/contract/artifacts.ts`](src/contract/artifacts.ts)
to produce values it accepts.

### Writing a lane

```ts
import type { LaneRequest, LaneResult, LaneRunner } from '../contract/index.js';
import { createLaneResult, skippedResult } from '../contract/index.js';
import { artifactPath } from '../contract/artifacts.js';
```

Note the `import type` and the `.js` extension. This project is ESM with
`NodeNext` resolution and `verbatimModuleSyntax`, so both are required.

Three rules:

1. `isAvailable()` never throws and never changes anything. It only checks.
2. `run()` never throws. Every failure comes back as a valid `LaneResult` with
   `status: 'errored'` and an explanation in `diagnostics`.
3. `run()` never falls back to the user's screen. If isolation can't be
   provided, return `skippedResult(lane, artifactsDir, availability)` with the
   fix. Don't run the command anyway.

### Runs on disk

Each run owns `.offstage/runs/<id>/` in the repository under test, with
timestamp-prefixed ids so they sort chronologically. `allocateRunDir()`
creates the directory, `writeResult()` validates and persists `result.json`,
`readResult()` validates on the way back in.

Lanes stream a command's combined stdout/stderr to `command.log` in that
directory while it runs. That write sits on the command's critical path, so
writes never block the command and the queue is capped: output arriving while
the queue is full is dropped from the log file, never from the in-memory
buffer the result is computed from. A run whose log was cut short says so in
`diagnostics` and still reports the verdict the command actually earned.

## Layout

```
src/contract/     the lane + result contract, and run-directory helpers
src/router/       classify(command) -> lane + reason
src/lanes/        headless | session | container implementations of LaneRunner
src/session/      the session lane's host side: discovery, RPC client, setup
src/probe/        entitlements probe: is a signing lane required?
src/cli/          the offstage CLI
src/mcp/          MCP server wrapping the CLI's programmatic API
native/sessiond/  offstage-sessiond: the Swift daemon that runs in the helper session
docker/           the Xvfb image for the container lane
skills/           Claude Code skill
tests/            vitest; tests/fixtures/** is never collected as tests
```

## License

MIT
