# Wiring offstage into Codex

Codex gets the same four tools Claude Code gets, over the same stdio MCP server.
Nothing about the behaviour differs between the two agents — both call
`src/cli/api.ts`, which is also what `offstage run` calls.

## 1. Register it

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.offstage]
command = "npx"
args = ["-y", "--package=@viraatdas/offstage@latest", "offstage-mcp"]
```

Nothing to build or clone — the first call fetches the package. Pin a version by
replacing `@latest`.

To drive a local checkout instead, build it once (`npm ci` runs the build
through `prepare`) and use a real absolute path — Codex does not expand `~` or
resolve relative paths here:

```toml
[mcp_servers.offstage]
command = "node"
args = ["/absolute/path/to/offstage/dist/mcp/index.js"]
```

Restart Codex. `offstage_doctor`, `offstage_route`, `offstage_run` and
`offstage_probe` appear in its tool list.

## 2. Tell it when to reach for them

Codex has no skill system, so the trigger has to live in a prompt file. Add this
to the repository's `AGENTS.md` (or `~/.codex/AGENTS.md` for every repository):

```markdown
## Browser, UI and macOS app work

Before running any command that could open a window or steal focus — Playwright,
Puppeteer, Cypress, WebDriver, anything with `--headed` or `headless: false`,
screen or video capture, `xcodebuild`, `xcrun simctl`, XCUITests, or launching a
built `.app` — use offstage instead of running it directly.

- `offstage_route` first when unsure: it is free, executes nothing, and explains
  which lane the command would use.
- `offstage_run` to actually run it. Most commands come back `headless`, meaning
  they were already safe to run in place — that is the expected answer, not a
  failure to isolate.
- `status: 'skipped'` means nothing ran anywhere because the substrate was
  missing. Show the user the `fix` line. Do not re-run the command directly to
  get past it, and do not pass `lane: "headless"` to force it — offstage refuses
  that, and the refusal is the feature.
- `failed` means the tests ran and something was red; `errored` means the run
  cannot be trusted. Only the second one is worth retrying.
```

## Without MCP

Every tool has a CLI equivalent with identical behaviour, so a Codex session
that shells out is not second-class:

```bash
offstage route --json -- npx playwright test
offstage run --json -- npx playwright test
offstage doctor --json
offstage probe --json MyApp.xcodeproj
```

`--json` puts the envelope on stdout and every human line on stderr, so
`offstage run --json -- npm test | jq .status` is safe to parse.
