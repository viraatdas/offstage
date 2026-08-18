# Reporter coverage: Playwright, Vitest, Jest — and nothing else

offstage extracts structured failures (`LaneResult.failures[]`) from three test
reporters. Run anything else — Mocha, pytest, `go test`, `cargo test`, RSpec,
Cypress, `node --test`, Karma, AVA, `bun test`, Maven Surefire, ESLint, `tsc`,
`xcodebuild` — and `failures[]` comes back empty.

That is a decision, not a gap someone forgot to close. This document says what
the decision is, what it costs you, what it does *not* cost you, and what it
would take to add a fourth reporter.

## The rule: recognize or abstain

A parser that guesses is worse than one that returns nothing. `failures[]` is
read by agents, and an agent that is handed `{ file: 'src/auth.ts', line: 42 }`
will go and edit line 42 of `src/auth.ts`. If that entry was reconstructed from
a line the parser did not really understand, the agent edits working code, on
the strength of a machine-readable field that looked authoritative.

So the headless lane recognizes three specific reporter formats by their exact
header lines, and returns `[]` for everything else. The contract says this is
legal: `failures[]` may be empty next to `status: 'failed'`, and the lane puts
the tail of the log in `diagnostics` when it happens (see `LaneFailure` in
[`src/contract/index.ts`](../src/contract/index.ts)).

## What is recognized

| Reporter | Header it prints | Extracted |
| --- | --- | --- |
| Playwright `list` / `line` | `  1) a.spec.ts:3:1 › suite › title ────` | test, file, line, message |
| Vitest default | ` FAIL  a.test.ts > suite > title` | test, file, message, line (from `❯` frame) |
| Jest default | `  ● suite › title`, under a `FAIL a.test.js` banner | test, file (from the banner), message, line (from the stack, only when the frame prints the path the same way the banner did) |

A line number is attached only when it came from the same printed path as the
file. Jest prints its banner relative and its stack frames absolute, so a Jest
failure usually arrives with a file and no line — which is the right trade: the
alternative is a line number borrowed from a helper or a matcher frame, pointing
an agent at code that is not the test.

Implementation: [`src/lanes/headless/parse.ts`](../src/lanes/headless/parse.ts).
It is a pure function over text — no filesystem, no clock, no subprocess — so
the whole boundary is testable against transcripts without installing any of
these tools.

Between them, those three cover very nearly everything offstage's headless lane
is actually asked to run: the lane exists for web test commands, and web test
commands are overwhelmingly Playwright, Vitest or Jest.

## What you get for every other tool

Nothing is hidden and nothing is lost. Only the *structured* extraction is
skipped:

| | Unrecognized reporter |
| --- | --- |
| `status` | still correct — `passed` / `failed` / `errored` come from the exit code, never from parsing |
| `exitCode` | still the command's own exit code |
| `logPath` → `command.log` | complete, byte-for-byte, streamed to disk while the command runs |
| `diagnostics` | a line naming the reporters this lane recognizes, then the tail of the log verbatim |
| `failures[]` | `[]` |

The diagnostic is explicit rather than silent, because "no failures parsed" and
"no failures happened" must never look the same:

```
Exited 1. No output matched a reporter this lane recognizes (Playwright, Vitest,
Jest), so failures[] is empty and the tail of command.log follows verbatim.
```

A red `pytest` run is therefore still a red run, with the right exit code, the
whole log on disk, and the assertion text right there in `diagnostics`. What you
lose is the machine-readable `file`/`line` pair, not the information.

## Why not ask each tool for JSON instead

Because offstage runs your command, verbatim. `LaneRequest.command` is an argv
that is spawned as given — it is never rewritten, and nothing is appended to it.
Injecting `--reporter=json` (or `--json`, or `--reporter json`, or
`-reporter=json`, depending on the tool) would mean:

- **guessing the flag per tool anyway** — the same per-tool knowledge this
  document exists to bound, just moved to argv construction where a wrong guess
  makes the command fail instead of returning nothing;
- **clobbering the user's own choice** — a repo that configures a reporter in
  `playwright.config.ts` or passes its own `--reporter` would silently get a
  different one;
- **changing what the human sees** — several tools write JSON to stdout, so
  `command.log` would stop being the output you would have seen in your own
  terminal, which is the one thing it is for.

Parsing human output best-effort, and abstaining loudly when it does not parse,
keeps the command honest. The lane runs what you asked it to run.

## Verified, not asserted

The claim "everything else abstains" is checked against a corpus of real
transcripts in [`tests/fixtures/reporters/unsupported/`](../tests/fixtures/reporters/unsupported),
each of which must yield exactly `[]`. Pinned by
[`tests/reporter-coverage.test.ts`](../tests/reporter-coverage.test.ts):

- `ava.txt` — AVA default reporter
- `bun-test.txt` — `bun test`
- `cargo-test.txt` — `cargo test`, libtest default
- `cypress.txt` — Cypress run mode (Mocha-derived)
- `eslint.txt` — ESLint `stylish`
- `go-test.txt` — `go test`, including the tab-separated `FAIL\tpkg\t0.004s` summary
- `karma.txt` — Karma + Jasmine
- `maven-surefire.txt` — Maven Surefire
- `mocha.txt` — Mocha `spec`
- `mocha-colored.txt` — Mocha `spec` with ANSI colour, which must not create a match
- `node-test-spec.txt` — `node --test`, spec reporter
- `pytest.txt` — pytest
- `rspec.txt` — RSpec `progress`
- `tap.txt` — TAP 13 (`node --test --test-reporter=tap`, tape)
- `tsc.txt` — `tsc` diagnostics
- `xcodebuild.txt` — `xcodebuild test` / XCTest

The same test also fails if a fourth recognizer is added to `parse.ts` without
updating this document — the design decision cannot drift without someone
deciding to change it.

## Known leak: a bare `●` bullet

Jest's failure marker is `●` at the start of a line, and the parser accepts it
with no further Jest context. Any failing command whose output contains a `●`
bullet therefore produces a fabricated `failures[]` entry. Two real cases, both
pinned as fixtures in [`tests/fixtures/reporters/known-leaks/`](../tests/fixtures/reporters/known-leaks):

- **`next build`** (`next-build.txt`) prints `●  (SSG)  prerendered as static
  HTML …` in its route-table legend, so a failed Next.js build reports a
  "failing test" called `(SSG)      prerendered as static HTML (uses
  generateStaticParams)`.
- **`systemctl status`** (`systemctl.txt`) prints `● docker.service - …`, so any
  command that shells out to it and then fails reports the unit as a failing
  test.

Neither entry carries a `file`, so nothing points an agent at a line of source —
but the entry should not be there at all, and "recognize or abstain" is not true
until it is gone. The fix belongs in `parse.ts` (owned by the headless-lane
node): require a `●` bullet to sit under a `FAIL <path>` banner, which is how
Jest always prints one, and abstain otherwise. The two fixtures are marked
`it.fails` in the test — closing the leak turns them red, and the fix is to
delete the `.fails` marker along with this section.

## Adding a fourth reporter

Not forbidden — just deliberate. The checklist:

1. Add the recognizer to `matchHeader()` in `src/lanes/headless/parse.ts`,
   anchored on a header line that reporter prints and nothing else does.
2. Add a transcript with a real failure and assert what is extracted, including
   the repository-relative `file`.
3. Add a transcript from a *neighbouring* tool to
   `tests/fixtures/reporters/unsupported/` and prove it still abstains. A
   recognizer that also matches the tool next door is a fabrication engine.
4. Add the reporter to the table above and to the recognized list in the
   `status === 'failed' && failures.length === 0` diagnostic in
   `src/lanes/headless/runner.ts`.
5. Check the dedupe key still holds: most reporters print each failure twice,
   once inline and once in the end-of-run summary.
