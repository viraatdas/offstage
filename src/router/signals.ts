/**
 * offstage — the evidence layer.
 *
 * `classify()` does not pattern-match a command straight onto a lane. It
 * collects *signals* — individual, quotable observations like "argv contains
 * --headed" or "playwright.config.ts sets headless: false" — and then decides.
 * That separation is what lets the router explain itself: the lane comes from
 * the strongest signal, and every other observation is still there to print.
 *
 * A signal carries four things beyond its text:
 *
 * - `argues` — which lane it is evidence for, or `null` for pure context.
 * - `priority` — lower wins the right to phrase the decision's `reason`.
 * - `inferred` — true when it came from a config file, a script, or a caller
 *   hint rather than from the argv that will literally be executed. Inferred
 *   evidence can be overridden by an explicit `--headless`; literal argv cannot.
 * - `confidence` — whether this observation alone is enough to be sure.
 */

import type { Lane } from '../contract/index.js';

import type { Inspector } from './inspect.js';
import type { Invocation } from './tokenize.js';
import { basenameOf, normalizeInvocation, parseScriptInvocation, tokenizeShellish } from './tokenize.js';

/* -------------------------------------------------------------------------- */
/* Signal shape                                                               */
/* -------------------------------------------------------------------------- */

export type SignalKind =
  // vm
  | 'xcodebuild'
  | 'xcrun-simctl'
  | 'xcrun'
  | 'uitest-scheme'
  | 'xcode-target'
  | 'open-app'
  | 'dmg-path'
  | 'app-binary'
  | 'macos-gui-tool'
  | 'open-other'
  // container
  | 'headed-flag'
  | 'headed-hint'
  | 'config-headed'
  | 'script-headed'
  | 'inspector-flag'
  | 'headed-subcommand'
  | 'extension-flag'
  | 'gpu-flag'
  | 'capture-flag'
  | 'vitest-browser'
  | 'vitest-browser-config'
  | 'browser-binary'
  | 'headed-driver'
  // headless
  | 'headless-flag'
  | 'headless-hint'
  | 'config-headless'
  | 'browser-default'
  | 'no-display-tool'
  | 'disable-gpu'
  | 'no-signal'
  // context only
  | 'recorded-video'
  | 'xcode-repo'
  | 'unreadable-config';

export interface Signal {
  kind: SignalKind;
  /** Which lane this observation is evidence for. `null` means context only. */
  argues: Lane | null;
  /** Where it was observed: `argv`, `playwright.config.ts`, `hint`, … */
  origin: string;
  /** One line for `RouteDecision.signals`, e.g. `argv: --headed`. */
  detail: string;
  /** A full sentence, used as `RouteDecision.reason` when this signal wins. */
  clause: string;
  /** Lower wins the right to phrase the reason. */
  priority: number;
  /** True when derived from a file or a hint rather than the literal argv. */
  inferred: boolean;
  confidence: 'high' | 'low';
}

function signal(init: Signal): Signal {
  return init;
}

/* -------------------------------------------------------------------------- */
/* Command views                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One command the router is reasoning about.
 *
 * `offstage run npm test` produces two views: the argv itself, and the command
 * `package.json` says `test` expands to. Both are inspected, because the flags
 * that matter are just as likely to live in a script as on the command line.
 */
export interface CommandView {
  invocation: Invocation;
  /** Human label used as the signal origin: `argv`, `package.json scripts.e2e`. */
  label: string;
  /** How many script expansions deep this view is. */
  depth: number;
  /**
   * False when this view is only a wrapper whose script was resolved — `npm` in
   * `npm test` should not be reported as "a plain test runner"; its script is.
   */
  binIsMeaningful: boolean;
}

/** How far `npm run a` → `npm run b` → … is followed before giving up. */
const MAX_SCRIPT_DEPTH = 3;

/**
 * Expand a command into every view worth inspecting, following package scripts
 * (but never running them).
 */
export async function buildViews(command: string[], inspector: Inspector): Promise<CommandView[]> {
  const views: CommandView[] = [];
  const seenScripts = new Set<string>();

  const walk = async (tokens: string[], label: string, depth: number): Promise<void> => {
    const invocation = normalizeInvocation(tokens);
    if (invocation.bin === '') return;

    const view: CommandView = { invocation, label, depth, binIsMeaningful: true };
    views.push(view);

    if (depth >= MAX_SCRIPT_DEPTH) return;

    const script = parseScriptInvocation(invocation);
    if (script === null) return;

    const pkg = await inspector.packageJson();
    const body = pkg?.scripts[script.script];
    if (pkg === undefined || body === undefined || seenScripts.has(script.script)) return;
    seenScripts.add(script.script);

    // The package manager is now just a launcher; its script is the real command.
    view.binIsMeaningful = false;

    const segments = tokenizeShellish(body);
    // Sequential on purpose: a script that runs `npm run other` has to share the
    // visited-set with its parent, or a cycle would expand forever.
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string[];
      const isLast = index === segments.length - 1;
      const tail = isLast ? [...segment, ...script.extraArgs] : segment;
      await walk(tail, `package.json scripts.${script.script}`, depth + 1);
    }
  };

  await walk(command, 'argv', 0);
  return views;
}

/* -------------------------------------------------------------------------- */
/* Flag vocabulary                                                            */
/* -------------------------------------------------------------------------- */

interface ParsedFlag {
  name: string;
  value?: string;
}

function parseFlag(token: string): ParsedFlag {
  const eq = token.indexOf('=');
  if (eq === -1) return { name: token };
  return { name: token.slice(0, eq), value: token.slice(eq + 1) };
}

const FALSEY = new Set(['false', '0', 'no', 'off', 'none']);
const TRUTHY = new Set(['true', '1', 'yes', 'on']);

function isTrueish(value: string | undefined): boolean {
  return value === undefined || TRUTHY.has(value.toLowerCase());
}

function isFalseish(value: string | undefined): boolean {
  return value !== undefined && FALSEY.has(value.toLowerCase());
}

/** Flags that ask for a visible browser window. */
function isHeadedFlag(flag: ParsedFlag): boolean {
  if (flag.name === '--headed') return isTrueish(flag.value);
  if (flag.name === '--no-headless') return true;
  if (flag.name === '--headless' || flag.name === '--browser.headless') return isFalseish(flag.value);
  return false;
}

/** Flags that explicitly ask for no window. */
function isHeadlessFlag(flag: ParsedFlag): boolean {
  if (flag.name === '--headless' || flag.name === '--browser.headless') return !isFalseish(flag.value);
  if (flag.name === '--headed') return isFalseish(flag.value);
  return false;
}

const GPU_FLAG_PATTERNS = [
  /^--use-gl$/,
  /^--use-angle$/,
  /^--use-vulkan$/,
  /^--enable-webgl.*$/,
  /^--enable-gpu(-rasterization|-compositing|-blocked-features)?$/,
  /^--ignore-gpu-block(list|admin)$/,
  /^--ignore-gpu-blacklist$/,
  /^--enable-unsafe-webgpu$/,
  /^--enable-accelerated-2d-canvas$/,
];

function isGpuFlag(flag: ParsedFlag): boolean {
  if (flag.name === '--enable-features') {
    return /vulkan|webgpu|gpu/i.test(flag.value ?? '');
  }
  return GPU_FLAG_PATTERNS.some((pattern) => pattern.test(flag.name)) && !isFalseish(flag.value);
}

function isNoGpuFlag(flag: ParsedFlag): boolean {
  return (
    flag.name === '--disable-gpu' ||
    flag.name === '--disable-gpu-compositing' ||
    flag.name === '--disable-software-rasterizer'
  );
}

function isExtensionFlag(flag: ParsedFlag): boolean {
  return flag.name === '--load-extension' || flag.name === '--disable-extensions-except';
}

/**
 * Switches that capture *the screen* — a desktop, another application's window,
 * or another tab — through `getDisplayMedia` and `chrome.desktopCapture`. Those
 * APIs enumerate surfaces the window system is drawing; a browser with no
 * display attached has none to offer, so the picker comes back empty and the
 * capture fails or silently records nothing. This is the class of work that
 * genuinely needs a head.
 */
const SCREEN_CAPTURE_FLAG_NAMES = new Set([
  '--auto-select-desktop-capture-source',
  '--auto-select-tab-capture-source-by-title',
  '--auto-accept-this-tab-capture',
  '--enable-usermedia-screen-capturing',
  '--allow-http-screen-capture',
]);

/**
 * Flags that ask the *runner* to record the page it is already driving:
 * Playwright's `video`, and the `--record-video` spelling used by harnesses
 * built on top of it.
 *
 * These do **not** need a display, and that is not a guess. Playwright records
 * by asking the browser for its own frames — `Page.startScreencast` over CDP —
 * and muxing the `screencastFrame` stream with the ffmpeg it ships in the box.
 * The renderer produces those frames whether or not anything is presenting
 * them, so a headless run writes the same `.webm` a headed one would. Sending
 * these to the container lane would buy nothing and charge container startup
 * for it, which is exactly the trade offstage exists to refuse.
 *
 * `--video=off` (and the other falsey spellings) is not a recording request at
 * all, so it produces no signal.
 */
const RECORDED_VIDEO_FLAG_NAMES = new Set(['--video', '--record-video']);

function isScreenCaptureFlag(flag: ParsedFlag): boolean {
  if (!SCREEN_CAPTURE_FLAG_NAMES.has(flag.name)) return false;
  return !isFalseish(flag.value);
}

function isRecordedVideoFlag(flag: ParsedFlag): boolean {
  if (!RECORDED_VIDEO_FLAG_NAMES.has(flag.name)) return false;
  return !isFalseish(flag.value);
}

/** Read `--config x`, `--config=x` or `-c x` out of an argument list. */
function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    const flag = parseFlag(token);
    if (!names.includes(flag.name)) continue;
    if (flag.value !== undefined) return flag.value;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) return next;
  }
  return undefined;
}

/** First argument that is not a flag and not a flag's value — the subcommand. */
function subcommandOf(args: string[]): string | undefined {
  const first = args[0];
  if (first === undefined || first.startsWith('-')) return undefined;
  return first;
}

/* -------------------------------------------------------------------------- */
/* Tool families                                                              */
/* -------------------------------------------------------------------------- */

const PLAYWRIGHT_BINS = new Set(['playwright', 'playwright-core', 'pwt']);
const VITEST_BINS = new Set(['vitest']);
const CYPRESS_BINS = new Set(['cypress']);
const PUPPETEER_BINS = new Set(['puppeteer']);

/** Browser executables invoked directly. These open a window unless told not to. */
const BROWSER_BINS = new Set([
  'chrome',
  'google-chrome',
  'google-chrome-stable',
  'google-chrome-beta',
  'chromium',
  'chromium-browser',
  'msedge',
  'microsoft-edge',
  'firefox',
  'brave',
  'brave-browser',
]);

/** WebDriver-shaped tools, which historically default to a visible browser. */
const HEADED_DRIVER_BINS = new Set([
  'wdio',
  'selenium-standalone',
  'selenium-side-runner',
  'chromedriver',
  'geckodriver',
  'msedgedriver',
  'safaridriver',
]);

/** Tools that never touch a display, so there is nothing to isolate. */
const NON_DISPLAY_BINS = new Set([
  'ava',
  'bazel',
  'biome',
  'c8',
  'cargo',
  'cmake',
  'composer',
  'ctest',
  'deno',
  'dotnet',
  'eslint',
  'go',
  'gradle',
  'gradlew',
  'jasmine',
  'jest',
  'just',
  'make',
  'mocha',
  'mvn',
  'node',
  'nyc',
  'phpunit',
  'prettier',
  'pytest',
  'python',
  'python3',
  'rake',
  'rspec',
  'ruby',
  'rustc',
  'swift',
  'tap',
  'tape',
  'task',
  'ts-node',
  'tsc',
  'tsx',
  'uvu',
  'vite-node',
  'bun',
  'npm',
  'pnpm',
  'yarn',
]);

/** macOS-only binaries that mean "this work has to happen on a Mac". */
const MACOS_GUI_BINS = new Set(['osascript', 'instruments', 'simctl', 'hdiutil']);

/** Extensions worth opening when a command names a local file. */
const SCRIPT_REFERENCE = /\.(c|m)?[jt]sx?$/;

/** Library mentions that make a `headless:` key in a file about a browser. */
const BROWSER_LIBRARY = /puppeteer|playwright|chromium|webdriver|selenium|@browserbasehq|chrome-launcher/i;

const HEADLESS_FALSE = /headless\s*:\s*false/;
const HEADLESS_TRUE = /headless\s*:\s*(true|['"]new['"]|['"]shell['"])/;

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

export interface ClassifyHints {
  /**
   * The caller's explicit intent. `true` forces the headed path (offstage's own
   * `--headed`); `false` says "I know this is headless" and overrides evidence
   * inferred from config files.
   */
  headed?: boolean;
}

/**
 * Collect every signal for a command, in the order the views were built.
 * Purely observational: nothing here picks a lane.
 */
export async function collectSignals(
  views: CommandView[],
  inspector: Inspector,
  hints?: ClassifyHints,
): Promise<Signal[]> {
  const signals: Signal[] = [];

  if (hints?.headed === true) {
    signals.push(
      signal({
        kind: 'headed-hint',
        argues: 'container',
        origin: 'hint',
        detail: 'hint: headed = true',
        clause:
          'You asked for a headed run, so offstage gives it a real browser window inside the container lane, on an Xvfb virtual display instead of your screen.',
        priority: 21,
        inferred: true,
        confidence: 'high',
      }),
    );
  }
  if (hints?.headed === false) {
    signals.push(
      signal({
        kind: 'headless-hint',
        argues: 'headless',
        origin: 'hint',
        detail: 'hint: headed = false',
        clause:
          'You told offstage this run is headless, and nothing in the command contradicts it, so it runs in place with no isolation overhead.',
        priority: 41,
        inferred: true,
        confidence: 'high',
      }),
    );
  }

  for (const view of views) {
    signals.push(...macosSignals(view));
    signals.push(...flagSignals(view));
    signals.push(...(await toolSignals(view, inspector)));
    signals.push(...(await referencedScriptSignals(view, inspector)));
  }

  signals.push(...(await repositorySignals(signals, inspector)));

  return signals;
}

/* --------------------------------- macOS --------------------------------- */

function macosSignals(view: CommandView): Signal[] {
  const found: Signal[] = [];
  const { bin, args, tokens } = view.invocation;
  const at = (text: string): string => `${view.label}: ${text}`;

  if (bin === 'xcodebuild') {
    found.push(
      signal({
        kind: 'xcodebuild',
        argues: 'vm',
        origin: view.label,
        detail: at('xcodebuild'),
        clause:
          'xcodebuild only exists on macOS and drives the Xcode toolchain, so no container can run it; offstage sends it to a macOS VM where its build and simulator windows stay off your screen.',
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
          argues: 'vm',
          origin: view.label,
          detail: at('xcrun simctl'),
          clause:
            'xcrun simctl boots an iOS Simulator, which needs a live macOS window server; the VM lane provides one so the simulator never appears on your desktop.',
          priority: 11,
          inferred: false,
          confidence: 'high',
        }),
      );
    } else if (bin === 'xcrun') {
      found.push(
        signal({
          kind: 'xcrun',
          argues: 'vm',
          origin: view.label,
          detail: at(`xcrun ${args[0] ?? ''}`.trim()),
          clause:
            'xcrun runs a macOS developer tool from the Xcode toolchain, which exists on no other platform, so this goes to the macOS VM lane.',
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
        argues: 'vm',
        origin: view.label,
        detail: at(scheme !== undefined ? `-scheme ${scheme}` : (onlyTesting as string)),
        clause:
          'This targets an XCUITest scheme, which drives a real app through the macOS accessibility APIs and needs a live UI session; the VM lane gives it one that is not your desktop.',
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
        argues: 'vm',
        origin: view.label,
        detail: at(basenameOf(projectToken.replace(/\/$/, ''))),
        clause: `The command targets ${basenameOf(
          projectToken.replace(/\/$/, ''),
        )}, which only Xcode on macOS can open, so it runs in the macOS VM lane.`,
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
        argues: 'vm',
        origin: view.label,
        detail: at(dmg),
        clause:
          'A .dmg has to be mounted by the macOS disk-image stack and the app inside it launched with a window server, so this belongs in the macOS VM lane rather than on your machine.',
        priority: 15,
        inferred: false,
        confidence: 'high',
      }),
    );
  }

  const appBinary = tokens.find((token) => token.includes('.app/Contents/MacOS/'));
  if (appBinary !== undefined) {
    found.push(
      signal({
        kind: 'app-binary',
        argues: 'vm',
        origin: view.label,
        detail: at(appBinary),
        clause:
          'This launches the executable inside a macOS .app bundle, which puts a real window on whatever screen it finds; the VM lane keeps that window inside the guest.',
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
          argues: 'vm',
          origin: view.label,
          detail: at(`open ${appArg ?? flagValue(args, ['-a']) ?? ''}`.trim()),
          clause:
            'open launches a macOS app, and a launched app puts a real window on the real screen; the VM lane runs it inside a macOS guest so your desktop stays untouched.',
          priority: 14,
          inferred: false,
          confidence: 'high',
        }),
      );
    } else if (args.length > 0 && dmg === undefined) {
      found.push(
        signal({
          kind: 'open-other',
          argues: 'vm',
          origin: view.label,
          detail: at(`open ${args[0] as string}`),
          clause:
            'open hands its argument to whatever macOS app is registered for it, which means a window appears somewhere; offstage routes it to the macOS VM lane so that somewhere is not your desktop.',
          priority: 18,
          inferred: false,
          confidence: 'low',
        }),
      );
    }
  }

  if (MACOS_GUI_BINS.has(bin) && bin !== 'simctl') {
    found.push(
      signal({
        kind: 'macos-gui-tool',
        argues: 'vm',
        origin: view.label,
        detail: at(bin),
        clause: `${bin} is a macOS-only tool that talks to the system's GUI or disk-image services, so it runs in the macOS VM lane.`,
        priority: 17,
        inferred: false,
        confidence: 'high',
      }),
    );
  }

  return found;
}

/* --------------------------------- flags --------------------------------- */

function flagSignals(view: CommandView): Signal[] {
  const found: Signal[] = [];
  const at = (text: string): string => `${view.label}: ${text}`;
  const inferred = false;
  const bin = view.invocation.bin;

  for (const token of view.invocation.args) {
    if (!token.startsWith('-')) continue;
    const flag = parseFlag(token);

    // Vitest spells headless-ness as --browser.headless; it is handled with the
    // rest of vitest's browser mode so that --browser.headless does not read as
    // a bare "headless" claim about a command that has no browser at all.
    const isVitestBrowserFlag = VITEST_BINS.has(bin) && flag.name.startsWith('--browser');

    if (!isVitestBrowserFlag && isHeadedFlag(flag)) {
      found.push(
        signal({
          kind: 'headed-flag',
          argues: 'container',
          origin: view.label,
          detail: at(token),
          clause:
            'The command asks for a headed browser, which means a real window and stolen focus if it runs here; the container lane opens that window against an Xvfb virtual display instead.',
          priority: 20,
          inferred,
          confidence: 'high',
        }),
      );
      continue;
    }
    if (!isVitestBrowserFlag && isHeadlessFlag(flag)) {
      found.push(
        signal({
          kind: 'headless-flag',
          argues: 'headless',
          origin: view.label,
          detail: at(token),
          clause:
            'The command explicitly runs headless, so no window opens and nothing steals focus; isolating it would add startup cost and buy nothing.',
          priority: 38,
          inferred,
          confidence: 'high',
        }),
      );
      continue;
    }
    if (isExtensionFlag(flag)) {
      found.push(
        signal({
          kind: 'extension-flag',
          argues: 'container',
          origin: view.label,
          detail: at(token),
          clause:
            'Loading a Chrome extension requires a headed browser profile, so this cannot honestly run headless; the container lane gives it a virtual display to load into.',
          priority: 25,
          inferred,
          confidence: 'high',
        }),
      );
      continue;
    }
    if (isGpuFlag(flag)) {
      found.push(
        signal({
          kind: 'gpu-flag',
          argues: 'container',
          origin: view.label,
          detail: at(token),
          clause:
            'GPU and WebGL switches ask for a real graphics stack, which a bare headless run does not have; the container lane supplies a framebuffer and a GL implementation.',
          priority: 26,
          inferred,
          confidence: 'high',
        }),
      );
      continue;
    }
    if (isScreenCaptureFlag(flag)) {
      found.push(
        signal({
          kind: 'capture-flag',
          argues: 'container',
          origin: view.label,
          detail: at(token),
          clause:
            'This captures the screen or another window through the desktop-capture APIs, which can only offer surfaces a window system is actually drawing; the container lane supplies an Xvfb display to capture, so the recording is real and still never reaches yours.',
          priority: 27,
          inferred,
          confidence: 'high',
        }),
      );
      continue;
    }
    if (isRecordedVideoFlag(flag)) {
      found.push(
        signal({
          kind: 'recorded-video',
          argues: null,
          origin: view.label,
          detail: at(token),
          clause: 'The run records video of the page it drives, which needs no display.',
          priority: 46,
          inferred,
          confidence: 'high',
        }),
      );
      continue;
    }
    if (isNoGpuFlag(flag)) {
      found.push(
        signal({
          kind: 'disable-gpu',
          argues: null,
          origin: view.label,
          detail: at(token),
          clause: 'GPU acceleration is explicitly disabled.',
          priority: 45,
          inferred,
          confidence: 'high',
        }),
      );
      continue;
    }
    if (PLAYWRIGHT_BINS.has(bin) && (flag.name === '--ui' || flag.name === '--debug')) {
      found.push(
        signal({
          kind: 'inspector-flag',
          argues: 'container',
          origin: view.label,
          detail: at(token),
          clause:
            'Playwright UI mode and the Inspector are desktop windows in their own right, not just a headed browser; the container lane hosts them on a virtual display.',
          priority: 24,
          inferred,
          confidence: 'high',
        }),
      );
    }
  }

  return found;
}

/* --------------------------------- tools --------------------------------- */

async function toolSignals(view: CommandView, inspector: Inspector): Promise<Signal[]> {
  const found: Signal[] = [];
  const { bin, args } = view.invocation;
  const at = (text: string): string => `${view.label}: ${text}`;
  const inferred = false;

  if (!view.binIsMeaningful) return found;

  if (PLAYWRIGHT_BINS.has(bin)) {
    const sub = subcommandOf(args);
    if (sub !== undefined && ['codegen', 'open', 'show-report', 'show-trace'].includes(sub)) {
      found.push(
        signal({
          kind: 'headed-subcommand',
          argues: 'container',
          origin: view.label,
          detail: at(`playwright ${sub}`),
          clause: `playwright ${sub} exists to put a window in front of a human, so it cannot run headless; the container lane opens it on a virtual display.`,
          priority: 24,
          inferred,
          confidence: 'high',
        }),
      );
      return found;
    }

    const configPath = flagValue(args, ['--config', '-c']);
    const config = await inspector.playwrightConfig(configPath);
    if (config === undefined && configPath !== undefined) {
      found.push(
        signal({
          kind: 'unreadable-config',
          argues: null,
          origin: view.label,
          detail: at(`--config ${configPath} could not be read`),
          clause: 'The named Playwright config could not be read.',
          priority: 80,
          inferred: true,
          confidence: 'low',
        }),
      );
    }
    if (config !== undefined) {
      found.push(...configSignals(config.file, config.text));
    }

    found.push(
      signal({
        kind: 'browser-default',
        argues: 'headless',
        origin: view.label,
        detail: at('playwright (headless by default)'),
        clause:
          'Playwright runs headless unless something asks otherwise: no window opens and nothing steals focus, so wrapping it in a container would only add container startup to every run.',
        priority: 40,
        inferred,
        confidence: 'high',
      }),
    );
    return found;
  }

  if (VITEST_BINS.has(bin)) {
    found.push(...(await vitestSignals(view, inspector)));
    return found;
  }

  if (CYPRESS_BINS.has(bin)) {
    const sub = subcommandOf(args);
    if (sub === 'open' || sub === undefined) {
      found.push(
        signal({
          kind: 'headed-subcommand',
          argues: 'container',
          origin: view.label,
          detail: at(`cypress ${sub ?? '(no subcommand)'}`),
          clause:
            'cypress open launches the Cypress desktop app with a real browser attached; the container lane runs it against a virtual display so it never lands on your screen.',
          priority: 24,
          inferred,
          confidence: 'high',
        }),
      );
      return found;
    }
    found.push(
      signal({
        kind: 'browser-default',
        argues: 'headless',
        origin: view.label,
        detail: at('cypress run (headless by default)'),
        clause:
          'cypress run is headless unless you pass --headed: it opens no window, so there is nothing for a container to protect you from.',
        priority: 40,
        inferred,
        confidence: 'high',
      }),
    );
    return found;
  }

  if (PUPPETEER_BINS.has(bin)) {
    found.push(
      signal({
        kind: 'browser-default',
        argues: 'headless',
        origin: view.label,
        detail: at('puppeteer (headless by default)'),
        clause:
          'Puppeteer launches headless unless the code sets headless: false, so no window opens and running it in place is already safe.',
        priority: 40,
        inferred,
        confidence: 'high',
      }),
    );
    return found;
  }

  if (BROWSER_BINS.has(bin)) {
    // A browser binary opens a window by default, which is exactly why it is a
    // container signal — but only when nothing on the command line already
    // turned that off. `chromium --headless=new` is not a headed run.
    const alreadyHeadless = args.some(
      (token) => token.startsWith('-') && isHeadlessFlag(parseFlag(token)),
    );
    if (alreadyHeadless) return found;
    found.push(
      signal({
        kind: 'browser-binary',
        argues: 'container',
        origin: view.label,
        detail: at(bin),
        clause: `Launching ${bin} directly opens a browser window unless --headless is passed, and this command does not pass it; the container lane gives that window a virtual display.`,
        priority: 30,
        inferred,
        confidence: 'high',
      }),
    );
    return found;
  }

  if (HEADED_DRIVER_BINS.has(bin)) {
    found.push(
      signal({
        kind: 'headed-driver',
        argues: 'container',
        origin: view.label,
        detail: at(bin),
        clause: `${bin} drives browsers through WebDriver, which does not default to headless the way Playwright does; unless the capabilities say otherwise a real window opens, so offstage routes it to the container lane.`,
        priority: 32,
        inferred,
        confidence: 'low',
      }),
    );
    return found;
  }

  if (NON_DISPLAY_BINS.has(bin)) {
    found.push(
      signal({
        kind: 'no-display-tool',
        argues: 'headless',
        origin: view.label,
        detail: at(bin),
        clause: `No display is involved at all: ${bin} is a plain build or test runner with no browser and no window, so there is nothing to isolate.`,
        priority: 43,
        inferred,
        confidence: 'high',
      }),
    );
  }

  return found;
}

/** Vitest browser mode: headed by default outside CI, which is the whole catch. */
async function vitestSignals(view: CommandView, inspector: Inspector): Promise<Signal[]> {
  const found: Signal[] = [];
  const { args } = view.invocation;
  const at = (text: string): string => `${view.label}: ${text}`;
  const inferred = false;

  const browserFlags = args.filter((token) => parseFlag(token).name.startsWith('--browser'));
  const enabledByFlag = browserFlags.some((token) => {
    const flag = parseFlag(token);
    if (flag.name === '--browser.headless') return false;
    if (flag.name === '--browser' || flag.name === '--browser.enabled') return !isFalseish(flag.value);
    return true;
  });
  const headlessFlag = browserFlags.find((token) => parseFlag(token).name === '--browser.headless');

  if (enabledByFlag) {
    if (headlessFlag !== undefined && !isFalseish(parseFlag(headlessFlag).value)) {
      found.push(
        signal({
          kind: 'headless-flag',
          argues: 'headless',
          origin: view.label,
          detail: at(headlessFlag),
          clause:
            'Vitest browser mode is pinned headless here, so it opens no window and can run in place with no isolation overhead.',
          priority: 38,
          inferred,
          confidence: 'high',
        }),
      );
      return found;
    }
    found.push(
      signal({
        kind: 'vitest-browser',
        argues: 'container',
        origin: view.label,
        detail: at(browserFlags.join(' ')),
        clause:
          'Vitest browser mode leaves browser.headless false outside CI, so this would pop a real browser window on your desktop; the container lane runs it against a virtual display instead.',
        priority: 28,
        inferred,
        confidence: 'high',
      }),
    );
    return found;
  }

  const configPath = flagValue(args, ['--config', '-c']);
  const config = await inspector.vitestConfig(configPath);
  if (config !== undefined && /browser\s*:\s*\{/.test(config.text) && /enabled\s*:\s*true/.test(config.text)) {
    if (HEADLESS_TRUE.test(config.text)) {
      found.push(
        signal({
          kind: 'config-headless',
          argues: 'headless',
          origin: config.file,
          detail: `${config.file}: browser mode enabled with headless: true`,
          clause:
            'Vitest browser mode is enabled in the config but pinned headless, so no window opens and the run stays in place.',
          priority: 39,
          inferred: true,
          confidence: 'high',
        }),
      );
    } else {
      found.push(
        signal({
          kind: 'vitest-browser-config',
          argues: 'container',
          origin: config.file,
          detail: `${config.file}: browser mode enabled, headless not set`,
          clause:
            'The vitest config turns browser mode on without pinning headless, and vitest treats that as headed outside CI; the container lane absorbs the window this would otherwise open on your screen.',
          priority: 31,
          inferred: true,
          confidence: 'low',
        }),
      );
    }
    return found;
  }

  found.push(
    signal({
      kind: 'no-display-tool',
      argues: 'headless',
      origin: view.label,
      detail: at('vitest (no browser mode)'),
      clause:
        'No display is involved at all: this is vitest in its ordinary node environment, with no browser and no window to isolate.',
      priority: 43,
      inferred,
      confidence: 'high',
    }),
  );
  return found;
}

/* ------------------------------ config files ------------------------------ */

/** Signals read out of a Playwright-shaped config file. */
function configSignals(file: string, text: string): Signal[] {
  const found: Signal[] = [];

  if (HEADLESS_FALSE.test(text)) {
    found.push(
      signal({
        kind: 'config-headed',
        argues: 'container',
        origin: file,
        detail: `${file}: headless: false`,
        clause: `${file} sets headless: false, so this run would open a real browser window on your desktop; the container lane gives it an Xvfb display to open into instead.`,
        priority: 22,
        inferred: true,
        confidence: 'high',
      }),
    );
  } else if (HEADLESS_TRUE.test(text)) {
    found.push(
      signal({
        kind: 'config-headless',
        argues: 'headless',
        origin: file,
        detail: `${file}: headless: true`,
        clause: `${file} pins headless: true, so no window opens anywhere and the run is already safe to do in place.`,
        priority: 39,
        inferred: true,
        confidence: 'high',
      }),
    );
  }

  for (const token of text.match(/--[a-z0-9-]+(=[^\s'"`,)]+)?/gi) ?? []) {
    const flag = parseFlag(token);
    if (isExtensionFlag(flag)) {
      found.push(
        signal({
          kind: 'extension-flag',
          argues: 'container',
          origin: file,
          detail: `${file}: ${token}`,
          clause: `${file} launches the browser with a Chrome extension, which only loads in a headed browser; the container lane provides the display it needs.`,
          priority: 25,
          inferred: true,
          confidence: 'high',
        }),
      );
    } else if (isGpuFlag(flag)) {
      found.push(
        signal({
          kind: 'gpu-flag',
          argues: 'container',
          origin: file,
          detail: `${file}: ${token}`,
          clause: `${file} asks the browser for a real graphics stack (${flag.name}), which a bare headless run does not have; the container lane supplies one.`,
          priority: 26,
          inferred: true,
          confidence: 'high',
        }),
      );
    }
  }

  return found;
}

/* ------------------------- referenced local scripts ----------------------- */

/**
 * `node scripts/scrape.js` is how puppeteer usually reaches offstage: the
 * interesting flag is not in argv at all, it is in the file. So when a command
 * names a local source file, the router reads it — never runs it — and looks for
 * a browser launch.
 */
async function referencedScriptSignals(view: CommandView, inspector: Inspector): Promise<Signal[]> {
  const found: Signal[] = [];
  const inferred = true;

  for (const token of view.invocation.args) {
    if (token.startsWith('-') || !SCRIPT_REFERENCE.test(token)) continue;
    const file = await inspector.localScript(token);
    if (file === undefined) continue;
    if (!BROWSER_LIBRARY.test(file.text)) continue;

    const library = /puppeteer/i.test(file.text) ? 'puppeteer' : 'a browser library';

    if (HEADLESS_FALSE.test(file.text)) {
      found.push(
        signal({
          kind: 'script-headed',
          argues: 'container',
          origin: file.file,
          detail: `${file.file}: launches ${library} with headless: false`,
          clause: `${file.file} launches ${library} with headless: false, so running it here would open a real browser window; the container lane gives that window a virtual display.`,
          priority: 23,
          inferred,
          confidence: 'high',
        }),
      );
    } else {
      found.push(
        signal({
          kind: 'browser-default',
          argues: 'headless',
          origin: file.file,
          detail: `${file.file}: uses ${library}, headless not disabled`,
          clause: `${file.file} drives ${library} without turning headless off, so it opens no window and running it in place is already safe.`,
          priority: 40,
          inferred,
          confidence: 'high',
        }),
      );
    }

    for (const flagToken of file.text.match(/--[a-z0-9-]+(=[^\s'"`,)]+)?/gi) ?? []) {
      const flag = parseFlag(flagToken);
      if (isExtensionFlag(flag)) {
        found.push(
          signal({
            kind: 'extension-flag',
            argues: 'container',
            origin: file.file,
            detail: `${file.file}: ${flagToken}`,
            clause: `${file.file} loads a Chrome extension, which only works in a headed browser; the container lane provides the display it needs.`,
            priority: 25,
            inferred,
            confidence: 'high',
          }),
        );
      } else if (isGpuFlag(flag)) {
        found.push(
          signal({
            kind: 'gpu-flag',
            argues: 'container',
            origin: file.file,
            detail: `${file.file}: ${flagToken}`,
            clause: `${file.file} asks the browser for a real graphics stack (${flag.name}), which a bare headless run does not have; the container lane supplies one.`,
            priority: 26,
            inferred,
            confidence: 'high',
          }),
        );
      }
    }
  }

  return found;
}

/* ------------------------------- repository ------------------------------- */

/**
 * Whether the repository itself is an Xcode project. On its own this is not
 * enough to route: plenty of iOS repos also hold a `npm test` that has nothing
 * to do with Xcode. It confirms a macOS decision, and otherwise it is recorded
 * as the context it is.
 */
async function repositorySignals(existing: Signal[], inspector: Inspector): Promise<Signal[]> {
  const projects = await inspector.xcodeProjects();
  if (projects.length === 0) return [];

  const names = projects.join(', ');
  const targeted = existing.some((item) => item.argues === 'vm');

  if (targeted) {
    return [
      signal({
        kind: 'xcode-repo',
        argues: null,
        origin: 'repo',
        detail: `repo: ${names} present, and this command targets it`,
        clause: `The repository is an Xcode project (${names}) and this command targets it.`,
        priority: 70,
        inferred: true,
        confidence: 'high',
      }),
    ];
  }

  return [
    signal({
      kind: 'xcode-repo',
      argues: null,
      origin: 'repo',
      detail: `repo: ${names} present, but this command does not target it`,
      clause: `The repository contains ${names}, but nothing in this command touches Xcode.`,
      priority: 70,
      inferred: true,
      confidence: 'high',
    }),
  ];
}
