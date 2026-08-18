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
| Container runtime | OrbStack, Docker daemon 29.4.0 |
| OS | macOS 26.3 (25D125) |
| Arch | arm64 (Apple silicon) |
| Node | v26.7.0 |
| npm | 11.19.0 |
| offstage | 0.1.0 |

## Per-lane status

| Lane | Verified live here | Verified against fixtures | Never exercised |
| --- | --- | --- | --- |
| `headless` | ✅ real child processes, real vitest runs, real timeouts and log backpressure | ✅ recorded Playwright/Vitest/Jest reporter output | — |
| `container` | ✅ **the headline claim, demonstrated** — a genuinely headed Chromium ran inside the container while the host screen stayed untouched (evidence below) | ✅ run-plan construction, runtime detection, guest-path mapping, failure parsing | a Linux host (the `--user $(id -u)` path), and a run that produces video |
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

## The container lane, demonstrated live

Recorded on the machine above with OrbStack running (`orb start`). This is the
claim the whole product rests on, so it is worth showing rather than asserting.

A project whose `playwright.config.mjs` sets `headless: false` — no offstage
flag passed, the router read the config itself:

```console
$ offstage route -- npx playwright test
lane:       container
confidence: high
reason:     playwright.config.mjs sets headless: false, so this run would open
            a real browser window on your desktop; the container lane gives it
            an Xvfb display to open into instead.

$ offstage run -- npx playwright test
PASSED  container lane  3.7s  exit 0

diagnostics:
  - runtime: Docker daemon 29.4.0 (context "orbstack")
  - image: offstage-web:01aa66c82a23 (built in 3s from docker/offstage-web.Dockerfile)
  - display: :152 at 1280x900x24 on Xvfb inside the container — the host
    display was never opened
  - mounts: /private/tmp/pwtest -> /workspace (ro), <run dir> -> /offstage/artifacts (rw),
    volume offstage-playwright-browsers -> /ms-playwright (rw)
```

Three things were checked, not assumed:

1. **The browser was genuinely headed.** The spec printed
   `browser version: 151.0.7922.34` and `DISPLAY inside the container: :152`,
   and the run's log contains no mention of headless at all.
2. **The host screen was untouched.** The set of visible macOS applications was
   captured before and after the run and diffed: identical. No window appeared,
   and no focus was taken.
3. **The virtual framebuffer is real.** Every container run captures
   `screen.png` — a 1280x900 PNG of what the Xvfb display actually showed.

Populating the browser volume is a one-time step per machine, as designed:
`offstage run --lane container -- npx playwright install chromium` (the
`offstage-playwright-browsers` volume persists across runs, so later runs skip
it and the image stays small).

## `offstage doctor`, verbatim

Captured on the machine above **before** `orb start`, unedited. This is the
state of a normal laptop with nothing running, and it is the more interesting
one: it shows what offstage does when the isolation is not there. (After
`orb start`, the container row flips to `✓ container available` — that is the
run demonstrated in the section above.)

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

The suite's numbers depend on what is running on the machine, which is the
point — tests gated on an absent substrate skip rather than pass vacuously.

```console
$ npm ci && npm run build && npm test      # with no container runtime
Test Files  26 passed (26)
     Tests  805 passed | 2 expected fail | 7 skipped (814)

$ orb start && npm test                    # with a container runtime up
Test Files  26 passed (26)
     Tests  807 passed | 2 expected fail | 5 skipped (814)
```

The two extra passes are the container lane's live tests: they build the Xvfb
image and run a headed browser in it. CI runs the first form, because a hosted
runner has no daemon.

- **2 expected fail** — negative tests asserting that something *does* fail.
- **skipped** — every one is gated on a substrate that may be absent, and each
  says which:

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
