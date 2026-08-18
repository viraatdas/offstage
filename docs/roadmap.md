# offstage — roadmap

The build is a 11-node plan. n0-n5 and twelve follow-up hardening passes are
done, merged and pushed; what is left is the surface that turns the engine into
something an agent can actually call.

## Done

- **n0** — Foundation: scaffold + results contract
- **n1** — Router: classify a command into a lane
- **n2** — Headless lane: run in place, prove no window opens
- **n3** — Container lane: headed web under Xvfb
- **n4** — VM lane: adapter over novotnyllc/tart-xcode-runner
- **n5** — Entitlements probe: is the signing lane required?
- **n7** — MCP server wrapping the lanes. `src/mcp/{index,server,core}.ts` + `tests/mcp.test.ts`;
  a stdio server exposing `offstage_doctor` / `offstage_route` / `offstage_run` / `offstage_probe`
  with zod-validated inputs. `dist/mcp/index.js` builds, so the `offstage-mcp` bin resolves.
  **Deviation to pay back:** it was specified to wrap n6's `src/cli/api.ts`, but n6 never landed,
  so `src/mcp/core.ts` implements lane dispatch itself. When n6 is built, that logic belongs in
  `src/cli/api.ts` and `core.ts` should collapse onto it rather than the two diverging.
  Coverage is thin — 4 tests — so treat it as working, not proven.
- **followup-1..12** — hardening passes: the two-tsconfig split, dependency pins, the 4MB
  capture budget, reporter-coverage boundary, WebDriver capability reading, video-vs-screen
  capture, runtime-computed capability honesty, and log backpressure.

## Left

### n6 — CLI core: offstage run / route / doctor / probe

Depends on: n0, n1, n2, n3, n4, n5 (all done)

Wire the router plus all three lanes behind one CLI that is the engine everything
else calls. This was launched once and produced nothing — the agent stalled
before writing a file — so it starts from scratch. Note that n7 landed first and had to
implement lane dispatch itself in `src/mcp/core.ts`; `src/cli/api.ts` should absorb that
logic and `core.ts` should be reduced to calling it, so there is one dispatch path.

**Done when:** `offstage doctor` reports per-lane availability with the exact fix command on this machine; `offstage route -- <cmd>` prints the lane decision without executing; `offstage run [--lane] [--timeout] -- <cmd>` dispatches, writes `.offstage/runs/<id>/result.json` and exits with a code derived from `LaneResult.status`; `offstage probe <path>` prints the entitlements verdict; `--json` on every command emits the contract envelope on stdout with human output on stderr; CLI tests pass with no container runtime and no tart installed. If the chosen lane is unavailable it must fail loudly with the fix and never fall back to the user's real screen. Business logic stays in the modules it imports; `src/cli/api.ts` exports `doctor()` / `route()` / `run()` / `probe()` returning typed values, which is what the MCP node consumes.

### n8 — Claude Code plugin + skill + Codex wiring

Depends on: n6, n7

Make both agents reach for offstage automatically instead of opening a browser or app on the user's screen.

**Done when:** `.claude-plugin/plugin.json` and `skills/offstage/SKILL.md` install cleanly and the skill description triggers on browser/UI/simulator/app-testing work; `.mcp.json` registers the offstage server fo...

### n9 — End-to-end integration + live smoke

Depends on: n6, n7, n8

Prove the whole path works on this laptop and record exactly which lanes were verified live versus degraded.

**Done when:** `npm ci && npm run build && npm test` pass from a clean clone; an e2e test drives route -> run -> result.json for a headless fixture; real `offstage doctor` output is captured into `docs/verified.m...

### n10 — Opus review pass: correctness, honesty, and the routing thesis

Depends on: n9

Adversarially review the whole assembled codebase and fix what is wrong before it is called done.

**Done when:** Every claim in README.md, docs/verified.md, docs/signing-lane.md and the skill description is checked against the code and corrected where false; the router's policy is validated against adversaria...

