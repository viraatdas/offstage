# Changelog

## 0.3.5

### Added

- Documented the "install your app into the guest account" pattern: copy the
  bundle into the helper account's own `~/Applications` through the session
  lane (no sudo, no installer, no refusal), then `session launch --fresh`
  with a generous `--wait-ms`. Includes the three practical notes learned by
  doing it: absolute guest paths, single-instance hygiene before relaunch,
  and slow first registration of freshly copied bundles.

## 0.3.4

### Fixed

- **`offstage session apps` is finally truthful.** The daemon now reads
  Launch Services directly (`lsappinfo`) instead of `NSWorkspace`, which from
  a launchd-daemon context served frozen snapshots: Calculator and Safari were
  visibly running — one frontmost — while the list denied either existed.
  That staleness was the root cause of a real agent session relaunching an app
  six times and then abandoning isolation.

### Added

- `apps` entries carry their activation `policy` (`regular` | `accessory`),
  and menu-bar / LSUIElement apps are listed. Before this, launching such an
  app looked identical to a failed launch — which is exactly what
  GestureEngine (a trackpad-gesture utility) is, and why the agent gave up.

## 0.3.3

### Fixed

- `offstage session launch` routes bare app names through `open -a`. Without
  it, `open` treated the name as a file path relative to the helper account's
  home directory (`open Calculator` exits 1 with "The file
  /Users/computeruse/Calculator does not exist") — measured on a live helper
  session via the published package.

## 0.3.2

### Added

- **`offstage session launch <app>`** and the `offstage_session_launch` MCP
  tool: open an app inside the helper session and wait until it has actually
  registered — the reply carries the app's pid, so success means "the app is
  running there", not "open handed off the request". With `--fresh` it demands
  a NEW pid and refuses to bless a pre-existing instance. Path-shaped targets
  resolve against the caller's cwd before crossing the socket; failures carry
  the app's own output instead of a bare exit code.
- **Menu-bar apps are first-class.** The daemon's `apps` op now lists
  `.accessory` apps (LSUIElement) alongside regular ones, each entry carrying
  its activation `policy`. Before this, launching a menu-bar app — which is
  what a lot of utility apps an agent wants to test actually are — looked
  identical to a failed launch: `open` succeeded but `apps` denied the app
  existed, and a real agent session responded by relaunching six times and
  then bypassing isolation entirely.
- Consumer-repo guardrail documentation: the skill and README now say plainly
  never to launch apps or run GUI commands outside offstage, and never to exec
  the binary inside `App.app/Contents/MacOS/` directly.

### Fixed

- `offstage session launch` no longer resolves repo-relative bundle paths
  against the helper account's home directory.

## 0.3.1

### Added

- **Zero-touch session setup.** `offstage session setup --create` now creates
  the helper account non-interactively with a generated password, suppresses
  its first-login Setup Assistant, pre-grants Screen Recording and
  Accessibility by writing the system TCC database directly when the invoking
  terminal has Full Disk Access, shows the fast-user-switching menu, and can
  arm boot-time auto-login with `--auto-login`. One human step remains: switch
  into the helper account once.
- **`--print-csreq`** mode on `offstage-sessiond`, exporting the Designated
  Requirement TCC stores — verified byte-for-byte against rows System Settings
  itself wrote.
- **`offstage session unshare <dir>`**, revoking exactly what `share` granted,
  absence-tolerant, no sudo.
- **opencode wiring** documented alongside Claude Code and Codex.
- The daemon's own README now carries the wire protocol.

### Fixed

- A *copied* machine-changing binary (`cp /usr/sbin/installer ./nice-name`) no
  longer evades the refusal: path-shaped argv[0] targets are content-hashed
  against the known system tools.
- `offstage session apps` no longer misses freshly launched apps: the daemon
  pumps its main runloop before snapshotting `NSWorkspace`.
- Session runs now collect everything the command leaves in
  `$OFFSTAGE_ARTIFACTS` as artifacts — `.xcresult` bundles included.
- Documentation consolidated into the README, AGENTS.md and the daemon's own
  reference; stale vm-lane text and a wrong status table removed.

## 0.3.0

### Breaking

- **The `vm` lane is gone.** It was fixture-tested only and never booted a real
  macOS guest, so it promised isolation it had never demonstrated. `--lane vm`
  is no longer accepted. Commands that could change the machine (`installer`,
  `.pkg`, `.dmg`, `hdiutil`) are now **refused outright on every lane**, with no
  flag to override, because no remaining lane can honestly isolate them. If you
  were relying on `--lane vm`, use the `tart-xcode-runner` skill directly.

### Added

- **The `session` lane**: a second logged-in macOS account with its own window
  server, framebuffer and input stream, driven by a small Swift daemon. It runs
  macOS-native work that opens windows (`xcodebuild`, `xcrun simctl`, XCUITests,
  `open -a`, `osascript`) without that window reaching your screen. Verified end
  to end on a real machine, including a headed Chromium running a Playwright
  spec to completion while the console session never changed.
- `offstage session setup` stands the whole thing up in one command: creates the
  account, installs and starts the daemon, suppresses first-login Setup
  Assistant, and pre-seeds the two TCC permissions the daemon needs. Setup is
  the only step that asks for a password, and it prints the entire script it
  will run before running it.
- `offstage session status`, `screenshot`, `input`, `click`, `type`, `key`,
  `apps`, `open`, `share`, `unshare`, `update`.
- Four MCP tools for the session lane, alongside the existing four.
- `offstage session update` rebuilds and installs the daemon with no password,
  because the daemon replaces its own binary over its own socket.

### Fixed

- **Machine-changing commands could evade the refusal four ways**, each of
  which would have run a real installer with no isolation at all: hidden behind
  a wrapper the router did not peel (`xargs`, `parallel`), invoked through a
  symlink under another name, invoked through a *copy* under another name, or
  placed anywhere on `PATH` under a friendly name and invoked by that bare name.
  All four are closed. The same gap could have put a headed browser on your
  screen, not just an installer, and `argv[0]` is now resolved the way the
  command is actually executed rather than only when it looks like a path.
- Inline interpreter code is inspected too. `python3 -c`, `node -e`, `ruby -e`
  and `osascript -e 'do shell script ...'` naming an installer used to route to
  a lane rather than being refused, and the headless lane runs its command as a
  direct child with no isolation at all.
- A trailing slash on the binary (`installer/`) produced an empty basename, so
  no name check matched. The OS refuses to exec such a path, so it was not a
  working bypass, but it is fixed.

### Known limitation, stated plainly

The refusal reads the command, not the program. It cannot see inside a script
file, a Makefile, an npm script or a compiled binary, so `sh deploy.sh` where
that script runs an installer is not refused. No static classifier could refuse
it. The docs previously said "nothing runs, on any lane" without that
qualification, which overstated it.
- Synthetic input reached the wrong session, and then reached nothing at all.
  Input is now posted to the session's own event tap, which is the only method
  that actually delivers inside a background session.
- Input inherited whatever modifier keys were live, so a plain `3` could arrive
  as `cmd+3` and typed text arrived as a run of keyboard shortcuts.
- `type` packed several characters into one event, which apps that read only the
  first character silently dropped.

### Known limitations

- The full `session setup` script has not yet been run on a fresh machine.
- Pre-seeding the TCC permissions needs Full Disk Access on the terminal running
  setup. Without it, setup says so and you grant the two permissions by hand.
- macOS has no way to create a background login session, so after a reboot the
  helper account has to be logged in once by hand. `--auto-login` arms Apple's
  own mechanism where FileVault permits it, and reports honestly when it does
  not.
- `session share` grants the helper account traversal of your home directory in
  order to reach the tree you shared. It is not scoped to that tree alone.

## 0.2.6 and earlier

See the git history.
