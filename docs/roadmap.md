# offstage — roadmap

The build was an 11-node plan. **All eleven nodes are done**, along with twelve
follow-up hardening passes. The suite is green from a clean clone
(`npm ci && npm run build && npm test`: 26 files, 805 passed, 2 expected fail,
7 skipped — 807 passed with a container runtime running).

What remains is not design work. It is evidence, and one release decision.

## Done

- **n0** — Foundation: scaffold + results contract
- **n1** — Router: classify a command into a lane
- **n2** — Headless lane: run in place, prove no window opens
- **n3** — Container lane: headed web under Xvfb
- **n4** — VM lane: adapter over novotnyllc/tart-xcode-runner
- **n5** — Entitlements probe: is the signing lane required?
- **n6** — CLI core: `offstage doctor / route / run / probe`, `--json` on each,
  and the one refusal that has no override. `src/cli/{api,render,index}.ts`.
  `src/mcp/core.ts` was collapsed onto `src/cli/api.ts`, so there is exactly one
  dispatch path and an agent cannot get a different answer than a human.
- **n7** — MCP server wrapping the CLI: `offstage_doctor` / `offstage_route` /
  `offstage_run` / `offstage_probe` over stdio.
- **n8** — Claude Code plugin + skill + Codex wiring: `.claude-plugin/`,
  `skills/offstage/SKILL.md`, `.mcp.json`, `docs/usage.md`, `docs/codex.md`.
- **n9** — End-to-end integration + live smoke: `tests/e2e.test.ts` drives the
  real command tree against real fixtures; `docs/verified.md` records what was
  exercised live versus in degraded mode.
- **n10** — Review pass: two real routing holes found and closed
  (`env PWDEBUG=1 …` and `sh -c '… --headed'`, both of which routed work that
  opens a window into the lane with no display). Findings in `docs/review.md`.
- **followup-1..12** — hardening: the two-tsconfig split, dependency pins, the
  4MB capture budget, the reporter-coverage boundary, WebDriver capability
  reading, video-vs-screen capture, runtime-computed capability honesty, and log
  backpressure.

## Left

### The vm lane has never driven a real macOS guest

(The container lane no longer belongs on this list: as of 2026-08-18 it has run
a genuinely headed Chromium with the host screen verifiably untouched — see
[docs/verified.md](verified.md).)

This is the one gap that matters. Every claim about the vm lane rests on 28
recorded fixtures and `xcresulttool`'s published JSON Schema 0.1.0 — not on a
bundle a real run produced. Closing it means installing Tart and the
`tart-xcode-runner` plugin, preparing a golden image, and driving one XCUITest
through `offstage run`. Until someone does that, the README, `docs/verified.md`
and `DECISIONS.md` all say "fixture-tested only" in those words.

### Publish, so the plugin does not need a build step

`.mcp.json` points at `${CLAUDE_PLUGIN_ROOT}/dist/mcp/index.js`, and `dist/` is
a build output that is not committed — so a plugin installed from git needs one
`npm ci && npm run build` in the plugin root. Publishing to npm would let the
manifest say `npx -y offstage-mcp` instead. That is a release decision, not a
code change.

### Smaller, and each already written down where it bites

- **Live browser coverage is opt-in.** 5 of the 7 skipped tests need
  `@playwright/test` plus a cached Chromium; the other 2 need a container
  runtime and do run once one is up. `docs/verified.md` has the commands.
  Playwright is deliberately not a devDependency.
- **A run produces no output until it finishes.** `LaneRunner` has no streaming
  hook, so `offstage run -- npm test` is silent between the routing line and the
  result. Fixing it is a contract change that has to work identically for a
  container and a VM copying files back.
- **`offstage doctor --prune`.** A `SIGKILL` of the offstage process can leave a
  container running. Listing and removing `offstage-*` containers is a small
  feature — but it would make `doctor`, documented as "probes, never mutates",
  able to mutate.
- **The 2-VM ceiling is per repository** unless `OFFSTAGE_VM_SLOT_DIR` names one
  absolute path. Apple's limit is per host.
- **`failures[]` covers Playwright, Vitest and Jest only.** Deliberate
  abstention; `docs/reporter-coverage.md` has the checklist for adding a fourth.
