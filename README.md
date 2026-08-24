# offstage

[![CI](https://github.com/viraatdas/offstage/actions/workflows/ci.yml/badge.svg)](https://github.com/viraatdas/offstage/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@viraatdas/offstage)](https://www.npmjs.com/package/@viraatdas/offstage)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Give your coding agent its own invisible Mac desktop.**

Agents can do real GUI work now: `xcodebuild test` against a real scheme,
booting an iOS simulator, launching your built `.app` and clicking through it,
watching a headed Chromium reproduce a layout bug. Left alone, every one of
those seizes your display and your keyboard. offstage inspects each command
and sends it where it belongs:

```bash
npm i -g @viraatdas/offstage

offstage doctor                        # which lanes work on this machine
offstage route -- npx playwright test  # where would this go? (nothing runs)
offstage run   -- npx playwright test  # send it there, get one normalized result
```

| Your agent wants to… | Where it runs | Your screen |
| --- | --- | --- |
| `npm test`, `vitest`, most commands | in place, already headless | never touched |
| `npx playwright test --headed`, watch a browser | a Linux container with Xvfb | never touched |
| `xcodebuild`, `xcrun simctl`, XCUITests, `open -a`, `osascript`, launch a built `.app` | **a second, logged-in macOS account**: its own window server, framebuffer, keyboard/mouse stream | never touched |
| mount a `.dmg`, run an installer, anything that changes the machine | **refused**, no isolation can honestly contain that | nothing runs at all |

That third row is the point: a full macOS GUI session your agent drives
(screenshot what it sees, click, type, drag, read apps) while you keep
working. Works standalone (above) and as an agent tool for **Claude Code**,
**Codex**, and **opencode** (setup below).

## The three lanes

| Lane | What runs it | Used for |
| --- | --- | --- |
| `headless` | nothing extra, runs in place | Playwright/Puppeteer without `--headed`. Already safe. |
| `container` | a Linux container with Xvfb | `--headed`, `headless: false`, WebGL/GPU flags, extension loading. |
| `session` | a second logged-in macOS account | `xcodebuild`, `xcrun simctl`, XCUITests, `open -a`, `osascript`. macOS-native work that opens windows but doesn't touch the machine itself. |

macOS has no Xvfb and cannot have one; what it does have is multiple
simultaneous GUI sessions via fast user switching, which is what the session
lane uses. Asking for *more* isolation than the router picked always works
(`--lane container`); asking for less is refused with no override.
If a lane's substrate isn't available, the run stops and tells you the fix.
offstage never falls back to running the command on your real screen.

A command that names something which would change the machine itself, an
installer, a `.dmg`/`.pkg`, or `hdiutil`, is refused instead of routed
anywhere. Session isolation shares your OS and disk with you, so it can't
honestly contain that, and offstage has no lane that can. The refusal applies on
every lane and there is no flag that overrides it.

### What the refusal actually checks

Two things, independently. Either one on its own refuses.

**The program.** offstage resolves `argv[0]` to a real file the way the lane
would execute it, then asks what that file is. Four ways in, and the signal
tells you which one caught it:

| What you type | How it is identified | The signal you get |
| --- | --- | --- |
| `installer` | the literal name | `argv: installer` |
| `deploy-tool`, a symlink sitting on `PATH` | `PATH` walk, then `realpath` | `argv: deploy-tool (resolves to installer)` |
| `./setup-helper`, a symlink to `/usr/sbin/installer` | `realpath` | `argv: setup-helper (resolves to installer)` |
| `./nice-name`, `cp`ed from `/usr/sbin/installer` | SHA-256 of the bytes | `argv: nice-name (identical copy of installer)` |

The first three rows apply to every tool the router knows, not just the refused
ones: a symlink named `run-thing` pointing at `/usr/bin/osascript` routes to the
session lane and says `argv: run-thing (resolves to osascript)`.

The fourth row is narrower on purpose. Hashing is scoped to `installer` and
`hdiutil`, the two tools where being wrong is unrecoverable. It exists because a
copy keeps no link back to its origin: `realpath` points at the copy itself and
the basename is whatever the copier chose, so only the content is honest. Size
is compared first, so nothing gets hashed unless it is already exactly as long
as one of those two, and anything over 8 MiB is never read at all.

The `PATH` walk is `stat` only. No `which`, no shell, no subprocess: first
executable regular file in `PATH` order wins, bounded to 64 directories, which
is the file `execa` would go on to run.

**The arguments.** A token naming a `.pkg` or a `.dmg` refuses on its own,
whatever the program is, because the payload is the dangerous part. `echo
Foo.pkg` is refused, deliberately.

```console
$ ln -s /usr/sbin/installer ./setup-helper
$ offstage route -- ./setup-helper -pkg Foo.pkg -target /
command:    ./setup-helper -pkg Foo.pkg -target /
lane:       REFUSED (no lane can isolate this)
confidence: high
reason:     setup-helper (resolves to installer): a symlink, a rename, or a
            byte-identical copy does not change what this binary does. It
            applies a macOS installer package to a target volume, which is a
            deliberate change to the machine it runs on. The session lane is
            only a second account on your own OS and disk, and offstage has no
            lane that isolates that, so it refuses to run this rather than
            risk your machine. Run it directly yourself if you accept the
            risk.
signals:
  - argv: no browser, GPU or macOS-native signal found
  - argv: setup-helper (resolves to installer)
  - argv: Foo.pkg

offstage will refuse to run this automatically, on any lane. See reason above.
```

A shell's `-c` and an interpreter's `-c`/`-e` are read as text, so
`sh -c "installer -pkg Foo.pkg -target /"` is refused on what is inside the
string.

### What it does not catch

All three were run against the real binaries, not assumed:

- **A script file.** `sh deploy.sh`, where `deploy.sh` runs the installer, is
  not refused. Neither is `./deploy.sh`. Deciding would mean interpreting the
  script, and no static classifier does that reliably. Makefiles, npm scripts
  and compiled binaries are opaque for the same reason.
- **A modified copy.** Append one byte to a copy of `installer` and the digest
  stops matching, so the program check misses it. `./tweaked -pkg Foo.pkg` is
  still refused, but by the `.pkg` argument rather than by the program, and
  `./tweaked --help` is not refused at all.
- **A copy of a GUI tool.** Content matching covers the two refused tools only,
  so `cp /usr/bin/osascript ./copied-osa` then `./copied-osa -e '…'` is not
  recognized as `osascript` and routes headless, which means in place. The
  symlink and rename cases *are* caught. Copying a system binary under a new
  name to dodge the router is not something offstage can see, and it is not
  something a static classifier can be made to see.

So the refusal is a guard against *naming* these tools, not a sandbox, and it is
not where the safety comes from. The lanes are, and none of them claims to
contain a change to the machine itself. That is exactly why this is a refusal
instead of a fourth lane.

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
`computeruse`) logged in **in the background**, its own window server, its own
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
4. **Pre-grants both TCC permissions** (Screen Recording and Accessibility) by
   writing rows shaped exactly like System Settings' own into
   `/Library/Application Support/com.apple.TCC/TCC.db`, carrying the daemon's
   code requirement. This needs **Full Disk Access** on the terminal running
   setup (SIP otherwise blocks even root from opening that database); without
   it the script prints why and falls back to manual toggles. The script probes
   before writing and never fails the install over this.
5. **Installs the binary** into the helper account's own home
   (`~/.offstage/bin/offstage-sessiond`) and **bootstraps the LaunchAgent**
   into its GUI domain, then shows the fast-user-switching menu so what remains
   is one click.

The whole root script is printed before it runs, you are about to type a
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
own socket, no password, no admin prompt behind your back. A swapped binary
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
artifacts directory, which the lane opens per run, including anything the
command leaves there, an `.xcresult` bundle or video included.

### Input never touches your screen

Input is posted with `CGEvent.post(tap: .cgSessionEventTap)`, the per-session
entry point; the window server routes it to that session's key window and
nowhere else. The global HID tap always routes to the console session, your
screen, and is unreachable by construction. The daemon refuses input entirely
(`on-console`) if its own session is somehow the one on screen, failing closed;
and (`no-target`) when nothing there has focus.

## Commands

```bash
offstage doctor                                  # per-lane availability + fixes
offstage route  -- <cmd> [--headed] [--cwd dir]  # which lane, why, executes nothing
offstage run    -- <cmd> [--lane L] [--timeout ms] [--headed] [--cwd dir]
offstage probe  <path>                           # signing verdict for a macOS app target

offstage session status                          # account/session/socket/daemon/grants; exit 69 if not ready
offstage session setup [flags]                   # the one-command install (above)
offstage session share <dir> / unshare <dir>     # grant/revoke read-only tree access
offstage session screenshot [--out f] [--max px] # capture the HELPER session's display
offstage session input '<json actions>'          # or: click X Y / type "text" / key "cmd+q"
offstage session launch <app> [--fresh] [--wait-ms ms]  # open an app and WAIT until it registers; reports its pid
offstage session apps                            # apps running in the helper session
offstage session update                          # rebuild + swap the daemon, no password
```

Every command takes `--json`: the JSON envelope goes to stdout, human lines to
stderr, so `offstage run --json -- npm test | jq .status` works. Exit codes:
`run` maps 0 passed / command's code failed / 70 errored / 69 skipped;
`status` exits 0/69 so scripts can gate on it; bad invocations exit 64.

Coordinates for `click`/`input` are **points**, not pixels, divide a pixel
coordinate by the screenshot's reported scale.

## For agents

Working *on* this repository? Read [`AGENTS.md`](AGENTS.md) first.

offstage is first a tool *for* agents: the same operations are MCP tools over
stdio, so Claude Code, Codex and opencode can all call them.

- **Claude Code plugin**: `/plugin marketplace add viraatdas/offstage` then
  `/plugin install offstage@offstage`: ships the skill and the MCP server,
  no build step.
- **Claude Code CLI**: `claude mcp add offstage -- npx -y --package=@viraatdas/offstage@latest offstage-mcp`
- **Codex** (`~/.codex/config.toml`):

  ```toml
  [mcp_servers.offstage]
  command = "npx"
  args = ["-y", "--package=@viraatdas/offstage@latest", "offstage-mcp"]
  ```

- **opencode** (`opencode.json`, project or `~/.config/opencode/`):

  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "offstage": {
        "type": "local",
        "command": ["npx", "-y", "--package=@viraatdas/offstage@latest", "offstage-mcp"]
      }
    }
  }
  ```

Tools: `offstage_doctor`, `offstage_route`, `offstage_run`, `offstage_probe`,
plus `offstage_session_status`, `offstage_session_launch`,
`offstage_session_screenshot`, `offstage_session_input`,
`offstage_session_apps`. There is deliberately no setup tool over MCP: setup
runs `sudo` and needs a human at a terminal. An agent's loop for GUI work:
**launch** (waits until the app registers) → screenshot → decide → input →
screenshot, points not pixels, never drive the console session.

And the rule that keeps it honest, worth pasting into any project's AGENTS.md:

```markdown
Before running anything that could open a window or steal focus: Playwright/
Puppeteer/Cypress/WebDriver, --headed, screen/video capture, xcodebuild,
xcrun simctl, open/-a, osascript, launching a built .app: use the offstage
MCP tools. status:'skipped' means the substrate is missing: report the fix,
never re-run the command directly to get past it, and never launch apps or run
GUI commands outside offstage: that puts them on the user's screen.
```

## Probe

`offstage probe MyApp.xcodeproj` answers one question before you promise
anyone a macOS test setup: `adhoc-ok`, every requested entitlement is
satisfied by ad-hoc signing, so `codesign -s -` is enough and no Apple
credentials are needed anywhere; or `needs-signing-lane`, the app declares
restricted entitlements (protected resources, virtualization, hypervisor) that
only a provisioning-profile-backed Developer ID carries, and getting that
identity to the signing step is a much larger project.

This is a fact about the app's entitlements, so the answer holds however you
run the tests. offstage does not sign anything and has no signing lane; the
probe is here so nobody commits to a date before knowing which of the two jobs
they signed up for. Read `confidence` before repeating a verdict: `low` means
"found no blocker", not "proved there is none".

## Result shape

Every lane returns the same contract (`src/contract/index.ts`):
`status` is `passed` | `failed` | `errored` | `skipped`, failed means the
command ran and was red (retrying wastes time), errored means the run itself
can't be trusted (retry), skipped means the substrate was missing (nothing ran
anywhere). `failures[]` is populated for **Playwright, Vitest and Jest only**;
everything else comes back with an empty list, a full `command.log`, and a
diagnostic saying nothing was recognized, abstention beats fabrication.
Each run persists a validated `result.json` under `.offstage/runs/<id>/`.

## Case study: GestureEngine, driven end to end

GestureEngine is a real macOS utility: a trackpad-gesture engine whose app is
an `LSUIElement` menu-bar tool. It is exactly the kind of thing an agent wants
to test, and exactly the kind of thing that used to seize your screen. With
offstage, the whole loop runs from one terminal while you keep working:

```bash
$ offstage run -- swift test -c release            # passed | headless | in place
$ offstage run -- ./Scripts/build-app.sh           # passed | headless | in place
$ offstage session launch --fresh build/GestureEngine.app
  ✓ launched "build/GestureEngine.app" in the helper session: registered after 1.2s
    GestureEngine pid 13836 [dev.viraat.GestureEngine]
$ offstage session screenshot --max 1000           # its window, on the hidden desktop
$ offstage session input '[{"type":"click","x":1178,"y":157}]'
$ offstage session screenshot                      # toggle flipped: Listening → Paused
```

Nothing appeared on screen at any point; every screenshot in that sequence is
the *other* account's desktop.

### Installing your own app into the guest account

The refusal row above is about *distributable artifacts*: `.dmg` mounts,
`.pkg` installers, anything whose job is rewriting the machine both accounts
share. Your own app under development is different: it's just another GUI
process, and it runs happily on the second account straight from your build
directory (`session launch build/App.app`), exactly as GestureEngine does
above.

If you want it "installed" into the guest anyway, skip the installer and copy
the bundle into the helper account's own Applications folder, no sudo, no
refusal:

```bash
offstage run --lane session -- sh -c 'mkdir -p /Users/computeruse/Applications && cp -R build/GestureEngine.app /Users/computeruse/Applications/'
offstage session launch --fresh /Users/computeruse/Applications/GestureEngine.app
```

Three practical notes from doing this for real:

- Use the helper account's absolute home path
  (`/Users/computeruse/...`); inside the session lane, `$HOME` is an
  unresolved shell expansion to the router and relative paths resolve against
  the helper's home, not yours.
- Kill old instances before relaunching (`offstage run --lane session --
  pkill -x MyApp`): LaunchServices gets confused by several copies of one
  bundle id registering at once.
- A freshly copied bundle can take tens of seconds to register while macOS
  verifies the new file: pass `--wait-ms 60000` instead of retrying.

Two lessons from driving it shaped this release:

- **Menu-bar apps are invisible to naive app lists.** `LSUIElement` apps get
  macOS's `.accessory` activation policy, so an app list that only reports
  regular apps makes every launch of such a tool look like a failure. An agent
  that saw "launched but not running" relaunched six times, then abandoned
  isolation and opened the app on the user's screen. The daemon now lists
  accessory apps too (each entry carries its `policy`), and `session launch`
  waits until the app actually registers instead of trusting `open`'s exit
  code.
- **`NSWorkspace` lies from a daemon.** The first fix polled `NSWorkspace`,
  which served frozen snapshots in this context: Calculator frontmost, menu
  bar reading "Calculator", list saying nothing existed. The daemon now reads
  Launch Services directly (`lsappinfo`), which is always current.

## Status, what has actually been verified

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
boundary lives in `src/contract/index.ts`, `isAvailable()` never throws,
`run()` never throws, and neither ever falls back to the user's real screen.
Tests live in `tests/`; `tests/fixtures/**` is sample code the lanes execute,
excluded from collection and the TS program.

```
src/contract/     lane + result contract, run-directory helpers
src/router/       classify(command) -> lane + reason
  signal.ts         what one observation is
  views.ts          expand a command into everything worth inspecting
  flags.ts          read one argv token, whole tokens only
  bins.ts           the binaries the router recognizes, by name
  signals.ts        collect the evidence, and read the argv itself
  macos.ts          macOS GUI work, and the refusals
  tools.ts          Playwright / Vitest / Cypress / Puppeteer defaults
  webdriver.ts      WebDriver, which has to be read rather than guessed
  configs.ts        what a file on disk says about `headless`
  inspect.ts        the read-only filesystem seam
src/lanes/        headless | session | container implementations
src/session/      host side of the session lane: discovery, RPC client, setup
src/probe/        entitlements probe: is ad-hoc signing enough for this app?
src/cli/          api.ts (doctor/route/run/probe), session.ts (bring the lane
                  up), session-control.ts (drive it), index.ts, render.ts
src/mcp/          the MCP server, over the same API
native/sessiond/  the Swift daemon (its own README has the wire protocol)
docker/           the Xvfb image for the container lane
skills/           Claude Code skill
tests/            vitest suites + fixture corpus
```

## License

MIT
