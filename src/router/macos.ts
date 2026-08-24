/**
 * offstage: commands that need a real macOS window server.
 *
 * `xcodebuild`, `xcrun simctl`, XCUITest schemes, `open -a`, the binary inside
 * a `.app`, `safaridriver`, `osascript`, `instruments`. No Linux container can
 * run any of these, and none of them needs a fresh machine either: they need a
 * display that is not yours, which is what the session lane is.
 *
 * The refusals also live here. A command naming an installer, a `.dmg`/`.pkg`
 * or `hdiutil` gets no lane at all, because session isolation shares the disk
 * and the kernel with the caller and cannot honestly contain it.
 */

import { MACOS_GUI_BINS } from './bins.js';
import { flagValue } from './flags.js';
import type { Signal } from './signal.js';
import { signal } from './signal.js';
import { basenameOf } from './tokenize.js';
import type { CommandView } from './views.js';

/* --------------------------------- macOS --------------------------------- */

/**
 * The literal binary name, plus, when argv[0] named a path, the basename of
 * what it resolves to on disk, and any machine-changing tool the bytes matched
 * (`cp /usr/sbin/installer ./x` carries no name and no link, only content). A
 * wrapper directory, an innocuous filename, and a fresh copy do not change
 * what a binary actually is, so a check keyed on a name (`installer`,
 * `hdiutil`, a `MACOS_GUI_BINS` member) has to see all three.
 */
function binNames(view: CommandView): Set<string> {
  const names = new Set<string>([view.invocation.bin]);
  if (view.resolvedBin !== undefined) names.add(view.resolvedBin);
  if (view.contentMatchedBin !== undefined) names.add(view.contentMatchedBin);
  return names;
}

/** How a view came to be identified as `tool`: typed it, resolved to it, or its bytes match. */
function identifyVia(view: CommandView, tool: string): 'bin' | 'resolve' | 'copy' {
  if (view.invocation.bin === tool) return 'bin';
  if (view.resolvedBin === tool) return 'resolve';
  return 'copy';
}

/** The human label for an identified tool: `installer`, `x (resolves to installer)`, `x (identical copy of installer)`. */
function identifyLabel(view: CommandView, tool: string): string {
  const via = identifyVia(view, tool);
  if (via === 'bin') return tool;
  if (via === 'resolve') return `${view.invocation.bin} (resolves to ${tool})`;
  return `${view.invocation.bin} (identical copy of ${tool})`;
}

export function macosSignals(view: CommandView): Signal[] {
  const found: Signal[] = [];
  const { bin, args, tokens } = view.invocation;
  const at = (text: string): string => `${view.label}: ${text}`;

  if (bin === 'xcodebuild') {
    found.push(
      signal({
        kind: 'xcodebuild',
        argues: 'session',
        origin: view.label,
        detail: at('xcodebuild'),
        clause:
          'xcodebuild only exists on macOS and drives the Xcode toolchain against a real window server, so no Linux container can run it; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so its build and simulator windows never reach your desktop.',
        priority: 10,
        inferred: false,
        confidence: 'high',
      }),
    );
  }

  if (bin === 'xcrun' || bin === 'simctl') {
    const usesSimctl = bin === 'simctl' || args.includes('simctl');
    if (usesSimctl) {
      found.push(
        signal({
          kind: 'xcrun-simctl',
          argues: 'session',
          origin: view.label,
          detail: at('xcrun simctl'),
          clause:
            'xcrun simctl boots an iOS Simulator, which needs a live macOS window server to render into; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so the simulator never appears on your desktop.',
          priority: 11,
          inferred: false,
          confidence: 'high',
        }),
      );
    } else if (bin === 'xcrun') {
      found.push(
        signal({
          kind: 'xcrun',
          argues: 'session',
          origin: view.label,
          detail: at(`xcrun ${args[0] ?? ''}`.trim()),
          clause:
            'xcrun runs a macOS developer tool from the Xcode toolchain, which exists on no other platform and may put a window up while it works; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so anything it opens never reaches your desktop.',
          priority: 17,
          inferred: false,
          confidence: 'high',
        }),
      );
    }
  }

  const scheme = flagValue(args, ['-scheme', '--scheme']);
  const onlyTesting = tokens.find((token) => token.startsWith('-only-testing'));
  const uiTestTarget =
    (scheme !== undefined && /ui\W*tests?\b/i.test(scheme.replace(/([a-z])([A-Z])/g, '$1 $2'))) ||
    (onlyTesting !== undefined && /uitests?/i.test(onlyTesting));
  if (uiTestTarget) {
    found.push(
      signal({
        kind: 'uitest-scheme',
        argues: 'session',
        origin: view.label,
        detail: at(scheme !== undefined ? `-scheme ${scheme}` : (onlyTesting as string)),
        clause:
          'This targets an XCUITest scheme, which drives a real macOS app through the accessibility APIs and needs a live UI session with a keyboard and mouse of its own; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so the test types into that session and never into yours.',
        priority: 12,
        inferred: false,
        confidence: 'high',
      }),
    );
  }

  const projectToken =
    tokens.find((token) => /\.(xcodeproj|xcworkspace)\/?$/.test(token)) ??
    flagValue(args, ['-project', '-workspace']);
  if (projectToken !== undefined && /\.(xcodeproj|xcworkspace)\/?$/.test(projectToken)) {
    found.push(
      signal({
        kind: 'xcode-target',
        argues: 'session',
        origin: view.label,
        detail: at(basenameOf(projectToken.replace(/\/$/, ''))),
        clause: `The command targets ${basenameOf(
          projectToken.replace(/\/$/, ''),
        )}, which only Xcode on macOS can open and which builds against a real window server; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so whatever it opens never reaches your desktop.`,
        priority: 13,
        inferred: false,
        confidence: 'high',
      }),
    );
  }

  const dmg = tokens.find((token) => /\.dmg$/i.test(token));
  if (dmg !== undefined) {
    found.push(
      signal({
        kind: 'dmg-path',
        argues: null,
        origin: view.label,
        detail: at(dmg),
        clause:
          'A .dmg is mounted by the macOS disk-image stack onto the machine that runs the command, and what is inside one is usually an installer that can change that machine. The session lane shares your OS and your disk with you, so it cannot honestly contain that, and offstage has no lane that can: it refuses to run this rather than risk your machine. Mount and inspect it by hand, or run this command directly yourself if you accept the risk.',
        priority: 5,
        inferred: false,
        confidence: 'high',
        refuses: true,
      }),
    );
  }

  const appBinary = tokens.find((token) => token.includes('.app/Contents/MacOS/'));
  if (appBinary !== undefined) {
    found.push(
      signal({
        kind: 'app-binary',
        argues: 'session',
        origin: view.label,
        detail: at(appBinary),
        clause:
          'This launches the executable inside a macOS .app bundle, which puts a real window on whatever screen it finds; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so the window opens on that other framebuffer and never reaches your desktop.',
        priority: 16,
        inferred: false,
        confidence: 'high',
      }),
    );
  }

  if (bin === 'open') {
    const appArg = args.find((token) => /\.app\/?$/.test(token));
    const byName = args.includes('-a') || args.includes('--args');
    if (appArg !== undefined || byName) {
      found.push(
        signal({
          kind: 'open-app',
          argues: 'session',
          origin: view.label,
          detail: at(`open ${appArg ?? flagValue(args, ['-a']) ?? ''}`.trim()),
          clause:
            'open launches a macOS app, and a launched app puts a real window on the real screen and takes the keyboard focus with it; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so the window never reaches your desktop.',
          priority: 14,
          inferred: false,
          confidence: 'high',
        }),
      );
    } else if (args.length > 0 && dmg === undefined) {
      found.push(
        signal({
          kind: 'open-other',
          argues: 'session',
          origin: view.label,
          detail: at(`open ${args[0] as string}`),
          clause:
            'open hands its argument to whatever macOS app is registered for it, which means a window appears somewhere; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so that somewhere is never your desktop.',
          priority: 18,
          inferred: false,
          confidence: 'low',
        }),
      );
    }
  }

  // hdiutil is the one MACOS_GUI_BIN that refuses rather than arguing for a
  // spare display: attaching a disk image mounts a volume on whatever system
  // runs the command, and the session lane is that same system. Checked by
  // `names` rather than `bin` alone, so a symlink or a rename to an innocuous
  // filename cannot hide it: see `binNames`.
  const names = binNames(view);
  if (names.has('hdiutil')) {
    const label = identifyLabel(view, 'hdiutil');
    found.push(
      signal({
        kind: 'macos-gui-tool',
        argues: null,
        origin: view.label,
        detail: at(label),
        clause:
          bin === 'hdiutil'
            ? 'hdiutil attaches and creates macOS disk images, which mounts volumes on the machine that runs it and is usually a step in installing something. The session lane is a second account on your own OS and disk, not a second machine, and offstage has no lane that isolates a mount like that, so it refuses to run this rather than risk your machine. Run it directly yourself if you accept the risk.'
            : `${label}: a symlink, a rename, or a byte-identical copy does not change what this binary does. It attaches and creates macOS disk images, which mounts volumes on the machine that runs it and is usually a step in installing something. The session lane is a second account on your own OS and disk, not a second machine, and offstage has no lane that isolates a mount like that, so it refuses to run this rather than risk your machine. Run it directly yourself if you accept the risk.`,
        priority: 5,
        inferred: false,
        confidence: 'high',
        refuses: true,
      }),
    );
  } else {
    const guiBin = [...names].find((name) => MACOS_GUI_BINS.has(name) && name !== 'simctl');
    if (guiBin !== undefined) {
      const label = bin === guiBin ? bin : `${bin} (resolves to ${guiBin})`;
      found.push(
        signal({
          kind: 'macos-gui-tool',
          argues: 'session',
          origin: view.label,
          detail: at(label),
          clause: `${guiBin} is a macOS-only tool that talks to the system's GUI services, so no Linux container can run it; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so whatever it drives or draws never touches your desktop.`,
          priority: 17,
          inferred: false,
          confidence: 'high',
        }),
      );
    }
  }

  // Installer packages and the installer command change the machine they run
  // on. offstage has no lane that isolates that, so both refuse outright.
  const pkg = tokens.find((token) => /\.pkg$/i.test(token));
  if (pkg !== undefined) {
    found.push(
      signal({
        kind: 'pkg-path',
        argues: null,
        origin: view.label,
        detail: at(pkg),
        clause:
          'A .pkg is a macOS installer package, and installing one writes into system locations, runs preinstall and postinstall scripts as root, and cannot be cleanly undone. The session lane shares your OS and your disk with you, and offstage has no lane that isolates a change like that, so it refuses to run this rather than risk your machine. Run it directly yourself if you accept the risk.',
        priority: 5,
        inferred: false,
        confidence: 'high',
        refuses: true,
      }),
    );
  }

  if (names.has('installer')) {
    const label = identifyLabel(view, 'installer');
    found.push(
      signal({
        kind: 'installer',
        argues: null,
        origin: view.label,
        detail: at(label),
        clause:
          bin === 'installer'
            ? 'The installer command applies a macOS installer package to a target volume, which is a deliberate change to the machine it runs on. The session lane is only a second account on your own OS and disk, and offstage has no lane that isolates that, so it refuses to run this rather than risk your machine. Run it directly yourself if you accept the risk.'
            : `${label}: a symlink, a rename, or a byte-identical copy does not change what this binary does. It applies a macOS installer package to a target volume, which is a deliberate change to the machine it runs on. The session lane is only a second account on your own OS and disk, and offstage has no lane that isolates that, so it refuses to run this rather than risk your machine. Run it directly yourself if you accept the risk.`,
        // Wins over pkg-path (priority 5) when both fire on `installer -pkg
        // foo.pkg`: naming the command itself is a more specific reason than
        // noticing its argument.
        priority: 4,
        inferred: false,
        confidence: 'high',
        refuses: true,
      }),
    );
  }

  return found;
}
