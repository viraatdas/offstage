# What has actually been verified

offstage routes commands to substrates that may or may not exist on any given
machine, and most of its test suite runs with those substrates absent. That is
deliberate — the suite has to pass on a laptop with no Docker and no Tart — but
it means "the tests are green" and "this lane works" are different claims.

This file records the difference. Update it when the evidence changes, not when
the intent does.

> **2026-08-21, the `vm` lane was removed.** Everything below about it is the
> historical record of what was measured (and never measured) before that
> happened, and it is left exactly as it was written: rewriting it to erase a
> lane that existed would make this file describe a past that did not occur.
> offstage now routes macOS-native work that opens a window but changes
> nothing to the `session` lane, and refuses outright anything that could
> change the machine (an installer, a `.dmg`/`.pkg`, `hdiutil`) on every
> remaining lane. See `docs/roadmap.md` for why.

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
| `session` | ⚠️ partly — the daemon compiles and every op round-trips over the socket, but **as uid 501, the developer's own console session** (`native/sessiond/smoke.sh`, details below). Nothing has yet run inside the helper session | ✅ discovery parsers against recorded `ioreg`/`dscl` output, the RPC client against a scripted socket, the lane's whole availability ladder and run path through injected seams | the helper session itself: no run, no screenshot and no injected event has happened in the `computeruse` session |
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

## The session lane's ladder, and where it stops

`docs/session-lane.md` sets out five rungs. **Rungs 1 and 2 are passed. Rungs
3–5 are not yet.** Rung 1 was measured against a daemon running as uid 501 —
the developer's own session — and proves the protocol, the spawn semantics and
the capture path. Rung 2 was measured on 2026-08-20 against the real thing:
`offstage session setup` compiled the daemon, the printed root script ran under
`sudo`, and `launchctl bootstrap gui/502` started `offstage-sessiond` as
`computeruse` (pid 39310) inside session 258. `hello` reported
`onConsole: false`, a 1728×1117-point display at 2×, and both TCC grants
absent. `offstage run --lane session -- open -a TextEdit` then started
TextEdit under uid 502 (`ps` shows `computeruse 48372 …/TextEdit`),
`offstage session apps` listed it beside Setup Assistant, and `IOConsoleUsers`
still showed `viraat` on console throughout. The run's own diagnostics said
"No screenshot was taken: Screen Recording is not granted" — the lane degraded
exactly as designed rather than failing the run.

One bug surfaced on that first live run and is fixed: the post-install hello
poll slept on an **unref'd** timer, so Node exited with "unsettled top-level
await" while waiting for the socket. `defaultSleep` now keeps the loop alive
and `tests/cli.session.test.ts` holds the regression.

| Rung | State |
| --- | --- |
| 1. daemon compiles; `--once` round-trips every op | ✅ passed, on uid 501 |
| 2. LaunchAgent bootstrapped into the helper session; `hello` reports `onConsole: false`; `open -a TextEdit` starts under the helper uid | ✅ passed, 2026-08-20, session 258 / uid 502 |
| 3. Screen Recording granted → `screenshot` returns a PNG of a desktop that is not the console's | ✅ passed, 2026-08-20 — a 3456×2234 PNG of the `computeruse` desktop (TextEdit + its own Dock) captured while `viraat` stayed on console |
| 4. Accessibility granted → `input` types into an app and the next screenshot shows it | ✅ passed, 2026-08-21, session 258 / uid 502 — Screen Recording and Accessibility both granted, a PNG of the hidden desktop captured, two clicks at point coordinates landed on the intended Calculator buttons (`75`), discrete key events entered `8675`, and one `type` action entered `8675309`. The console session's display never changed. |
| 4b. `input` drag and scroll | **not verified.** `click`, `key` and `type` are proven (rung 4). `drag` has been observed both moving a window and doing nothing at the same coordinates, and an A/B against the earlier timing did not separate the two, so its implementation is a best effort rather than a fix. `scroll` has never been exercised at all. |
| 5. `offstage run --lane session -- npx playwright test --headed` against a shared repo | not yet |

### A real finding: input must go through the SESSION event tap

Rung 4 exposed the one thing fixture tests could never have caught, and it took
two attempts to get right.

The daemon first posted synthetic events with `CGEvent.post(tap: .cghidEventTap)`,
the global HID tap. From a **background** session that is wrong: the window
server routes HID-tap events to whichever session is *on the console* (the
user's), so `cmd+space` opened no Spotlight and keystrokes reached no TextEdit
in the helper session, even though the daemon reported them posted.

The first fix was `CGEvent.postToPid(<frontmost app pid>)`. That was **also
wrong**, and the reason it looked right is worth recording: it was "verified" by
a test process posting an event to *itself*, which always succeeds and requires
no permission at all. It proves nothing about cross-process delivery. Measured
properly against the window server's own delivery log
(`log show --predicate 'process == "WindowServer"'`, which names the destination
of every keyboard event), `postToPid` produced **zero** deliveries: the events
went into a void and nothing ever appeared in the target app.

What actually works is `CGEvent.post(tap: .cgSessionEventTap)`. The session tap
is the per-session entry point, so an event posted by a process inside session N
enters session N's stream and is routed by the window server to that session's
key window. Confirmed in the log: deliveries landed on the helper session's
frontmost app, with nothing reaching the console session.

Two consequences the code now encodes:

- There is no tap parameter and no fallback. The HID tap is unreachable from
  `Input.swift`, because the only thing it can do from here is type on the
  user's real screen.
- `input` refuses outright when the daemon's own session is the console session
  (`code: "on-console"`), and the on-console check fails *closed*: if the
  session dictionary cannot be read, it reports on-console and refuses. The
  lane's promise is structural, not a matter of trusting the caller.

### The refusal can be evaded by renaming the binary, and partly still can

Found by an adversarial pass, 2026-08-21. The machine-changing refusal
(`installer`, `hdiutil`, `.pkg`, `.dmg`) keyed off the basename of argv[0] and
the literal text of the arguments, so two evasions worked:

- **Behind a wrapper.** `xargs installer -target /` routed to `headless` with no
  refusal at all, because the peeler stopped at `xargs` and never saw the
  binary. `parallel` was the same. Not only an installer problem:
  `xargs npx playwright test --headed` also routed to `headless`, so the same
  gap could have put a browser window on the user's screen. Fixed by peeling
  argument wrappers; covered by tests.
- **By renaming.** A symlink to `/usr/sbin/installer` under any other name, with
  a package path that carries no `.pkg` extension, was not refused. Verified
  against the real system binary. Fixed by resolving argv[0] through the
  inspector's filesystem seam and matching the resolved basename too, which
  keeps `classify()` free of process spawning so the purity promise still holds.

**Still open, and it cannot be closed by name:** a *copied* binary.
`cp /usr/sbin/installer /tmp/x/some-name` leaves no filesystem link back to the
original, so `realpath` resolves to the copy itself and the basename is whatever
it was called. Measured: still not refused. Catching it would need content or
code-signature inspection, which is a materially heavier mechanism than name
resolution. Recorded here rather than implied away.

Both fixed evasions were untested before this: grepping the router's adversarial
and classify suites found no coverage of any wrapper or of argv[0] resolution.

### How TCC records are actually keyed, corrected

An earlier note in this file, and the README, claimed a grant "follows the
signing identity, not the path". That was wrong, and it was wrong in the way
worth recording: it generalised from a single observation (a build at a
different path reporting `accessibility: true`) without testing the case that
would have falsified it.

Measured, 2026-08-21, from `SecurityPrivacyExtension`'s own state dump after the
binary moved:

    kTCCServiceScreenCapture  /usr/local/libexec/offstage/offstage-sessiond      full
    kTCCServiceScreenCapture  /Users/computeruse/.offstage/bin/offstage-sessiond none
    kTCCServiceAccessibility  /usr/local/libexec/offstage/offstage-sessiond      full
    kTCCServiceAccessibility  /Users/computeruse/.offstage/bin/offstage-sessiond none

and from `tccd`: `TCCDEvent: ... identifier_type=Path, identifier=<the path>`.

So a record is keyed to a **path**, and carries a **code requirement** the
binary at that path has to keep satisfying. The two halves fail differently:

- Rebuild at the same path, same Developer ID identity: the requirement still
  matches, the grant survives. Verified by reinstalling a rebuilt binary over
  the same path with the grant intact.
- Rebuild at the same path with a different signature: `tccd` logs
  `Failed to match existing code requirement` and the grant stops applying.
  Verified when the ad-hoc build was replaced by a Developer ID one.
- Move the binary: the old path keeps its record, the new path has none, and
  both permissions must be granted again. Verified when `session setup` moved
  the daemon into the helper account's home.

The security argument still holds, for the right reason: a swapped binary at the
granted path is refused because it fails the requirement, not because grants are
path-independent.

### Two further bugs rung 4 only exposed once it could be seen

Getting a screenshot turned "input does nothing" into two specific defects, both
invisible without one.

**Ambient modifiers were never cleared.** `post()` assigned modifier flags only
when the caller asked for some (`if !flags.isEmpty { e.flags = flags }`). A
freshly created `CGEvent` inherits the session's *current* modifier state, so a
stray or stuck modifier silently rewrote every unmodified event: a plain `3`
arrived as `cmd+3`, and a typed string arrived as a run of keyboard shortcuts,
which is why typing appeared to do nothing at all. Caught on screen when
Calculator switched to Programmer mode instead of entering a digit. The flags
are now always assigned, empty set included.

**`type` packed several characters into one event.** Sending up to 20 UTF-16
units per `keyboardSetUnicodeString` event works in an NSTextView but is not
portable: an app that reads only the first character drops the rest. Typing
`8675309` at Calculator entered `8`. It now sends one event per character, split
on grapheme clusters so an emoji or combining sequence is not cut in half.

`bash native/sessiond/smoke.sh` builds the daemon into a temp directory, starts
it as the current uid against a private socket directory, drives it, and stops
it. It passed on the machine above, uid 501, exercising:

- `hello` — protocol 1, uid matches, display `1728×1117 @2x`, permissions read
  without prompting (`{screenCapture: true, accessibility: true}` for *that*
  session's grants, which say nothing about the helper session's).
- `access` — readable directory, unreadable directory (`readable: false`),
  missing path (`exists: false`).
- `run` — `started` event with a pid; stdout and stderr merged in order; exit
  code passthrough; `argv[0]` resolved through `PATH`; `cwd` honoured and
  `DISPLAY` stripped; timeout reporting `timedOut: true` / `exitCode: null` and
  killing the whole process group promptly (SIGTERM, not the 5 s SIGKILL
  grace); `spawn-failed` for a missing binary and for a missing `cwd`; a client
  disconnect mid-run killing the child.
- `apps` — the regular-activation-policy app list.
- `screenshot` — a real PNG, and `maxDimension` honoured.
- `input` — **validation only**: an unknown key name comes back
  `bad-request, performed: 0`, and a non-array `actions` is refused. **No event
  was posted.** The smoke test deliberately never injects into a live session,
  because on this machine that session is the developer's own.
- protocol edges — unknown op, missing op, non-JSON, and a request over 1 MiB
  all `bad-request`.
- `--once` — answers one `hello` over `nc -U` and exits.
- `request-permissions` — **skipped**, deliberately: it would raise TCC prompts
  on the visible screen.

The `offstage session status` output on this machine, with nothing installed,
is the one in `docs/usage.md`: account present, session logged in and off the
console, socket absent, `fix: offstage session setup`.

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

Recorded at 0.1.0, before the session lane existed; the same machine at 0.3.0
reports four lanes, with `session` unavailable and
`fix: offstage session setup`.

This is the honest state of a normal laptop, and it is worth reading as a
feature rather than an embarrassment: most lanes are unavailable, and the
consequence is that offstage **refuses** the work those lanes would have taken
— it does not run it here instead.

## The suite

The suite's numbers depend on what is running on the machine, which is the
point — tests gated on an absent substrate skip rather than pass vacuously.

```console
$ npm ci && npm run build && npm test      # with no container runtime
Test Files  26 passed (26)
     Tests  807 passed | 2 expected fail | 7 skipped (816)

$ orb start && npm test                    # with a container runtime up
Test Files  26 passed (26)
     Tests  809 passed | 2 expected fail | 5 skipped (816)
```

The two extra passes are the container lane's live tests: they build the Xvfb
image and run a headed browser in it. CI runs the first form, because a hosted
runner has no daemon.

At 0.3.0, with the session lane and its tests added, the vm lane and its 1660
lines of tests removed, and a container runtime up, the same command reports:

```console
$ orb start && npx vitest run
Test Files  33 passed (33)
     Tests  932 passed | 2 expected fail | 0 skipped (934)
```

With no container runtime and `@playwright/test` absent, the same command
reports 925 passed and 7 skipped: the skips are the live-substrate tests listed
below, not failures.

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
- **session → verified live**: run `offstage session setup` on a Mac with a
  logged-in helper account, grant Screen Recording and Accessibility to
  `offstage-sessiond` inside that account's session, then climb rungs 2–5 in
  order. Rung 2 alone would settle the load-bearing question — whether a
  background session with `onConsole: false` really spawns GUI apps into its own
  framebuffer.
- **vm → verified live**: install Tart and the tart-xcode-runner plugin, prepare
  a golden image, and run an XCUITest through `offstage run`. Until someone does
  that, every claim about the vm lane rests on fixtures.
