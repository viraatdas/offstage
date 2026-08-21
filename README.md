# offstage

[![CI](https://github.com/viraatdas/offstage/actions/workflows/ci.yml/badge.svg)](https://github.com/viraatdas/offstage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@viraatdas/offstage)](https://www.npmjs.com/package/@viraatdas/offstage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Keep UI and macOS work off your screen — including the work that needs a
real, logged-in macOS session.**

You ask an agent to check a UI change. It runs `npx playwright test --headed`, a
Chromium window jumps in front of what you were doing and steals your keyboard.
Or it runs `xcodebuild test`, and a Simulator takes over your desktop for four
minutes. Or it needs `open -a Xcode`, `osascript`, or an XCUITest against a
built `.app` — none of which run inside a Linux container, because they are not
Linux. The work is legitimate. The screen theft is not.

offstage is the routing layer that fixes that: it is not a new sandbox, it
routes to the cheapest isolation that can honestly run each command. Give it a
command, and it decides which of four substrates should run it — including,
new in this release, a second logged-in macOS account that runs GUI work in the
background — then runs it there and hands back one normalized result.

## offstage is not a new sandbox

This is the whole thesis, and it is worth being blunt about: **offstage does not
implement isolation.** Xvfb, Docker, and Tart already solved that, and they
solved it better than a new project would. What did not exist is the layer that
knows *which one you need* — and, most of the time, that you need none of them.

That last part is the interesting half. The reflex is to sandbox everything.
But `npx playwright test` is already headless: it opens no window and steals no
focus. Wrapping it in a container buys you nothing and costs you container
startup on every run. offstage's most common answer is "run it right here, and
here is why that was already safe."

## The four lanes

| Lane        | Substrate                     | When it is chosen                                                                                            |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `headless`  | none — runs in place          | The default for web test commands. Playwright and Puppeteer are headless unless told otherwise; no window opens, so no isolation is needed. |
| `session`   | a second logged-in macOS account | macOS-native work that opens windows but changes nothing: `xcodebuild`, `xcrun simctl`, XCUITests, `open -a`, `osascript`, `safaridriver`. A helper account sits logged in in the background with its own window server, framebuffer and HID stream; [`docs/session-lane.md`](docs/session-lane.md) has the design. |
| `container` | Linux container + Xvfb        | Web work that genuinely needs a headed browser: `--headed`, `headless: false`, WebGL/GPU flags, Chrome extension loading, video capture. Renders to a virtual framebuffer that never touches your display. |
| `vm`        | macOS guest via Tart          | macOS work that could **change the machine**: `.dmg`, `.pkg`, `installer`, `hdiutil`. Delegated to [`novotnyllc/tart-xcode-runner`](https://github.com/novotnyllc/tart-xcode-runner). |

### The session lane

macOS has no Xvfb. What it does have is fast user switching: a second, ordinary
macOS account (`computeruse` by default) can stay logged in in the background,
with its own window server, framebuffer and keyboard/mouse stream, while you
keep working on your own screen. offstage drives that account through a small
Swift daemon, `offstage-sessiond`, installed as a LaunchAgent inside it — the
host side connects over a unix socket to launch commands, take screenshots, and
inject input, all inside the other session. [`docs/session-lane.md`](docs/session-lane.md)
has the full design, wire protocol and verification ladder; [`docs/install.md`](docs/install.md)
has the one-time setup, which needs `sudo` once (`offstage session setup`) and
then a manual switch to the helper account once, to approve Screen Recording
and Accessibility — Apple gives no way to grant those from another account.

Plainly: **this is session isolation, not machine isolation.** Same OS, same
kernel, same disk — a different display and a different input stream, nothing
more. It does not protect against an installer or anything else that changes
the machine; `.dmg`, `.pkg`, `installer`, and `hdiutil` still route to the `vm`
lane, which is what a real boundary costs.

One rule holds across all four: **offstage never silently falls back to your
real screen.** If a lane's substrate is unavailable, the run stops and tells you
the exact command that would fix it. A headed browser appearing on your desktop
because Colima was not running would defeat the entire point.

## What the router cannot see

The router never executes a line of the repository it classifies. It reads argv,
and it reads a few small files — `package.json`, `playwright.config.*`, the
vitest config, a script the command names — and that is all. This is the safety
argument, not a shortcut: a router that evaluated your config to find out
whether it opens a window could open a window *while deciding whether to open a
window*, on your real screen, before any lane had been chosen.

The price is that a capability computed at runtime is invisible:

```ts
export default defineConfig({
  use: { headless: process.env.HEADED !== '1' },   // offstage cannot know
});
```

**So offstage says so.** It does not report Playwright's default as though it
had read yours. The command stays in the default `headless` lane — "I can't
tell" is a reason to say "I can't tell", not a reason to bill every ambiguous
repository for container startup — but the decision comes back with
`confidence: 'low'` and a reason that quotes the expression it could not
evaluate:

```
headless (low) — playwright.config.ts computes headless at runtime, from
`process.env.HEADED !== '1'`, and offstage reads files without ever executing
them — so it genuinely cannot know whether this run opens a window. It kept the
default headless lane rather than bill you for a container on a guess; if a
window does open, re-run with --headed and it goes to the container lane.
```

Four shapes fall outside what reading can settle, and each is reported rather
than guessed:

| What is in the file                       | Lane        | Confidence | Why                                                                       |
| ----------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------- |
| `headless: process.env.X`, `headless: fn()` | `headless`  | `low`      | The key is there; the value is an expression offstage will not evaluate.   |
| `use: sharedUse`, `launch(opts)`          | `headless`  | `low`      | The browser options are a reference; offstage reads one file and follows nothing out of it. |
| `headless` spelled both `false` and `true` | `container` | `low`      | A branch picked at runtime. Container is the cheaper way to be wrong.      |
| vitest browser mode with a computed `headless` | `container` | `low`  | Browser mode is headed outside CI unless something pins it, and nothing readable does. |

An explicit `--headed` or `--headless` on the command line settles all of them
and restores `confidence: 'high'`: whatever the config computes, argv is what
will actually run. The observation stays in `signals`, marked settled.

The same limit applies to *indirection*: offstage reads `package.json` scripts
(including `pre`/`post` hooks), config files, and scripts a command names —
including one passed inline with `node -e`. It does not parse Makefiles or
arbitrary shell scripts. So `make e2e`, where the recipe hides `--headed`,
routes headless. **If your headed run is behind a Makefile target or a shell
script, pass `--headed`.** And where a shell expansion decides the outcome
(`npx playwright test $FLAGS`), offstage says `confidence: 'low'` and quotes the
expansion rather than reporting the confident default.

[`docs/review.md`](docs/review.md) lists every bypass an adversarial pass found:
six closed and regression-tested, three stated as boundaries. A safety tool that
hides its limits is worse than one that has none.

`tests/router.purity.test.ts` holds the no-execution line;
`tests/router.runtime-capabilities.test.ts` holds the honesty that has to come
with it; `tests/router.adversarial.test.ts` holds the bypasses.

## Status

Every piece of the design is implemented and the suite is green from a clean
clone. What varies is the *evidence* behind each piece, and that distinction is
worth more than a progress bar:

| Piece | State |
| --- | --- |
| `src/contract/` — lane contract | implemented; the interface below is stable |
| `src/router/` — `classify()` | implemented; exercised against real repositories and adversarial commands |
| `src/lanes/headless/` | implemented; **verified live** — real processes, real timeouts, real log backpressure |
| `src/session/` — discovery, RPC client, setup | implemented; daemon verified live on the developer's own session; not yet verified inside the helper session |
| `src/lanes/session/` | implemented; daemon verified live on the developer's own session; not yet verified inside the helper session |
| `native/sessiond/` — the Swift daemon | implemented; daemon verified live on the developer's own session; not yet verified inside the helper session |
| `src/lanes/container/` + `docker/` | implemented; **verified live** — a headed Chromium ran inside it while the host screen stayed untouched |
| `src/lanes/vm/` | implemented; **fixture-tested only** — no real macOS guest has ever been booted |
| `src/probe/` — entitlements probe | implemented; real parsing of real `.xcodeproj`/`.app` fixtures, `codesign`/`hdiutil` paths driven through an injected runner |
| `src/cli/` — `offstage` CLI | implemented; `doctor` / `route` / `run` / `probe` / `session`, with `--json` on each |
| `src/mcp/` — MCP server | implemented; the eight tools call the CLI's own API, so they cannot diverge |
| `.claude-plugin/`, `skills/` | implemented; plugin, skill and `.mcp.json` for Claude Code, Codex wiring documented |

The session lane's gap is narrower and worth stating precisely: the daemon
compiles and every op round-trips over the socket — but that was measured
against a daemon running as uid 501, the developer's own session. No rung above
it has been climbed: nothing has yet run inside the `computeruse` session, no
screenshot of a non-console framebuffer exists, and no event has been injected
there. The ladder is in [`docs/verified.md`](docs/verified.md).

The vm lane is the honest gap: its adapter is written to the documented contract
of `tart-xcode-runner` and validated against recorded fixtures and
`xcresulttool`'s published JSON Schema, not against a bundle a real run
produced. [`docs/verified.md`](docs/verified.md) records, per lane, exactly what
was exercised live versus only in degraded mode — including the `offstage
doctor` output of the machine it was recorded on.

## Try it

```bash
curl -fsSL https://raw.githubusercontent.com/viraatdas/offstage/main/scripts/install.sh | sh
```

Installs the CLI, checks Node >= 20 and your PATH, runs `offstage doctor`, and
on macOS offers to set up the session lane — see [`docs/install.md`](docs/install.md)
for what that involves and why. Already have Node, or prefer to do it by hand?

```bash
npm i -g @viraatdas/offstage                # or: npx @viraatdas/offstage doctor

offstage doctor                             # which lanes work here, and the fix for the rest
offstage route -- npx playwright test       # where would this go? (nothing runs)
offstage run   -- npx playwright test       # send it there, hand back one result
offstage probe MyApp.xcodeproj              # is ad-hoc VM testing enough for this app?

offstage session status                     # macOS: is the helper account's session ready?
offstage session setup                      # install the daemon into it (asks for sudo once)
```

Working from a clone instead? `npm ci && npm link` — `prepare` builds `dist/`
on install, and `npm link` puts both binaries on your PATH.

`--json` on any of them puts the contract envelope on stdout and every human
line on stderr, so `offstage run --json -- npm test | jq .status` is safe.

`--lane` overrides the router, in one direction only. Asking for *more*
isolation than it chose always works. Asking for less — `--lane headless` on a
command routed to `container` or `vm` — is refused, nothing is executed, and
there is deliberately no flag that overrides the refusal.

[`docs/usage.md`](docs/usage.md) is the full reference.

## For agents

The core operations are MCP tools — `offstage_doctor`, `offstage_route`,
`offstage_run`, `offstage_probe` — plus four more for the session lane —
`offstage_session_status`, `offstage_session_screenshot`,
`offstage_session_input`, `offstage_session_apps` — all served over stdio by
`offstage-mcp`. They call `src/cli/api.ts`, the same code the CLI calls, so an
agent and a human cannot get different answers about what is safe to run in
place.

- **Claude Code**: `/plugin marketplace add viraatdas/offstage` then
  `/plugin install offstage@offstage`. It ships the `offstage` skill — which
  triggers on browser, UI, simulator and macOS app work — and registers the MCP
  server, which runs the published package with `npx`, so a plugin install needs
  no build step of its own.
- **Codex**: [`docs/codex.md`](docs/codex.md) has the `~/.codex/config.toml`
  block and the `AGENTS.md` text that tells it when to reach for the tools.

## Development

```bash
npm ci          # Node 20+
npm run build   # tsc -> dist/
npm test        # vitest
npm run typecheck
```

Two conventions worth knowing before you add code:

- Vitest globals are off. Import what you use: `import { describe, it, expect } from 'vitest'`.
- `tests/fixtures/**` is sample code for the lanes to *execute* — Playwright
  specs, Xcode projects, plists. It is excluded from both vitest collection and
  the TypeScript program, so it may import packages this repo does not install
  without breaking anyone's build.

## The contract

Everything crossing a module boundary in offstage is defined in
[`src/contract/index.ts`](src/contract/index.ts). A lane is:

```ts
interface LaneRunner {
  readonly lane: Lane;                                 // 'headless' | 'session' | 'container' | 'vm'
  isAvailable(): Promise<LaneAvailability>;            // { available, reason?, fix? }
  run(req: LaneRequest): Promise<LaneResult>;
}
```

and every lane, whatever substrate it drove, returns the same envelope:

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

`failed` versus `errored` is a real distinction: `failed` means the command ran
and something was red, `errored` means the run cannot be trusted at all (spawn
failure, timeout, substrate died). An agent may retry an `errored` run; retrying
a `failed` one just wastes time. `skipped` means the substrate was unavailable
and — importantly — that nothing ran anywhere.

### Failure reporting

`failures[]` is populated for **Playwright, Vitest and Jest, and nothing else**.
Run Mocha, pytest, `go test`, Cypress, `xcodebuild` or anything else and it comes
back empty — `status`, `exitCode` and the complete `command.log` are unaffected,
and `diagnostics` says out loud that nothing was recognized before quoting the
tail of the log verbatim. A parser that guesses is worse than one that abstains:
`failures[]` is what sends an agent to edit a specific line of a specific file.
[`docs/reporter-coverage.md`](docs/reporter-coverage.md) has the reasoning, the
verified corpus of tools that abstain, and the checklist for adding a fourth.

### Path conventions

Because the same envelope has to describe a run that happened on the host, in a
container, and inside a VM, path fields have fixed, enforced kinds:

| Field                          | Kind                | Rule                                                  |
| ------------------------------ | ------------------- | ----------------------------------------------------- |
| `LaneRequest.cwd`              | absolute (host)     | repository root the command runs against              |
| `LaneRequest.artifactsDir`     | absolute (host)     | run-scoped output directory the lane owns             |
| `LaneResult.artifactsDir`      | absolute (host)     | echoes the request                                    |
| `LaneResult.logPath`           | absolute (host)     | must be **inside** `artifactsDir`, or `null`          |
| `LaneResult.artifacts[].path`  | absolute (host)     | must be **inside** `artifactsDir`                     |
| `LaneResult.failures[].file`   | repository-relative | POSIX separators, relative to `cwd`, never absolute   |

Artifacts are things the run *produced*; the container and VM lanes generate
them in a guest and copy them back, so only an absolute host path stays true
once the substrate is gone. Failure paths point at your *source*, which exists
at different absolute prefixes on the host and in the guest — repository-relative
is the only form a human, an editor, and an agent can all resolve.

`parseLaneResult()` enforces all of this, containment included. Use
`artifactPath()` and `toRepoRelative()` from
[`src/contract/artifacts.ts`](src/contract/artifacts.ts) and you will produce
values it accepts.

### Writing a lane

```ts
import type { LaneRequest, LaneResult, LaneRunner } from '../contract/index.js';
import { createLaneResult, skippedResult } from '../contract/index.js';
import { artifactPath } from '../contract/artifacts.js';
```

Note the `import type` and the `.js` extension — this project is ESM with
`NodeNext` resolution and `verbatimModuleSyntax`, so both are required.

Three rules for an implementation:

1. `isAvailable()` never throws and never mutates the world. It probes; it does
   not start Colima, install Tart, or pull an image.
2. `run()` never throws. Every failure comes back as a valid `LaneResult` with
   `status: 'errored'` and an explanation in `diagnostics`.
3. `run()` never falls back to the user's screen. If the isolation cannot be
   provided, return `skippedResult(lane, artifactsDir, availability)` with the
   fix — do not run the command anyway.

`diagnostics` is the one free-form channel in the envelope. Use it generously:
why a lane was skipped, what isolation was applied, the tail of a log nothing
could parse.

### Runs on disk

Each run owns `.offstage/runs/<id>/` in the repository under test. Run ids are
timestamp-prefixed, so they sort chronologically. `allocateRunDir()` creates the
directory, `writeResult()` validates and persists `result.json` into it, and
`readResult()` validates on the way back in.

### The log never decides the verdict

Lanes stream a command's combined stdout and stderr to `command.log` in that
directory while it runs. Writing that file sits on the command's critical path,
so a disk that cannot keep up gets to slow the run down — and, done naively,
gets to change its outcome. Honouring backpressure blocks the command on a full
pipe until it is killed by its own timeout, which reports `errored` — "the
command never finished" — about a command that was fine. Ignoring backpressure
queues the unwritten output in memory without bound and then stalls the run
flushing it, overrunning the deadline the caller asked for.

offstage does neither. The log absorbs backpressure instead of passing it on:
writes never block the command, the queue is capped, and output arriving while
the queue is full is dropped from the log — never from the in-memory buffer the
result is computed from. A run whose log was cut short says so in
`diagnostics`, marks the gap in the file, and still reports the verdict the
command actually earned. **The log degrades; the answer does not.**

## Layout

```
src/contract/     the lane + result contract, and run-directory helpers
src/router/       classify(command) -> lane + reason
src/lanes/        headless | session | container | vm implementations of LaneRunner
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
