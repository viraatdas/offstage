# offstage — roadmap

The build was an 11-node plan. **All eleven nodes are done**, along with twelve
follow-up hardening passes, and in 0.3.0 a fourth lane — the macOS **session**
lane. The suite is green from a clean clone (`npx vitest run`: 33 files, 1029
passed, 2 expected fail, 5 skipped with a container runtime running).

What remains is not design work. It is evidence — for the session lane first,
and for the vm lane behind it.

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
- **the session lane (0.3.0)** — `native/sessiond/` (the Swift daemon),
  `src/session/` (discovery, RPC client, setup), `src/lanes/session/`, the
  router's macOS split, `offstage session …` and four MCP tools. Design in
  [session-lane.md](session-lane.md).
- **followup-1..12** — hardening: the two-tsconfig split, dependency pins, the
  4MB capture budget, the reporter-coverage boundary, WebDriver capability
  reading, video-vs-screen capture, runtime-computed capability honesty, and log
  backpressure.

## Left

### The session lane has never run inside the helper session — this is the headline

The fourth lane landed in 0.3.0: a second, logged-in macOS account
(`computeruse`, uid 502) sitting in the background with its own window server,
framebuffer and HID stream, driven through a small Swift daemon
(`offstage-sessiond`) over a unix socket. It replaces the vm lane as the default
for every macOS-native command that opens a window but changes nothing —
`xcodebuild`, `xcrun simctl`, XCUITests, `open -a`, `osascript`, `safaridriver`.
The vm lane keeps exactly the work that could change the machine: `.dmg`,
`.pkg`, `installer`, `hdiutil`. Design in [session-lane.md](session-lane.md);
the daemon's own notes in [`native/sessiond/README.md`](../native/sessiond/README.md).

What is done: the daemon, the host-side discovery/RPC/setup modules, the lane,
the router rules, the CLI (`offstage session status|setup|share|screenshot|
input|click|type|key|apps|open`), four MCP tools, and the skill section that
tells an agent to loop screenshot → input → screenshot.

What is left is **evidence**, and it is the same shape as the vm lane's gap.
The verification ladder from `session-lane.md`, with its current state:

| Rung | State |
| --- | --- |
| 1. daemon compiles; `--once` round-trips every op | ✅ done — `native/sessiond/smoke.sh`, but as uid 501, the developer's own session |
| 2. LaunchAgent bootstrapped into the helper session; `hello` reports `onConsole: false`; `open -a TextEdit` starts under the helper uid while the console shows nothing | **Left** |
| 3. Screen Recording granted → `screenshot` returns a PNG of a desktop that is not the console's | **Left** |
| 4. Accessibility granted → `input` types into TextEdit and the next screenshot shows the text | **Left** |
| 5. `offstage run --lane session -- npx playwright test --headed` against a shared repo: a Chromium window in the helper session, `failures[]` parsed, console untouched | **Left** |

Rung 2 is the load-bearing one: everything else assumes a background session
keeps a live framebuffer and spawns GUI apps into it. Until it is climbed,
README and [verified.md](verified.md) say "daemon verified live on the
developer's own session; not yet verified inside the helper session" in those
words.

### The vm lane has never driven a real macOS guest

(The container lane no longer belongs on this list: as of 2026-08-18 it has run
a genuinely headed Chromium with the host screen verifiably untouched — see
[docs/verified.md](verified.md).)

Narrower than it was, now that the session lane has taken `xcodebuild` and the
simulators: what is left here is installers and anything else that changes the
machine. Every claim about the vm lane rests on 28
recorded fixtures and `xcresulttool`'s published JSON Schema 0.1.0 — not on a
bundle a real run produced. Closing it means installing Tart and the
`tart-xcode-runner` plugin, preparing a golden image, and driving one XCUITest
through `offstage run`. Until someone does that, the README, `docs/verified.md`
and `DECISIONS.md` all say "fixture-tested only" in those words.

### ~~Publish, so the plugin does not need a build step~~ — done in 0.2.0

Published as **`@viraatdas/offstage`** (the unscoped `offstage` belongs to an
unrelated package). `.mcp.json` now declares the server as
`npx -y @viraatdas/offstage@latest offstage-mcp`, so a plugin install — which
only clones — gets a working server with no build step.

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
