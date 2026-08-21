# Using offstage

Four commands. The same four things are available as MCP tools, backed by the
same code — `src/cli/api.ts` is the only dispatch path in the project, so an
agent and a human cannot get different answers for the same command.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/viraatdas/offstage/main/scripts/install.sh | sh
# or, by hand:
npm i -g @viraatdas/offstage       # both binaries on your PATH
npx @viraatdas/offstage doctor     # or run it without installing
```

The guided path, the session lane's one-time steps, troubleshooting and
uninstall are in [install.md](install.md).

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
| `--lane <lane>` | force `headless`, `session`, `container` or `vm` instead of the router's choice |
| `--timeout <ms>` | wall-clock budget; exceeding it is `errored`, never `failed` |
| `--headed` | "give me a real browser window" — goes to the container lane |
| `--json` | emit the `LaneResult` envelope on stdout, human output on stderr |

Exit codes come from the contract: `0` passed, the command's own code for
`failed`, `70` for `errored`, `69` for `skipped`. CI can therefore tell "your
tests are red" from "offstage could not run them".

### `--lane` is an override, not a bypass

Asking for *more* isolation than the router chose always works. Asking for less
does not: `--lane headless` on a command the router routed to `session`,
`container` or `vm` is **refused**, nothing is executed, and the result is
`errored` with the fix in `diagnostics`. There is deliberately no flag that overrides this — a
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

## `offstage session <subcommand>`

macOS only. The session lane runs work in a **second logged-in account** whose
display, focus and input are its own — see
[`docs/session-lane.md`](session-lane.md) for the design and
[`native/sessiond/README.md`](../native/sessiond/README.md) for the daemon.
Every subcommand takes `--json`, with the usual split: the envelope on stdout,
every human line on stderr.

```
offstage session status                          # account, session, socket, daemon, TCC grants
offstage session setup [--user U] [--create]     # compile the daemon and install it (needs sudo, once)
offstage session share <dir>                     # read-only ACL for the helper account on a tree
offstage session screenshot [--out f] [--max N]  # capture that session's screen
offstage session input '<json actions>'          # inject events
offstage session click <x> <y> [--button] [--count]
offstage session type <text>
offstage session key <combo>                     # e.g. cmd+shift+t
offstage session apps                            # what is running in that session
offstage session open <app-or-path> [args…]      # = offstage run --lane session -- open …
```

### `status`

Walks the availability ladder and stops at the first rung that fails, printing
the fix for it. **Exits `0` when the lane is available and `69` otherwise**, so
a script can gate on it:

```bash
offstage session status || exit 1
```

```console
$ offstage session status
✗ session lane unavailable — account "computeruse" (uid 502)

  ✓ account          Computer Use, home /Users/computeruse
  ✓ gui session      logged in (session 258)
  ✓ off your screen  yes — it is running in the background
  ✗ socket           /tmp/offstage-session/502.sock (absent)
  ✗ daemon           not answering

  The offstage session daemon is not listening: there is no socket at
  /tmp/offstage-session/502.sock.
  fix: offstage session setup
```

### `setup`

Compiles `offstage-sessiond` with `swiftc` from the sources shipped in
`native/sessiond/`, then runs **one** script as root: it installs the binary
into `/usr/local/libexec/offstage/`, writes the LaunchAgent into the helper
account's `~/Library/LaunchAgents/`, pre-creates the socket directory, and
`launchctl bootstrap gui/<uid>`. The script is **printed in full before it
runs** — you are about to type a password, and a tool should say what for.
Afterwards it waits up to 15 seconds for the daemon to answer `hello` and asks
it to raise the two TCC prompts.

`--create` creates the account when it does not exist. It is added to the same
root script as a `sysadminctl -addUser <user> -fullName "Computer Use"
-password -` line, with an explicit `-UID` chosen from the free uids on this
machine — the LaunchAgent's `gui/<uid>` domain has to be known before the
script is written. You are prompted for the new account's password: an account
created without one has no SecureToken and cannot log in under FileVault.

It **requires a terminal**. `sudo` has to be able to prompt, so setup refuses
when stdin is not a TTY and there is deliberately no MCP tool for it.

Two things are left for a human afterwards, and neither can be automated:

1. Log the helper account in once with fast user switching, then switch back.
   A LaunchAgent only starts inside a GUI session.
2. Switch to it once more and allow **Screen Recording** and **Accessibility**
   for `offstage-sessiond` in System Settings → Privacy & Security. TCC is per
   session and per binary; Apple offers no way to grant either from another
   account or from the command line. `status` reports both.

### `share`

The helper account is a different uid and your home is `0750`, so it cannot
read your repository — and therefore cannot run your tests in it:

```bash
offstage session share ~/code/myrepo
```

That applies `chmod +a` entries: traverse-only (`search`) on each ancestor so
the path is reachable, and read on the tree itself. **It never grants write.**
Everything a run writes goes to `$OFFSTAGE_ARTIFACTS` — the run's own
`.offstage/runs/<id>` directory, which the lane opens to the helper account per
run because the lane owns it. The repository stays read-only, exactly like the
container lane's read-only mount.

### `screenshot`, `input`, `click`, `type`, `key`

```bash
offstage session screenshot --out /tmp/before.png
offstage session click 640 400
offstage session type 'hello world'
offstage session key cmd+s
offstage session screenshot --out /tmp/after.png
```

`--out` writes exactly there; without it the PNG lands in
`.offstage/screenshots/<timestamp>.png` under the current directory and the path
is printed. `--max <pixels>` downscales the longest edge, for agents on a small
image budget.

**Coordinates are points, not pixels**, in the helper display's global space
with the origin at its top-left — the same space `status` reports as `display`.
A screenshot reports its own pixel size and the display's `scale`; divide by
`scale` to get points.

`input` takes the full action array as JSON, which is what `click`, `type` and
`key` build one of:

```bash
offstage session input '[{"type":"move","x":100,"y":100},
                         {"type":"click","x":100,"y":100,"button":"left","count":2},
                         {"type":"type","text":"hi"},
                         {"type":"key","key":"cmd+shift+t"},
                         {"type":"wait","ms":250}]'
```

Injection needs Accessibility and capture needs Screen Recording. Without the
grant the daemon refuses with the exact repair sentence and offstage exits `69`
— nothing silently falls back to your own screen.

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
claude mcp add offstage -- npx -y --package=@viraatdas/offstage@latest offstage-mcp
```

Or, to drive a local checkout you are editing — from inside that checkout:

```bash
npm run dev:register        # builds, then registers it as `offstage-dev`
```

The name is the point. A local build registered as `offstage` displaces the
published server that `.mcp.json` and the plugin both declare, and the
displacement is invisible: same tool names, same version field, different code.
`offstage-dev` sits beside the real one, so `offstage_doctor` can tell you which
you are talking to. `npm run dev:register -- --print` shows the commands without
running them, including the Codex form.

An MCP server is spawned once per session and keeps the build it launched with,
so rebuild *and* restart the agent when you change the source. `offstage doctor`
warns when the `dist/` it is running predates the `src/` beside it.

That registers `offstage_doctor`, `offstage_route`, `offstage_run`,
`offstage_probe`, `offstage_session_status`, `offstage_session_screenshot`,
`offstage_session_input` and `offstage_session_apps`. See
[`docs/codex.md`](codex.md) for the Codex equivalent.

There is no `offstage_session_setup` tool, on purpose: setup runs `sudo`, and
`sudo` needs a terminal to prompt on. An agent should relay "run `offstage
session setup` in a terminal" to the human who has one.

The Claude Code plugin works the same way:
`/plugin marketplace add viraatdas/offstage`, then
`/plugin install offstage@offstage`. A plugin install only *clones* — it runs no
`npm install` and no build — which is why the server is declared as
`npx -y --package=@viraatdas/offstage@latest offstage-mcp` rather than a path
into the plugin directory. The first call fetches the package; later ones are cached.

`offstage_run` returns the full outcome — the routing decision, the run id, the
path to `result.json`, and the `LaneResult` — plus any screenshot the container
or session lane captured, as MCP image content.
`offstage_session_screenshot` returns the image alongside its width, height and
backing scale, and writes no file: an agent wants the bytes, not a PNG dropped
into the repository on every look.

## Where a run lives

Each run owns `.offstage/runs/<id>/` in the repository under test:

```
.offstage/runs/20260818T222228807Z-533188/
  command.log     combined stdout+stderr, streamed while the command ran
  result.json     the normalized envelope, validated on the way out and in
  screen.png      container and session lanes: what that display showed
```

Run ids are timestamp-prefixed, so `ls .offstage/runs` is already in
chronological order. The directory is self-contained: archive it or delete it.

## Releasing

Publishing is a tag push. `.github/workflows/release.yml` authenticates to npm
through GitHub's OIDC identity — there is no token in the repository, in CI
secrets, or on anyone's laptop, and npm attaches a provenance attestation
automatically.

```bash
npm version patch      # or minor / major — writes package.json and tags
git push --follow-tags
```

The workflow refuses to publish if the tag disagrees with `package.json`, so a
mistagged commit fails loudly instead of shipping a surprising version.

One-time setup on npmjs.com, under the package's settings → Trusted Publisher →
GitHub Actions: repository `viraatdas/offstage`, workflow `release.yml`. npm
cannot configure a trusted publisher for a name that has never been published,
so the very first version has to go out from a terminal (`npm publish
--access public`); every one after that is a tag push.
