# Review pass — correctness, honesty, and the routing thesis

> **2026-08-21, the `vm` lane this review pass discusses was later removed**
> (see `docs/roadmap.md`). Everything below is left as it was written: it is
> the record of a review that happened while the lane still existed, and
> rewriting it would make it describe a review that did not happen. Commands
> that used to route to `vm` (`hdiutil`, `.dmg`/`.pkg`, `installer`) are now
> refused outright instead.

The last node in the plan is adversarial: read the assembled tree as someone
trying to break its central promise, and fix what is actually wrong rather than
what is merely untidy. This is the record — every finding, its severity, and
whether it was fixed or accepted as a documented risk.

The promise being attacked: **no combination of flags, missing substrates,
timeouts, or error handling causes a window to open on the user's real screen.**

A later adversarial pass found that promise, stated that absolutely, was false —
see [Known bypasses](#known-bypasses) at the end. The accurate version is:

> offstage routes on what it can **read**. Where the deciding fact is in argv,
> in a config file, in a package script, or in an inline script, it is read and
> honoured. Where the fact only exists after a shell expands a variable, or
> inside a file offstage does not parse (a Makefile, a shell script), offstage
> cannot see it — and says so with `confidence: 'low'` rather than reporting
> the confident default.

## Fixed

### 1. `env PWDEBUG=1 npx playwright test` routed to the headless lane — HIGH

`normalizeInvocation` peels transparent wrappers so that `env`, `npx` and
`NODE_ENV=test` do not confuse the classifier. That is right for almost every
prefix and exactly wrong for this one: with `env` and `PWDEBUG=1` peeled away,
every downstream rule saw a plain `playwright test` and routed it to
**`headless`, at `high` confidence**. `PWDEBUG` opens the Playwright Inspector
regardless of what the config says, so this would have put a real window on the
real screen — the exact failure the product exists to prevent, with no hedge in
the reason to warn anyone.

**Fixed** in `src/router/signals.ts` (`envPrefixSignals`): assignments carried
in argv are read where they actually are — `PWDEBUG` (truthy), `HEADLESS=false`
and `HEADED=1` argue container; `HEADLESS=true` argues headless. Still no
`process.env` read: the router's inputs remain the ones its caller can see.

**Also fixed one layer down**, in `detectHeadedRequest`: the headless lane now
refuses such a request itself rather than trusting whoever routed it.

### 2. A whole command hidden inside `sh -c` was invisible — HIGH

`sh -c 'npx playwright test --headed'` is three argv tokens, and the one that
decides the lane is a *string*. The router saw a shell, found no browser signal,
and routed to `headless` (`low` confidence — but the lane still runs it).

**Fixed** in `buildViews`: a `-c` argument to `sh`/`bash`/`zsh`/`dash`/`ksh`/
`fish` (including combined short flags like `-lc`) is tokenized and walked as a
nested view, exactly as a `package.json` script already was. Tokenizing is
reading, not executing, so the no-execution rule is untouched. `detectHeadedRequest`
also now looks inside whitespace-containing tokens as a backstop.

### 3. Nothing stopped a caller from forcing work into the lane with no display — HIGH

`--lane` did not exist before this pass (n6 never landed), and the MCP server's
`run` honoured a `lane` argument by dispatching straight to that lane. An agent
that "helpfully" retried a skipped container run as `lane: "headless"` would
have opened the window.

**Fixed** in `src/cli/api.ts`: over-isolating is honoured (with a diagnostic);
`--lane headless` on a command the router routed to `container` or `vm` is
**refused** — nothing is executed, the result is `errored`, and the diagnostics
name the flag to drop. There is deliberately no override flag. Held by
`tests/cli.api.test.ts` (asserting the lane runner was never called),
`tests/cli.program.test.ts`, `tests/e2e.test.ts` and `tests/mcp.test.ts`.

### 4. Two implementations of lane dispatch — MEDIUM

`src/mcp/core.ts` implemented routing, dispatch and `result.json` writing itself
because it was built before the CLI existed. Two dispatch paths mean an agent
and a human can get different answers about what is safe to run in place, and
the divergence would appear exactly when someone fixed a bug in one of them.

**Fixed**: `core.ts` is now a seam over `src/cli/api.ts` — one router, one
dispatch, one refusal. `tests/mcp.test.ts` asserts the default core enforces the
CLI's refusal, so the two cannot silently separate again.

### 5. A misbehaving lane could take the CLI down with it — MEDIUM

The contract says `run()` never throws and always returns a valid `LaneResult`,
but nothing enforced it at the call site. A lane that threw, or returned an
envelope with a relative `artifactsDir`, would have produced a stack trace
instead of a result.

**Fixed**: `api.run()` catches both cases and returns a contract-valid `errored`
result naming the lane and listing every schema violation. A bug in a lane is
now reported as an untrustworthy run, which is what it is.

### 6. Documentation claimed less than the code did, and more than the evidence did — MEDIUM

README's status table listed every module as "in progress" (all of them were
implemented), and said "nothing here claims to be verified on real hardware yet"
while the headless lane had in fact been verified live and the vm lane had not.
Both directions are dishonest; the second is the dangerous one.

**Fixed**: the status table now records *evidence*, not progress, and
[`verified.md`](verified.md) records per lane what was exercised live versus in
degraded mode, on a named machine, with the verbatim `offstage doctor` output of
that machine. The vm lane is labelled fixture-tested-only in both places.

### 7. `package.json` published two bins that did not exist — MEDIUM

`bin.offstage` pointed at `dist/cli/index.js` while `src/cli/` did not exist.
The shape of the published paths was guarded; their existence was not.

**Fixed**: the CLI exists, and `tests/tsconfig.test.ts` now maps every published
`dist/**` path back to the source that must produce it (checked against `src/`,
so it passes on a clean clone before a build). `tests/e2e.test.ts` spawns the
built `dist/cli/index.js` as a real process when `dist/` is present, and says on
stderr that it skipped when it is not.

## Verified, no change needed

- **Every lane refuses rather than falls back.** `containerLane.run()` and
  `VmLane.run()` both check availability first and return `skippedResult(...)`
  — which carries "nothing was executed" plus the fix — instead of running the
  command anywhere. `skipped` exits 69, distinct from a red test suite.
- **Contract integrity on the error paths.** Timeout and spawn failure both
  produce valid `errored` envelopes (covered by the lanes' own suites); the API
  revalidates every result before writing it, so a violation cannot reach
  `result.json`.
- **Concurrent runs cannot collide.** Run ids are timestamp-plus-random and the
  directory is created before the lane is called; `tests/e2e.test.ts` runs two
  concurrently and asserts distinct directories.
- **Resource hygiene.** Containers run `--rm` and are force-removed by name on
  the timeout path; the VM slot is released in a `finally` on every path,
  idempotently; `hdiutil detach -force` runs in an unconditional `finally` and
  reports a failed detach as a note rather than swallowing it.
- **The no-execution rule holds.** `tests/router.purity.test.ts` still passes
  with the two new readers added here: both parse text, neither evaluates it.

## Accepted risks

Each of these is a real limitation. They are listed rather than fixed because
the fix is worse, larger than this pass, or belongs to a substrate offstage does
not own.

### The vm lane has never driven a real macOS guest

Every claim about it rests on 28 recorded fixtures and `xcresulttool`'s
published JSON Schema. **This is the largest gap in the project.** It is
labelled as such in the README, in `verified.md`, and in `DECISIONS.md`, and the
only thing that closes it is someone installing Tart and running an XCUITest.

### An exported `HEADLESS=false` in the user's shell is not a headed signal

Written into the command (`env HEADLESS=false npx playwright test`) it now
routes to the container. Exported ambiently in the shell, it does not — the
router reads only its declared inputs, and the CLI maps just `PWDEBUG` from the
environment onto a hint.

The asymmetry is deliberate. `PWDEBUG` is honoured by Playwright itself, so it
opens a window unconditionally. `HEADLESS` means whatever a given repository's
config decides it means — and if that config reads it, the router already sees
the expression and returns `confidence: 'low'` with the expression quoted, which
is the documented behaviour for everything computed at runtime. Promoting an
ambient variable to a high-confidence container route would send `npm run build`
to a container for the rest of that shell session.

### A run produces no output until it finishes

Lanes stream to `command.log`, but `LaneRunner.run()` has no streaming hook, so
`offstage run -- npm test` prints the routing decision, then nothing until the
result. For a ten-minute suite that is a poor experience. Fixing it means adding
an output callback to the lane interface — a contract change, and one that has
to work identically for a container and a VM copying files back. Out of scope
here; `--json` consumers are unaffected, and `command.log` can be tailed live.

### `SIGKILL` of the offstage process can leak a container

Every container is `--rm` and the timeout path force-removes by name, but a
`SIGKILL` to offstage itself leaves the container running until it exits on its
own. The fix n3 proposed — `offstage doctor --prune`, listing and removing
`offstage-*` containers — is a small feature, not a correction, and adding a
mutating flag to the one command documented as "probes, never mutates" deserves
its own decision.

### The 2-VM ceiling is per repository unless `OFFSTAGE_VM_SLOT_DIR` is set

Slots live at `<repo>/.offstage/vm-slots`, but Apple's limit on concurrent macOS
guests is per *host*, so two checkouts can between them ask for four. The escape
hatch exists and is documented; making it correct by default means picking a
machine-wide location, which is a decision about where offstage may write
outside a repository.

### `failures[]` covers Playwright, Vitest and Jest only

Deliberate abstention, documented in [`reporter-coverage.md`](reporter-coverage.md)
and stated in the skill so an agent does not read an empty array as "no
failures". Widening it means more recognizers pinned to captured real output,
not looser regexes.

## How to re-run this review

```bash
npm ci && npm run build && npm test
```

The safety claims above are held by tests, not by this document:

| Claim | Held by |
| --- | --- |
| No command that opens a window reaches the headless lane | `tests/router.adversarial.test.ts` |
| The router never executes the repository | `tests/router.purity.test.ts` |
| A low-confidence answer says what it could not read | `tests/router.runtime-capabilities.test.ts` |
| `--lane headless` cannot undo a routing decision | `tests/cli.api.test.ts`, `tests/e2e.test.ts` |
| An agent gets the same answers as a human | `tests/mcp.test.ts` |
| An unavailable lane skips instead of falling back | `tests/lanes.container.test.ts`, `tests/lanes.vm.test.ts`, `tests/e2e.test.ts` |

## Known bypasses

A second adversarial pass — run against the pushed tree, trying specifically to
get window-opening work into the lane with no display — found nine ways through.
Six are now closed and regression-tested in
`tests/router.adversarial.test.ts`; three are boundaries rather than bugs, and
are stated here because a safety tool that hides its limits is worse than one
that has none.

### Closed

| Bypass | Was | Now |
| --- | --- | --- |
| `env -i` / `-u` / `--` / `-S` before `PWDEBUG=1` | headless, the assignment hidden by the option flags | container — `env`'s own options are parsed before the assignments are read |
| `sh -c -- '<script>'`, `sh -c - '<script>'` | headless — `--` was taken as the script | container — separators are skipped to the real command string |
| `sh -c 'npx playwright test $(echo --headed)'` | headless, **high** confidence | container — `--headed)` is no longer hidden by the punctuation stuck to it |
| `node -e 'require("puppeteer").launch({headless:false})'` | headless, **high** confidence, and it *executed in place* | container — an inline script is read exactly like a script on disk |
| `npm run e2e` where `pree2e` opens a window | headless — lifecycle hooks were never read | container — `pre`/`post` hooks are walked with the script |
| `` `echo --headed` ``, `${HEADED:+--headed}`, `H=--headed; … $H` | ran in place | refused by the headless lane, which now scans the text of every token |

### Boundaries — stated, not fixed

**A shell expansion offstage cannot resolve.** `npx playwright test $FLAGS`
might open a window; only the shell that expands `$FLAGS` knows. offstage keeps
the cheap lane and returns `confidence: 'low'` with the expansion quoted — the
same rule it already applies to a config computed at runtime. It does not
report the confident default, and it does not run a shell to find out.

**Indirection through a file offstage does not parse.** `make e2e` where the
Makefile recipe has `--headed`, or `./run.sh` containing one, routes headless:
offstage reads `package.json` scripts, `playwright.config.*`, the vitest config,
and scripts a command names — not Makefiles or arbitrary shell scripts. The
run-time backstop cannot help either, because the flag is in a file, not in
argv. **If your headed run is behind a Makefile target or a shell script, pass
`--headed` to offstage, or run the underlying command directly.** Teaching the
router to read Makefiles is tractable and is the obvious next step here.

**`dotenv -e .env -- playwright test` where `.env` sets `PWDEBUG=1`.** Same
shape: the deciding fact is in a file offstage does not open. Reading env files
requires a new `Inspector` method and is not done.

All three share one root: offstage classifies by reading, and reading has an
edge. The design response is not to start executing things — that would defeat
the safety argument the router rests on — but to be loud about the edge, which
is what `confidence: 'low'` and this section are for.
