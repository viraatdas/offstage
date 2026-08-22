# offstage

[![CI](https://github.com/viraatdas/offstage/actions/workflows/ci.yml/badge.svg)](https://github.com/viraatdas/offstage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@viraatdas/offstage)](https://www.npmjs.com/package/@viraatdas/offstage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Run browser and macOS test commands without them stealing your screen.**

An agent runs `npx playwright test --headed` and a Chromium window jumps in
front of what you were doing. Or it runs `xcodebuild test` and a Simulator
takes over your desktop. offstage looks at the command, decides where it can
actually run safely, and sends it there instead. Most commands are already
headless and just run in place: offstage's job is to catch the ones that
aren't.

```bash
npm i -g @viraatdas/offstage

offstage doctor                        # which lanes work on this machine
offstage route -- npx playwright test  # where would this go? (nothing runs)
offstage run   -- npx playwright test  # send it there, get one normalized result
```

## The three lanes

| Lane | What runs it | Used for |
| --- | --- | --- |
| `headless` | nothing extra, runs in place | Playwright/Puppeteer without `--headed`. Already safe. |
| `container` | a Linux container with Xvfb | `--headed`, `headless: false`, WebGL/GPU flags, extension loading. |
| `session` | a second logged-in macOS account | `xcodebuild`, `xcrun simctl`, XCUITests, `open -a`, `osascript`. macOS-native work that opens windows but doesn't touch the machine itself. |

Anything that could change the machine itself — an installer, a `.dmg`/`.pkg`,
`hdiutil` — is refused outright instead of routed anywhere. Session isolation
shares your OS and disk with you, so it can't honestly contain that, and
offstage has no lane that can. Nothing runs, on any lane, and the reason says
why.

macOS has no Xvfb and cannot have one; what it does have is multiple
simultaneous GUI sessions via fast user switching, which is what the session
lane uses instead of a VM. Asking for *more* isolation than the router picked
always works (`--lane container`); asking for less is refused with no override.
If a lane's substrate isn't available, the run stops with the fix — offstage
never falls back to running the command on your real screen.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/viraatdas/offstage/main/scripts/install.sh | sh
```

Installs Node.js guidance if missing, installs `@viraatdas/offstage` globally,
checks your PATH, runs `offstage doctor`, and on macOS offers the session-lane
setup below. Or by hand:

```bash
npm i -g @viraatdas/offstage && offstage doctor
```

From a clone: `npm ci && npm link`.

## The session lane: one-time setup

The session lane drives a second, ordinary macOS account (default
`computeruse`) logged in **in the background** — its own window server, its own
framebuffer, its own keyboard/mouse stream. A small Swift daemon,
`offstage-sessiond`, runs inside that account and listens on a unix socket at
`/tmp/offstage-session/<uid>.sock`; your session talks to it over that socket.
See [`native/sessiond/README.md`](native/sessiond/README.md) for the daemon's
wire protocol and build details.

```bash
sudo offstage session setup --create
```

One command does everything macOS allows:

1. **Creates the helper account** non-interactively, with a generated
   24-character password (shown once, stored mode `0600` at
   `~/.config/offstage/session.json`). An empty password could never log in
   under FileVault, so a real one is generated instead.
2. **Compiles the Swift daemon** from `native/sessiond/` (`swiftc`, shipped
   with the Xcode Command Line Tools).
3. **Suppresses the first-login Setup Assistant** (`.skipbuddy` plus the
   "already seen" keys), because nobody should click through region/Apple
   ID/Siri panes for an account driven by a robot.
4. **Pre-grants both TCC permissions** — Screen Recording and Accessibility —
   by writing rows shaped exactly like System Settings' own into
   `/Library/Application Support/com.apple.TCC/TCC.db`, carrying the daemon's
   code requirement. This needs **Full Disk Access** on the terminal running
   setup (SIP otherwise blocks even root from opening that database); without
   it the script prints why and falls back to manual toggles. The script probes
   before writing and never fails the install over this.
5. **Installs the binary** into the helper account's own home
   (`~/.offstage/bin/offstage-sessiond`) and **bootstraps the LaunchAgent**
   into its GUI domain, then shows the fast-user-switching menu so what remains
   is one click.

The whole root script is printed before it runs — you are about to type a
password, and "trust me" is not an acceptable thing for a tool to say.

**What's left for you:** switch to the helper account from the user menu once,
then switch straight back. That first login starts a daemon that is already
trusted. Confirm with:

```bash
offstage session status    # exits 0 when the lane is ready
```

If either permission still shows ungranted, your terminal lacked Full Disk
Access during setup: grant FDA to your terminal app and re-run setup, or
switch into the helper account once and approve both toggles for
`offstage-sessiond` in System Settings → Privacy & Security.

### Optional: zero-touch reboots with `--auto-login`

After every reboot the helper session is gone until someone logs it in once.
`--auto-login` arms macOS auto-login (`sysadminctl`) for the helper account, so
every boot brings it up by itself; you just log into your own account as usual.
Two honest trade-offs: FileVault refuses auto-login outright (setup reports
that rather than pretending), and the helper desktop appears briefly at boot.
The daemon refuses input while its session is the console one, so nothing can
type on your screen through it either way.

### Why the daemon can update itself

The binary lives where the account that runs it owns it, so
`offstage session update` is a file copy the daemon performs on itself over its
own socket — no password, no admin prompt behind your back. A swapped binary
would not inherit the TCC grants: the record carries a code requirement, and a
replacement that fails it gets nothing.

### Filesystem access is separate from TCC

The helper account is a different uid and your home is `0750`, so grant read
access one tree at a time:

```bash
offstage session share ~/code/myrepo    # read-only ACL, traverse-only on ancestors
offstage session unshare ~/code/myrepo  # revoke exactly what share granted
```

Share never grants write. A run writes to its own `.offstage/runs/<id>`
artifacts directory, which the lane opens per run — including anything the
command leaves there, an `.xcresult` bundle or video included.

### Input never touches your screen

Input is posted with `CGEvent.post(tap: .cgSessionEventTap)`, the per-session
entry point; the window server routes it to that session's key window and
nowhere else. The global HID tap always routes to the console session — your
screen — and is unreachable by construction. The daemon refuses input entirely
(`on-console`) if its own session is somehow the one on screen, failing closed;
and (`no-target`) when nothing there has focus.

## Commands

```bash
offstage doctor                                  # per-lane availability + fixes
offstage route  -- <cmd> [--headed] [--cwd dir]  # which lane, why — executes nothing
offstage run    -- <cmd> [--lane L] [--timeout ms] [--headed] [--cwd dir]
offstage probe  <path>                           # signing verdict for a macOS app target

offstage session status                          # account/session/socket/daemon/grants; exit 69 if not ready
offstage session setup [flags]                   # the one-command install (above)
offstage session share <dir> / unshare <dir>     # grant/revoke read-only tree access
offstage session screenshot [--out f] [--max px] # capture the HELPER session's display
offstage session input '<json actions>'          # or: click X Y / type "text" / key "cmd+q"
offstage session apps                            # apps running in the helper session
offstage session open <app> [-- args]            # sugar for run --lane session -- open …
offstage session update                          # rebuild + swap the daemon, no password
```

Every command takes `--json`: the JSON envelope goes to stdout, human lines to
stderr, so `offstage run --json -- npm test | jq .status` works. Exit codes:
`run` maps 0 passed / command's code failed / 70 errored / 69 skipped;
`status` exits 0/69 so scripts can gate on it; bad invocations exit 64.

Coordinates for `click`/`input` are **points**, not pixels — divide a pixel
coordinate by the screenshot's reported scale.

## For agents

Working *on* this repository? Read [`AGENTS.md`](AGENTS.md) first.

To let an agent *use* offstage, register the MCP server (stdio):

- **Claude Code plugin**: `/plugin marketplace add viraatdas/offstage` then
  `/plugin install offstage@offstage` — ships the skill and the MCP server,
  no build step.
- **Claude Code CLI**: `claude mcp add offstage -- npx -y --package=@viraatdas/offstage@latest offstage-mcp`
- **Codex** (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.offstage]
  command = "npx"
  args = ["-y", "--package=@viraatdas/offstage@latest", "offstage-mcp"]
  ```

Tools: `offstage_doctor`, `offstage_route`, `offstage_run`, `offstage_probe`,
plus `offstage_session_status`, `offstage_session_screenshot`,
`offstage_session_input`, `offstage_session_apps`. There is deliberately no
setup tool over MCP — setup runs `sudo` and needs a human at a terminal. An
agent's loop for GUI work: screenshot → decide → input → screenshot, points not
pixels, never drive the console session.

## Probe

`offstage probe MyApp.xcodeproj` answers one question before you promise
anyone a macOS test setup: `adhoc-ok` — every requested entitlement is
satisfied by ad-hoc signing, so a disposable VM works today, no Developer ID
needed — or `needs-signing-lane` — the app declares restricted entitlements
(protected resources, virtualization, hypervisor) that only a
provisioning-profile-backed identity carries, which is a much larger project.
Read `confidence` before repeating a verdict: `low` means "found no blocker",
not "proved there is none".

## Result shape

Every lane returns the same contract (`src/contract/index.ts`):
`status` is `passed` | `failed` | `errored` | `skipped` — failed means the
command ran and was red (retrying wastes time), errored means the run itself
can't be trusted (retry), skipped means the substrate was missing (nothing ran
anywhere). `failures[]` is populated for **Playwright, Vitest and Jest only**;
everything else comes back with an empty list, a full `command.log`, and a
diagnostic saying nothing was recognized — abstention beats fabrication.
Each run persists a validated `result.json` under `.offstage/runs/<id>/`.

## Status — what has actually been verified

Tests pass on machines without the substrates present (they skip loudly, not
fail), so "suite green" ≠ "lane works". What has been run for real:

| Lane | Live evidence |
| --- | --- |
| `headless` | real child processes, real timeouts, real log backpressure |
| `container` | a genuinely headed Chromium inside the container while the host's visible-app set stayed byte-identical before/after |
| `session` | all five verification rungs inside the real `computeruse` session: screenshots of the hidden desktop; clicks landing on intended Calculator buttons (`75`); typed strings, drag and scroll confirmed by before/after screenshots; a headed Chromium completing a Playwright spec while the console user kept typing into their own apps. Delivery checked against the window server's own log: every synthetic event landed in the helper session, zero reached the console. |

Setup-specific evidence (measured 2026-08-21, macOS 26.3): the system TCC db
holds both services path-keyed; root-with-Full-Disk-Access can write it
(probed with a non-mutating `BEGIN IMMEDIATE; ROLLBACK`); the daemon's exported
requirement matches stored grant blobs **byte-for-byte**; `sysadminctl
-autologin` exists and FileVault refuses it on this machine; CGSession-based
switching is gone on 26.3, so the one human switch remains honest. Not yet
done: executing the full sudo script on a fresh machine end to end.

## Development

```bash
npm ci                          # Node 20+
npm run build                   # tsc -> dist/
npm test                        # vitest; skips gated on absent substrates
npm run typecheck
bash native/sessiond/smoke.sh   # builds and drives the session daemon locally
```

Conventions that matter (full rules in [`AGENTS.md`](AGENTS.md)): ESM +
NodeNext (`import type`, `.js` extensions); vitest globals off; code touching
the outside world takes the impure part as an injected seam; every module
boundary lives in `src/contract/index.ts` — `isAvailable()` never throws,
`run()` never throws, and neither ever falls back to the user's real screen.
Tests live in `tests/`; `tests/fixtures/**` is sample code the lanes execute,
excluded from collection and the TS program.

```
src/contract/     lane + result contract, run-directory helpers
src/router/       classify(command) -> lane + reason
src/lanes/        headless | session | container implementations
src/session/      host side of the session lane: discovery, RPC client, setup
src/probe/        entitlements probe
src/screen/       RFB client used by the container lane
src/cli/, src/mcp/  the CLI, and the MCP server over the same API
native/sessiond/  the Swift daemon (its own README has the wire protocol)
docker/           the Xvfb image for the container lane
skills/           Claude Code skill
tests/            vitest suites + fixture corpus
```

## License

MIT
