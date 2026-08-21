# Installing offstage

This covers the npm package, the CLI, and the macOS session lane's one-time
setup. If you only want the short version, the README's "Try it" section and
[`docs/usage.md`](usage.md) cover the everyday commands; this document is the
first-run path end to end.

## Quick path

```bash
curl -fsSL https://raw.githubusercontent.com/viraatdas/offstage/main/scripts/install.sh | sh
```

This installs Node.js if it's missing (or tells you how), installs
`@viraatdas/offstage` globally with npm, checks it landed on your `PATH`, runs
`offstage doctor`, and — on macOS — checks for the Xcode Command Line Tools and
offers to run the session lane's one-time setup. Nothing in it needs `sudo`
except the session setup step, which asks for it itself and tells you why.

Environment variables it reads:

| Variable | Effect |
| --- | --- |
| `OFFSTAGE_VERSION` | npm version or dist-tag to install (default `latest`) |
| `OFFSTAGE_SKIP_SESSION` | set to `1` to skip the session-setup prompt entirely |

It's safe to re-run: it upgrades the package in place and skips whatever's
already done.

## Manual path

```bash
npm i -g @viraatdas/offstage
offstage doctor
```

Or from a clone, if you're working on offstage itself:

```bash
git clone https://github.com/viraatdas/offstage && cd offstage
npm ci          # `prepare` builds dist/ as part of this
npm link        # puts offstage and offstage-mcp on your PATH
```

If `offstage` isn't found after a global install, npm put it in a `bin`
directory that isn't on your `PATH`. Find it and add it:

```bash
npm config get prefix     # e.g. /usr/local, or ~/.npm-global
# add "<that>/bin" to PATH in your shell profile
```

## The session lane's one-time setup

Two of offstage's lanes — `headless` and `container` — work the moment the
package is installed. The third macOS-native path, `vm`, needs a one-time
~25–69 GB image build. The **session lane** is a fourth, cheaper way to get an
unwatched macOS GUI session: a second, ordinary macOS user account
(`computeruse` by default) that a small daemon drives, isolated from your own
login session's input and screen.

Run the setup once:

```bash
offstage session setup --create      # --create makes the account if it does not exist
```

What it does, and why each part needs what it needs:

1. **Compiles a Swift daemon** from `native/sessiond/` (`swiftc`, which ships
   with the Xcode Command Line Tools — `xcode-select --install` if you don't
   have them). This is why the installer checks for the CLT on macOS even
   though nothing else in offstage needs them.
2. **Asks for `sudo` once**, to create the helper account (if `--create` was
   passed) and to load the daemon as a system LaunchAgent that can run inside
   that account's GUI session. This is the only step in the whole install that
   touches `sudo`, and it prompts you directly for it — nothing runs silently
   with elevated privileges.
3. **Cannot finish the rest for you.** macOS gates screen capture and synthetic
   input per login session, enforced by the OS outside any process's control
   (see [`docs/session-lane.md`](session-lane.md) for the design and [`docs/macos-sessions.md`](macos-sessions.md) for why nothing cheaper exists).
   That means the permissions the daemon needs can only be granted *from
   inside* the helper account's own session — no script, running as you or as
   root, can click through a `System Settings` prompt in a session it isn't
   logged into.

### What you do by hand, once

1. **Switch to the helper account** from the user menu (top-right of the menu
   bar) or the login window. Use the console itself — not screen sharing or
   remote control, which is a different, unrelated session.
2. **If macOS shows Setup Assistant**, click through it (region, Apple ID
   skip, and so on). This is a one-time first-login screen for any new
   account; it will not appear again.
3. **Approve two permissions** when macOS prompts, in
   `System Settings > Privacy & Security`:
   - **Screen Recording** — the daemon needs to see what's on the (virtual)
     screen to report state and, where relevant, capture it.
   - **Accessibility** — the daemon needs to post synthetic input events
     inside *that* session.

   Both are for the process named `offstage-sessiond`. Apple requires this
   approval to happen interactively, inside the session being granted access,
   specifically so that a compromised or automated process elsewhere cannot
   grant itself screen or input access silently.
4. **Switch back** to your own account, then confirm it worked:

   ```bash
   offstage session status
   ```

After this one-time dance, `offstage session setup` and `offstage session
status` don't need any of it again — the daemon keeps running, and the
permission grants persist with the helper account.

### Using it

```bash
offstage session share <dir>     # make a directory readable from inside the helper account
```

See `offstage session --help` for the full set of flags (`--user` to name a
different helper account than `computeruse`).

## The trust model, in one paragraph

The session lane's isolation is **a second login session, not a virtual
machine**: the helper account shares your disk, your kernel, and your Node and
system installs, but its GUI session has its own window server context, its
own keyboard/mouse event stream (gated by `Screen Recording` + `Accessibility`
TCC grants scoped to that session), and its own default lack of access to your
files. Coordination between your session and the daemon goes over a local
Unix domain socket owned by a **staff-group** socket file — readable and
writable only by accounts in the `staff` group (which both your account and
the helper account are in by default on a single-user Mac), not world-writable
and not exposed over any network interface. This buys you input and screen
isolation for GUI automation at a fraction of the VM lane's disk and boot cost;
it does not buy you the stronger boundary a VM gives you (a different kernel,
no shared filesystem) — pick the `vm` lane instead if that's the property you
need.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `doctor` reports `session unavailable`, no socket | The daemon isn't running, or hasn't been set up yet | `offstage session setup`, then `offstage session status` |
| TCC prompt denied, or never appeared | Screen Recording / Accessibility not granted to `offstage-sessiond` inside the helper session | Log into the helper account, open `System Settings > Privacy & Security`, add `offstage-sessiond` under both panes; if the app doesn't appear in the list, trigger the daemon action once first so macOS registers the request |
| Daemon reports it cannot read your project's working directory | The helper account has its own filesystem permissions and, by default, cannot read directories under your home folder | `offstage session share <dir>` to grant the helper account read access to that specific directory |
| Helper account shows up logged in "on console", stealing the physical display | You connected to it with legacy VNC-style auth (ARD security type 30) instead of switching via the user menu, which takes over the real screen instead of using an isolated session | Switch accounts using the macOS user menu / login window, not a screen-sharing client authenticated the old way — see [`docs/macos-sessions.md`](macos-sessions.md) for why type 30 does this |
| `offstage session setup` fails to compile the daemon | `swiftc` missing — Xcode Command Line Tools not installed | `xcode-select --install`, then re-run setup |
| Helper account stuck on Setup Assistant / region picker every login | First login to a freshly created account always shows it once | Click through it once, from inside the helper account; it will not reappear |
| `npm install -g` fails with an `EACCES` permission error | Your npm global prefix isn't writable by your user | Point npm at a directory you own instead of using `sudo`: `mkdir -p ~/.npm-global && npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to `PATH` |

## Uninstalling

```bash
sh scripts/uninstall.sh              # dry run — prints every command, changes nothing
sh scripts/uninstall.sh --yes        # bootout the daemon, remove its plist and files
sh scripts/uninstall.sh --yes --remove-npm-package   # also remove the npm package
```

It never deletes the helper macOS account — it only prints the
`sysadminctl -deleteUser computeruse` command, so removing an account (which
also removes its home directory unless you keep it) stays a decision you make
on purpose, not a side effect of an uninstall script.
