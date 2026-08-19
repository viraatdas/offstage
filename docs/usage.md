# Using offstage

Four commands. The same four things are available as MCP tools, backed by the
same code — `src/cli/api.ts` is the only dispatch path in the project, so an
agent and a human cannot get different answers for the same command.

## Install

```bash
npm i -g @viraatdas/offstage       # both binaries on your PATH
npx @viraatdas/offstage doctor     # or run it without installing
```

From a clone:

```bash
git clone https://github.com/viraatdas/offstage && cd offstage
npm ci                 # the `prepare` script builds dist/ as part of this
npm link               # puts `offstage` and `offstage-mcp` on your PATH
```

`dist/` is a build output and is not committed; `prepare` builds it on any
install, including `npm install github:viraatdas/offstage`. The published
package ships `dist/` already built, so nothing is required of you there.

## `offstage route -- <command>`

Says where a command would go. Executes nothing — not the command, not the
repository's config files.

```console
$ offstage route -- npx playwright test --headed
command:    npx playwright test --headed
lane:       container
confidence: high
reason:     The command asks for a headed browser, which means a real window
            and stolen focus if it runs here; the container lane opens that
            window against an Xvfb virtual display instead.
signals:
  - argv: --headed
```

`confidence: low` is a real answer, not a hedge: it means the repository decides
its own headedness at runtime and offstage will not evaluate the expression to
find out. Pass `--headed` or `--headless` on the command itself to settle it.

## `offstage run -- <command>`

Classifies, dispatches, and writes the normalized result.

```console
$ offstage run -- npx vitest run
→ headless lane — No display is involved at all: vitest in its ordinary node
  environment opens no window.

PASSED  headless lane  3.1s  exit 0
  the command ran and reported success

run:        .offstage/runs/20260818T222228807Z-533188
log:        .offstage/runs/20260818T222228807Z-533188/command.log
result:     .offstage/runs/20260818T222228807Z-533188/result.json
```

| Flag | Meaning |
| --- | --- |
| `--cwd <dir>` | repository root to run against (default: current directory) |
| `--lane <lane>` | force `headless`, `container` or `vm` instead of the router's choice |
| `--timeout <ms>` | wall-clock budget; exceeding it is `errored`, never `failed` |
| `--headed` | "give me a real browser window" — goes to the container lane |
| `--json` | emit the `LaneResult` envelope on stdout, human output on stderr |

Exit codes come from the contract: `0` passed, the command's own code for
`failed`, `70` for `errored`, `69` for `skipped`. CI can therefore tell "your
tests are red" from "offstage could not run them".

### `--lane` is an override, not a bypass

Asking for *more* isolation than the router chose always works. Asking for less
does not: `--lane headless` on a command the router routed to `container` or
`vm` is **refused**, nothing is executed, and the result is `errored` with the
fix in `diagnostics`. There is deliberately no flag that overrides this — a
headed browser appearing on your desktop is the one outcome offstage exists to
prevent.

```console
$ offstage run --lane headless -- npx playwright test --headed
ERRORED  headless lane  0ms  exit none

diagnostics:
  - Refused: --lane headless would have run this command in place, on your
    real screen, but the router routed it to the container lane. Nothing was
    executed.
```

## `offstage doctor`

Per-lane availability and the exact command that fixes each gap. It probes and
never mutates: it will not start Colima, install Tart, or pull an image.

```console
$ offstage doctor
offstage 0.1.0 — node v22.14.0, darwin/arm64

  ✓ headless  available

  ✗ container unavailable
      No usable container runtime, so headed browser work has nowhere safe to run…
      fix: orb start
```

Doctor exits `0` whether or not lanes are missing — it is a report. What matters
is that a missing lane makes `run` refuse work rather than fall back.

## `offstage probe <path>`

Answers the question that decides whether macOS app testing is a weekend or a
month: can a disposable, ad-hoc-signed VM test this app, or does a host-side
signing lane have to be built first? Accepts an `.xcodeproj`, `.xcworkspace`,
`.app`, `.dmg`, an `.entitlements` file, or a directory containing one.

Read three things, not one:

- the **verdict** — `adhoc-ok` or `needs-signing-lane`;
- the **confidence** — a `low`-confidence `adhoc-ok` means "found no blocker",
  not "proved there is none";
- each trigger's **certainty** — `known` is a fact from the registry,
  `namespace-heuristic` is a very likely guess about an unrecognized
  `com.apple.developer.*` key.

`--no-external-tools` keeps it to a pure filesystem read: no `codesign`, no
`hdiutil`, no `security`. Fewer sources, and `low` confidence more often.

[`docs/signing-lane.md`](signing-lane.md) has the reasoning behind the verdicts.

## As MCP tools

```bash
claude mcp add offstage -- npx -y @viraatdas/offstage@latest offstage-mcp
```

Or, to drive a local checkout you are editing:

```bash
claude mcp add offstage -- node /absolute/path/to/offstage/dist/mcp/index.js
```

That registers `offstage_doctor`, `offstage_route`, `offstage_run` and
`offstage_probe`. See [`docs/codex.md`](codex.md) for the Codex equivalent.

The Claude Code plugin works the same way:
`/plugin marketplace add viraatdas/offstage`, then
`/plugin install offstage@offstage`. A plugin install only *clones* — it runs no
`npm install` and no build — which is why the server is declared as
`npx -y @viraatdas/offstage@latest offstage-mcp` rather than a path into the
plugin directory. The first call fetches the package; later ones are cached.

`offstage_run` returns the full outcome — the routing decision, the run id, the
path to `result.json`, and the `LaneResult` — plus any screenshot the container
lane captured, as MCP image content.

## Where a run lives

Each run owns `.offstage/runs/<id>/` in the repository under test:

```
.offstage/runs/20260818T222228807Z-533188/
  command.log     combined stdout+stderr, streamed while the command ran
  result.json     the normalized envelope, validated on the way out and in
  screen.png      container lane only: what the virtual display showed
```

Run ids are timestamp-prefixed, so `ls .offstage/runs` is already in
chronological order. The directory is self-contained: archive it or delete it.
