# offstage

**Keep UI work off your screen.**

You ask an agent to check a UI change. It runs `npx playwright test --headed`, a
Chromium window jumps in front of what you were doing and steals your keyboard.
Or it runs `xcodebuild test`, and a Simulator takes over your desktop for four
minutes. The work is legitimate. The screen theft is not.

offstage is the routing layer that fixes that. Give it a command, and it decides
which isolation substrate should run it — then runs it there and hands back one
normalized result.

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

## The three lanes

| Lane        | Substrate                     | When it is chosen                                                                                            |
| ----------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `headless`  | none — runs in place          | The default for web test commands. Playwright and Puppeteer are headless unless told otherwise; no window opens, so no isolation is needed. |
| `container` | Linux container + Xvfb        | Web work that genuinely needs a headed browser: `--headed`, `headless: false`, WebGL/GPU flags, Chrome extension loading, video capture. Renders to a virtual framebuffer that never touches your display. |
| `vm`        | macOS guest via Tart          | macOS-native work: `xcodebuild`, `xcrun simctl`, XCUITests, launching a built `.app`. Delegated to [`novotnyllc/tart-xcode-runner`](https://github.com/novotnyllc/tart-xcode-runner). |

One rule holds across all three: **offstage never silently falls back to your
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

`tests/router.purity.test.ts` holds the no-execution line;
`tests/router.runtime-capabilities.test.ts` holds the honesty that has to come
with it.

## Status

Every piece of the design is implemented and the suite is green from a clean
clone. What varies is the *evidence* behind each piece, and that distinction is
worth more than a progress bar:

| Piece | State |
| --- | --- |
| `src/contract/` — lane contract | implemented; the interface below is stable |
| `src/router/` — `classify()` | implemented; exercised against real repositories and adversarial commands |
| `src/lanes/headless/` | implemented; **verified live** — real processes, real timeouts, real log backpressure |
| `src/lanes/container/` + `docker/` | implemented; verified live on this host previously, fixture-tested since |
| `src/lanes/vm/` | implemented; **fixture-tested only** — no real macOS guest has ever been booted |
| `src/probe/` — entitlements probe | implemented; real parsing of real `.xcodeproj`/`.app` fixtures, `codesign`/`hdiutil` paths driven through an injected runner |
| `src/cli/` — `offstage` CLI | implemented; `doctor` / `route` / `run` / `probe`, with `--json` on each |
| `src/mcp/` — MCP server | implemented; the four tools call the CLI's own API, so they cannot diverge |
| `.claude-plugin/`, `skills/` | implemented; plugin, skill and `.mcp.json` for Claude Code, Codex wiring documented |

The vm lane is the honest gap: its adapter is written to the documented contract
of `tart-xcode-runner` and validated against recorded fixtures and
`xcresulttool`'s published JSON Schema, not against a bundle a real run
produced. [`docs/verified.md`](docs/verified.md) records, per lane, exactly what
was exercised live versus only in degraded mode — including the `offstage
doctor` output of the machine it was recorded on.

## Try it

```bash
git clone https://github.com/viraatdas/offstage && cd offstage
npm ci            # `prepare` builds dist/ for you
npm link          # puts `offstage` and `offstage-mcp` on your PATH

offstage doctor                             # which lanes work here, and the fix for the rest
offstage route -- npx playwright test       # where would this go? (nothing runs)
offstage run   -- npx playwright test       # send it there, hand back one result
offstage probe MyApp.xcodeproj              # is ad-hoc VM testing enough for this app?
```

Without `npm link`, use `node dist/cli/index.js …` from the clone — the binary
is only on your PATH once it is linked or installed.

`--json` on any of them puts the contract envelope on stdout and every human
line on stderr, so `offstage run --json -- npm test | jq .status` is safe.

`--lane` overrides the router, in one direction only. Asking for *more*
isolation than it chose always works. Asking for less — `--lane headless` on a
command routed to `container` or `vm` — is refused, nothing is executed, and
there is deliberately no flag that overrides the refusal.

[`docs/usage.md`](docs/usage.md) is the full reference.

## For agents

The same four operations are MCP tools — `offstage_doctor`, `offstage_route`,
`offstage_run`, `offstage_probe` — served over stdio by `offstage-mcp`. They
call `src/cli/api.ts`, the same code `offstage run` calls, so an agent and a
human cannot get different answers about what is safe to run in place.

- **Claude Code**: install the plugin in this repository (`.claude-plugin/`).
  It ships the `offstage` skill, which triggers on browser, UI, simulator and
  macOS app work, and registers the MCP server via `.mcp.json`.
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
  readonly lane: Lane;                                 // 'headless' | 'container' | 'vm'
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
src/lanes/        headless | container | vm implementations of LaneRunner
src/probe/        entitlements probe: is a signing lane required?
src/cli/          the offstage CLI
src/mcp/          MCP server wrapping the CLI's programmatic API
docker/           the Xvfb image for the container lane
skills/           Claude Code skill
tests/            vitest; tests/fixtures/** is never collected as tests
```

## License

MIT
