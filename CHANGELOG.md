# Changelog

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
