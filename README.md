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

## Status

Early. The repository skeleton, the manifests and the lane contract are in
place; the lanes themselves are being implemented against that contract.

| Piece                             | State                                    |
| --------------------------------- | ---------------------------------------- |
| `src/contract/` — lane contract   | **implemented** — the interface below is stable |
| `src/router/` — `classify()`      | in progress                              |
| `src/lanes/headless/`             | in progress                              |
| `src/lanes/container/` + `docker/`| in progress                              |
| `src/lanes/vm/`                   | in progress                              |
| `src/probe/` — entitlements probe | in progress                              |
| `src/cli/` — `offstage` CLI       | in progress                              |
| `src/mcp/` — MCP server           | in progress                              |
| `.claude-plugin/`, `skills/`      | in progress                              |

Nothing here claims to be verified on real hardware yet; when the integration
pass lands it will record, per lane, what was exercised live versus only in
degraded mode.

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
