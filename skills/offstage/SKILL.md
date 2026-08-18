---
name: offstage
description: Run browser, UI and macOS app work without taking over the user's screen. Use before any command that could open a window or steal focus — Playwright, Puppeteer, Cypress, WebDriver, `--headed` or `headless: false` runs, screen or video capture, `xcodebuild`, `xcrun simctl`, XCUITests, iOS/macOS simulators, or launching a built `.app`. offstage decides whether the command is already safe to run in place, needs a Linux container with a virtual display, or needs a macOS VM — and refuses to run it on the real screen when the isolation it needs is missing.
---

# offstage

**A window opening on the user's desktop, mid-conversation, is a bug.** Their
keyboard focus is taken, whatever they were doing is interrupted, and they did
not consent to it. offstage exists so that never happens by accident.

## The one thing to know

Most browser test commands are **already headless**. `npx playwright test` opens
no window. Wrapping it in a container buys nothing and costs container startup
on every run. So offstage's most common answer is "run it right here, and here
is why that was already safe" — and that is the answer you should want.

Do not reach for a container reflexively, and do not skip the check because a
command "looks headless". Ask offstage.

## Use it

If the `offstage_*` MCP tools are available, prefer them. Otherwise shell out to
the CLI — identical behaviour, same code path.

| Step | MCP tool | CLI |
| --- | --- | --- |
| Where would this go? (nothing runs) | `offstage_route` | `offstage route -- <cmd>` |
| Run it off-screen | `offstage_run` | `offstage run -- <cmd>` |
| Which lanes work on this machine? | `offstage_doctor` | `offstage doctor` |
| Can a disposable VM test this macOS app? | `offstage_probe` | `offstage probe <path>` |

`route` is free and side-effect-free: it reads argv and a few small config
files and never executes a line of the repository. When you are unsure whether
a command is safe, call it before you call `run` — and definitely before you
reach for a plain `Bash` call.

```
offstage run -- npx playwright test              # headless: runs in place
offstage run -- npx playwright test --headed     # container: Xvfb, not your screen
offstage run -- xcodebuild test -scheme App      # vm: macOS guest
```

## Reading the answer

Every run returns the same envelope, whichever substrate produced it:

- `status` — `passed` / `failed` / `errored` / `skipped`. **`failed` means the
  tests ran and something was red; `errored` means the run cannot be trusted at
  all.** Retrying an `errored` run can help. Retrying a `failed` one just wastes
  the user's time — read `failures[]` and fix the code.
- `skipped` means **nothing ran anywhere**. The substrate was missing. Never
  report a `skipped` run as a pass, and never re-run the command outside
  offstage to "get past it" — that is exactly the screen theft offstage
  prevents. Show the user the `fix` line from `diagnostics` instead.
- `failures[]` is populated for **Playwright, Vitest and Jest only**. Empty for
  Mocha, pytest, `go test`, Cypress, `xcodebuild` and everything else — that is
  deliberate abstention, not a bug. `status` and `command.log` are still true.
- `diagnostics` says what isolation was applied and why. Quote it when the
  answer surprises the user.

## When a lane is unavailable

`offstage doctor` prints the exact command that fixes each gap — `orb start`,
`colima start`, a `brew install`. Give the user that line and stop. Do **not**:

- re-run the command directly with `Bash` because the container would not start;
- pass `--lane headless` to force work past a routing decision (offstage
  refuses it, by design, and there is no flag that overrides the refusal);
- strip `--headed` from the user's command to make it fit the headless lane.

## Confidence is part of the answer

A decision can come back `confidence: 'low'`. That means the repository computes
its own headedness at runtime — `headless: process.env.HEADED !== '1'` — and
offstage will not execute a config file to find out. It keeps the cheap lane and
says so. If the user reports that a window opened anyway, re-run with `--headed`
and it goes to the container lane; that is the intended repair, not a defect.

## What offstage cannot see

offstage routes on what it can **read** — argv, config files, `package.json`
scripts, and a script the command names. Two things fall outside that, and both
matter to you:

- **A Makefile target or a shell script.** `make e2e` or `./run.sh` that hides
  `--headed` inside routes to the headless lane, because offstage does not parse
  those files. If you know the underlying command opens a window, either run
  that command through offstage directly, or pass `--headed` / `headed: true`.
- **A shell expansion.** `npx playwright test $FLAGS` comes back
  `confidence: 'low'` with the expansion quoted. Treat low confidence as "check
  this", not as a verdict.

Reporting this rather than guessing is deliberate. Do not work around it by
running the command outside offstage.

## macOS apps

Before promising a user that their macOS app can be tested in a VM, run
`offstage probe <path to .xcodeproj / .app / .dmg>`. It answers one question:
`adhoc-ok` (a disposable ad-hoc-signed VM is enough) or `needs-signing-lane`
(the app declares entitlements only a real Developer ID can carry — that is a
much larger project). Read `confidence` and each trigger's `certainty` before
repeating the verdict: a `low`-confidence `adhoc-ok` means "found no blocker",
not "proved there is none".
