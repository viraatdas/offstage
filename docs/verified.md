# What has actually been verified

offstage routes commands to substrates that may or may not exist on any given
machine, and most of its test suite runs with those substrates absent. That is
deliberate — the suite has to pass on a laptop with no Docker and no Tart — but
it means "the tests are green" and "this lane works" are different claims.

This file records the difference. Update it when the evidence changes, not when
the intent does.

## The machine this was recorded on

| | |
| --- | --- |
| Date | 2026-08-18 |
| OS | macOS 26.3 (25D125) |
| Arch | arm64 (Apple silicon) |
| Node | v26.7.0 |
| npm | 11.19.0 |
| offstage | 0.1.0 |

## Per-lane status

| Lane | Verified live here | Verified against fixtures | Never exercised |
| --- | --- | --- | --- |
| `headless` | ✅ real child processes, real vitest runs, real timeouts and log backpressure | ✅ recorded Playwright/Vitest/Jest reporter output | — |
| `container` | ❌ no container runtime is running on this machine | ✅ run-plan construction, runtime detection, guest-path mapping, failure parsing | the Xvfb image has been **built and run** on this host previously (n3), but not on this date |
| `vm` | ❌ Tart is not installed and no VM has been booted | ✅ 28 recorded fixtures: `tart-runner` stdout, `xcodebuild.log`, `Result.xcresult` shapes, `xcresulttool` JSON | a real macOS guest, a real golden image, a real XCUITest run |
| `probe` | ⚠️ partly — real file parsing against real `.xcodeproj` / `.app` fixtures, and one real `codesign` invocation by hand (see below) | ✅ hand-written entitlements plists covering every verdict path; `codesign` and `hdiutil` are driven through an injected runner so the suite is platform-independent | a real signed Developer ID app, and a real `hdiutil` mount |

`offstage probe` was run by hand against the unsigned `AdhocApp.app` fixture
with external tools enabled, and real `codesign` did run: it reported that it
could not read entitlements, the probe fell back to file-based evidence, and the
verdict came back `adhoc-ok` at **low** confidence with both facts in `notes`.
That is the intended behaviour for "found no blocker" — but it is one manual
invocation on one machine, not suite coverage.

The **vm lane's parsers were validated against `xcresulttool`'s published JSON
Schema 0.1.0 and hand-recorded fixtures, not against a bundle a real run
produced.** That is the largest single gap in the project, and it is worth
stating plainly rather than burying: the adapter is written to the documented
contract of [`novotnyllc/tart-xcode-runner`](https://github.com/novotnyllc/tart-xcode-runner)
(plugin v0.4.11) and its README, and has never driven a guest.

## `offstage doctor`, verbatim

Captured on the machine above, unedited:

```console
$ offstage doctor
offstage 0.1.0 — node v26.7.0, darwin/arm64

  ✓ headless  available

  ✗ container unavailable
      No usable container runtime, so headed browser work has nowhere safe to
      run. the docker CLI is installed but its daemon is unreachable (context
      "orbstack"): failed to connect to the docker API at
      unix:///Users/viraat/.orbstack/run/docker.sock; check if the path is
      correct and if the daemon is running: dial unix
      /Users/viraat/.orbstack/run/docker.sock: connect: no such file or
      directory — OrbStack is installed but not running; colima is installed
      but no profile is running ("default" is Stopped); podman is not
      installed.
      fix: orb start

  ✗ vm        unavailable
      Tart is not installed: no `tart` binary on PATH. The tart-xcode-runner
      plugin is not installed: no tart-runner script found in the Claude Code
      or Codex plugin caches.
      fix: brew tap openai/tools && brew trust --tap openai/tools && brew install openai/tools/tart (alternative formula: brew install cirruslabs/cli/tart)
           claude plugin marketplace add novotnyllc/marketplace && claude plugin install tart-xcode-runner@novotnyllc — or, if it is already installed somewhere else, set OFFSTAGE_TART_RUNNER=<plugin-root>/skills/tart-xcode-runner/references/tart-runner

2 of 3 lanes cannot run right now (container, vm). offstage will refuse work
that needs them rather than run it on your screen.
```

This is the honest state of a normal laptop, and it is worth reading as a
feature rather than an embarrassment: two of three lanes are unavailable, and
the consequence is that offstage **refuses** the work those lanes would have
taken — it does not run it here instead.

## The suite

```console
$ npm ci && npm run build && npm test
Test Files  26 passed (26)
     Tests  769 passed | 2 expected fail | 7 skipped (778)
```

- **2 expected fail** — negative tests asserting that something *does* fail.
- **7 skipped** — every one of them is gated on a substrate that is absent
  here, and each says so rather than passing vacuously:

| Skipped | Gate | To run them |
| --- | --- | --- |
| `HeadlessLane driving real Playwright` (2) | `@playwright/test` + a cached Chromium | `npm i -D @playwright/test && npx playwright install chromium` |
| `a headless browser really does record video` (3) | same | same |
| `against a real container runtime` (2) | a reachable Docker/Colima/Podman daemon | `orb start` or `colima start` |

Playwright is deliberately **not** a devDependency: it would add a ~150MB
browser download to every clean install of a project whose own tests do not
need a browser. The cost is that the live browser checks are opt-in, and this
file is where that trade-off is recorded rather than hidden.

## End to end

`tests/e2e.test.ts` fakes nothing: it stages a real fixture repository, runs the
real `offstage` command tree against it, and reads the `result.json` that lands
on disk. It holds four things that no unit test can:

1. `route` and `run` agree — the lane the router promised is the lane that ran.
2. The persisted `result.json` re-validates against the contract on the way back
   in, and equals the envelope the CLI printed.
3. A red suite comes back `failed` (with parsed failures), not `errored` — the
   distinction an agent uses to decide whether retrying is worth anything.
4. `--lane headless` on `xcodebuild test` executes **nothing**, and the run
   directory records the refusal.

It also spawns the built `dist/cli/index.js` as a real process, which is what
proves the `bin` declarations in `package.json` resolve to files that exist.
That check reports itself as skipped (loudly, on stderr) when `dist/` has not
been built, since `npm test` on a clean clone legitimately runs before
`npm run build`.

## What would change these rows

- **container → verified live**: start a runtime (`orb start`), then
  `npm test` — the 2 gated tests build the Xvfb image and run a headed browser
  in it. Expect the first run to take several minutes for the image build.
- **vm → verified live**: install Tart and the tart-xcode-runner plugin, prepare
  a golden image, and run an XCUITest through `offstage run`. Until someone does
  that, every claim about the vm lane rests on fixtures.
