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
  | 'computed-headless'
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

/**
 * WebDriver endpoints that open nothing by themselves. A driver server launches
 * a browser only when a client asks it for a session, and whether that browser
 * is headless lives in the client's capabilities, which are not on this command
 * line and not in any file this repository is guaranteed to have.
 */
const WEBDRIVER_SERVER_BINS = new Set([
  'chromedriver',
  'geckodriver',
  'msedgedriver',
  'selenium-standalone',
  'selenium-side-runner',
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

/**
 * What a file says about `headless`, as far as reading it can tell.
 *
 * This is the router's honesty boundary in one type. offstage reads configs and
 * scripts; it never evaluates them, because a router that executes your config
 * to find out whether it opens a window can open a window while deciding. The
 * cost of that rule is that `headless: process.env.HEADED !== '1'` is a value
 * offstage cannot know, and the rule is only worth having if the router says so
 * instead of quietly reporting the tool default with `confidence: 'high'`.
 *
 * - `literal-false` / `literal-true` — the value is spelled out; believe it.
 * - `conditional` — the file spells out *both*, so which one applies is decided
 *   at runtime. Container is the safe way to be wrong, but not a confident one.
 * - `computed` — the key is there and the value is an expression: an env var, a
 *   variable, a ternary, a function call.
 * - `delegated` — the browser options are a reference to something offstage did
 *   not read; the `headless` that matters may be one import away.
 * - `absent` — no `headless` key at all, which is the honest, common case where
 *   the tool's own default (headless, for every runner offstage routes) applies.
 */
export type HeadlessEvidence =
  | { shape: 'literal-false' }
  | { shape: 'literal-true' }
  | { shape: 'conditional' }
  | { shape: 'computed'; expression: string }
  | { shape: 'delegated'; key: string }
  | { shape: 'absent' };

/** Every `headless:` binding in a file, capturing the raw text of its value. */
const HEADLESS_BINDING = /\bheadless\s*:\s*([^,;\n}]*)/g;

/** The only two spellings of "no window opens" the router takes at face value. */
const LITERAL_FALSE = /^false$/;
const LITERAL_TRUE = /^(?:true|['"]new['"]|['"]shell['"])$/;

/**
 * Keys that hold the browser options. When one of these is bound to a bare
 * reference rather than an object literal — `use: baseUse`, `use: makeUse()`,
 * or the `{ use }` shorthand over an import — everything offstage cares about
 * lives in a file it did not open.
 */
const BROWSER_OPTION_KEYS = ['use', 'launchOptions', 'contextOptions'];

/** Keep a quoted expression short enough to sit in a one-line signal. */
function shorten(expression: string, limit = 60): string {
  const flat = expression.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/** True when browser options are handed over as a reference offstage cannot follow. */
function delegatedOptionKey(text: string): string | undefined {
  for (const key of BROWSER_OPTION_KEYS) {
    // `use: baseUse` / `use: makeUse()`. Deliberately narrow: an object literal
    // is readable and must not match, and neither should anything the router
    // cannot name back to the user, so only a plain reference or call counts.
    // `text.match(re)` rather than the RegExp method whose name a
    // process-spawning function also uses: `tests/router.purity.test.ts` bans
    // that name outright from this directory so nobody can quietly start a
    // process here, and a textual guard cannot tell the harmless namesake from
    // the one it hunts. The guard is right to stay blunt; the router bends.
    const bound = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z_$][\\w$.]*(?:\\([^)\\n]*\\))?)\\s*[,}\\n]`);
    const match = text.match(bound);
    if (match?.[1] !== undefined) return match[1];
    // The `{ use }` shorthand, which is how an imported options object arrives.
    if (new RegExp(`\\{\\s*${key}\\s*[,}]`).test(text)) return key;
  }
  // `puppeteer.launch(opts)` is the same handover in a script: the options are
  // real, and they are not in this file. `launch()` and `launch({ … })` are not.
  const launched = text.match(/\b(?:launch|launchPersistentContext)\s*\(\s*([A-Za-z_$][\w$.]*)\s*[,)]/);
  return launched?.[1];
}

/**
 * Read a file's position on `headless` without executing a line of it.
 *
 * A literal `false` anywhere outranks everything, because a window that might
 * open is the thing offstage exists to catch — but when the same file also
 * spells out `true`, or computes the value somewhere else, the answer is
 * `conditional` rather than a confident `literal-false`.
 */
export function readHeadlessEvidence(text: string): HeadlessEvidence {
  let literalFalse = false;
  let literalTrue = false;
  let computed: string | undefined;

  HEADLESS_BINDING.lastIndex = 0;
  for (const match of text.matchAll(HEADLESS_BINDING)) {
    const value = (match[1] ?? '').trim();
    if (LITERAL_FALSE.test(value)) literalFalse = true;
    else if (LITERAL_TRUE.test(value)) literalTrue = true;
    // An empty capture means the value wrapped onto the next line: the key is
    // there and its value is not readable, which is exactly `computed`.
    else computed ??= value.length > 0 ? shorten(value) : '(value on the next line)';
  }

  if (literalFalse && (literalTrue || computed !== undefined)) return { shape: 'conditional' };
  if (literalFalse) return { shape: 'literal-false' };
  if (computed !== undefined) return { shape: 'computed', expression: computed };
  if (literalTrue) return { shape: 'literal-true' };

  const key = delegatedOptionKey(text);
  return key === undefined ? { shape: 'absent' } : { shape: 'delegated', key };
}

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

  if (bin === 'safaridriver') {
    found.push(
      signal({
        kind: 'macos-gui-tool',
        argues: 'vm',
        origin: view.label,
        detail: at('safaridriver'),
        clause:
          'safaridriver drives Safari, which ships only with macOS and has no headless mode at all, so no Linux container can run this; the macOS VM lane gives it a window server that is not your desktop.',
        priority: 17,
        inferred,
        confidence: 'high',
      }),
    );
    return found;
  }

  if (bin === 'wdio') {
    found.push(...(await webdriverSignals(view, inspector)));
    return found;
  }

  if (WEBDRIVER_SERVER_BINS.has(bin)) {
    found.push(...(commandLineHeadless(view) ?? [driverGuess(view, bin, 'server')]));
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
    const evidence = readHeadlessEvidence(config.text);
    if (evidence.shape === 'literal-true') {
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
      // Every remaining shape lands in the container, because vitest browser
      // mode is headed outside CI unless something pins it — but the detail has
      // to say what was actually there. Claiming "headless not set" about a
      // config that sets it from an env var is the exact dishonesty this lane
      // is supposed to avoid.
      const state =
        evidence.shape === 'computed'
          ? `headless is computed at runtime (headless: ${evidence.expression})`
          : evidence.shape === 'delegated'
            ? `browser options come from \`${evidence.key}\`, which offstage does not resolve`
            : evidence.shape === 'literal-false'
              ? 'headless: false'
              : evidence.shape === 'conditional'
                ? 'headless is set both false and true; the branch is chosen at runtime'
                : 'headless not set';
      const readable = evidence.shape === 'absent' || evidence.shape === 'literal-false';
      found.push(
        signal({
          kind: 'vitest-browser-config',
          argues: 'container',
          origin: config.file,
          detail: `${config.file}: browser mode enabled, ${state}`,
          clause: readable
            ? 'The vitest config turns browser mode on without pinning headless, and vitest treats that as headed outside CI; the container lane absorbs the window this would otherwise open on your screen.'
            : 'The vitest config turns browser mode on and works out headless at runtime, which offstage reads but never evaluates, so it cannot tell whether a window opens; it took the container lane, where one that does opens on a virtual display instead of your screen.',
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

/* -------------------------------- WebDriver ------------------------------- */

/**
 * A `--headless` switch, wherever it is written.
 *
 * WebDriver spells headlessness as a browser switch inside a capability blob —
 * `'goog:chromeOptions': { args: ['--headless=new'] }` in a config, or
 * `-c "goog:chromeOptions.args=[--headless]"` on a command line — so the flag
 * parser, which only looks at whole tokens, cannot see it. `--no-headless` and
 * `--headless=false` are deliberately not matches.
 */
const HEADLESS_SWITCH = /(^|[^\w-])--?headless\b(?!\s*[:=]\s*(?:false|0|no|off))/i;

/** The same switch quoted inside a config, which is where it is worth quoting back. */
const QUOTED_HEADLESS_SWITCH = /['"`](--?headless(?:=[\w-]+)?)['"`]/i;

/** `hostname: 'hub.browserstack.com'` — the machine the browser actually runs on. */
const CAPABILITY_HOSTNAME = /\bhostname\s*:\s*['"`]([^'"`]+)['"`]/i;

/** Hostnames that mean "this machine after all", so nothing has moved off it. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * A wdio service that hands the session to a hosted grid: `services: ['sauce']`,
 * `services: ['@wdio/browserstack-service']`. The browser then runs on their
 * hardware, so nothing opens here whatever the capabilities say.
 */
const CLOUD_GRID_SERVICE =
  /services\s*:\s*\[[^\]]*['"`](?:@wdio\/)?(?:sauce|browserstack|lambdatest|testingbot)[\w-]*['"`]/i;

/** `wdio.conf.ts`, `wdio.conf.local.js`, `config/wdio.shared.conf.mts`. */
const WEBDRIVER_CONFIG_REFERENCE = /(?:^|\/)[\w.-]*wdio[\w.-]*\.(?:c|m)?[jt]s$/i;

function hasHeadlessSwitch(text: string): boolean {
  return HEADLESS_SWITCH.test(text);
}

/** The config `wdio run <path>` or `--config <path>` names, if it names one. */
function webdriverConfigPath(args: string[]): string | undefined {
  const explicit = flagValue(args, ['--config', '-c']);
  if (explicit !== undefined) return explicit;
  return args.find((token) => !token.startsWith('-') && WEBDRIVER_CONFIG_REFERENCE.test(token));
}

/**
 * Headlessness settled by the command line itself, including a switch buried in
 * a capability string. `[]` means "argv settled it and `flagSignals` already
 * reported the flag"; `undefined` means argv says nothing either way.
 */
function commandLineHeadless(view: CommandView): Signal[] | undefined {
  const { bin, args } = view.invocation;
  const at = (text: string): string => `${view.label}: ${text}`;

  if (args.some((token) => token.startsWith('-') && isHeadlessFlag(parseFlag(token)))) return [];

  const embedded = args.find((token) => hasHeadlessSwitch(token));
  if (embedded === undefined) return undefined;

  return [
    signal({
      kind: 'headless-flag',
      argues: 'headless',
      origin: view.label,
      detail: at(embedded),
      clause: `The capabilities on this command line launch the browser headless (${embedded}), so ${bin} opens no window and there is nothing for a container to protect.`,
      priority: 38,
      inferred: false,
      confidence: 'high',
    }),
  ];
}

/** What a WebDriver config says about where and how the browser is launched. */
interface CapabilityEvidence {
  signals: Signal[];
  /** True when the browser runs on a grid that is not this machine at all. */
  remote: boolean;
}

function webdriverCapabilities(file: string, text: string): CapabilityEvidence {
  const signals: Signal[] = [];

  const host = text.match(CAPABILITY_HOSTNAME);
  const remoteHost =
    host !== null && !LOCAL_HOSTNAMES.has((host[1] as string).toLowerCase()) ? (host[1] as string) : undefined;
  const remote = remoteHost !== undefined || CLOUD_GRID_SERVICE.test(text);

  if (remote) {
    signals.push(
      signal({
        kind: 'config-headless',
        argues: 'headless',
        origin: file,
        detail: `${file}: browser runs on ${remoteHost ?? 'a hosted grid'}`,
        clause: `${file} points the WebDriver session at ${
          remoteHost ?? 'a hosted grid'
        }, so the browser opens on that machine and never on yours; offstage just runs the client here.`,
        priority: 36,
        inferred: true,
        confidence: 'high',
      }),
    );
    return { signals, remote };
  }

  const quoted = text.match(QUOTED_HEADLESS_SWITCH);
  // `headless: false` next to a `--headless` arg is a contradiction the config
  // owner has to settle; offstage reports the headed reading, because a window
  // on your real screen is the worse way to be wrong. `conditional` counts as a
  // literal false: it is the shape a file takes when it spells out both.
  const spelledHeadless = readHeadlessEvidence(text).shape;
  const spelledFalse = spelledHeadless === 'literal-false' || spelledHeadless === 'conditional';
  if (quoted !== null && !spelledFalse) {
    const switchText = quoted[1] as string;
    signals.push(
      signal({
        kind: 'config-headless',
        argues: 'headless',
        origin: file,
        detail: `${file}: capabilities pass ${switchText}`,
        clause: `${file} launches the browser with ${switchText}, so the WebDriver session opens no window and running it in place is already safe.`,
        priority: 37,
        inferred: true,
        confidence: 'high',
      }),
    );
  }

  return { signals, remote };
}

/**
 * The honest answer when nothing settles it: container, and say why.
 *
 * A WebDriver tool with no readable capabilities is the one case offstage
 * cannot reason its way out of, so it picks the lane where being wrong is
 * harmless and reports low confidence rather than a confident guess.
 */
function driverGuess(view: CommandView, bin: string, shape: 'runner' | 'server'): Signal {
  const what =
    shape === 'server'
      ? `${bin} opens no window itself, but it launches a real browser as soon as a client asks it for a session, and the capabilities that decide whether that browser is headless are not here`
      : `${bin} drives a real browser through WebDriver, which has no headless default, and no config this router can read says otherwise`;

  return signal({
    kind: 'headed-driver',
    argues: 'container',
    origin: view.label,
    detail: `${view.label}: ${bin} (no headless capability found)`,
    clause: `${what}; offstage routes it to the container lane, where a window is harmless, and reports low confidence because it is a default rather than an observation. Pass --headless, or put the headless switch in the capabilities, and it runs in place.`,
    priority: 32,
    inferred: false,
    confidence: 'low',
  });
}

/**
 * WebdriverIO: read the capabilities instead of guessing from the tool name.
 *
 * `wdio` is the one browser runner whose headedness is written neither in its
 * argv nor in a default, but in the config it is pointed at. So the router
 * opens that file — the one the command names, or the usual one at the root —
 * and looks for the thing that actually settles it: a `--headless` switch in
 * the browser options, a `headless` key, or a grid that puts the browser on
 * someone else's machine entirely.
 */
async function webdriverSignals(view: CommandView, inspector: Inspector): Promise<Signal[]> {
  const found: Signal[] = [];
  const at = (text: string): string => `${view.label}: ${text}`;

  // An explicit headless request on the command line settles the lane, but the
  // config is still worth reading: a `headless: false` in it is real evidence,
  // and reporting it as overridden explains more than hiding it would.
  const settledByArgv = commandLineHeadless(view);
  if (settledByArgv !== undefined) found.push(...settledByArgv);

  const configPath = webdriverConfigPath(view.invocation.args);
  const config = await inspector.webdriverConfig(configPath);

  if (config === undefined && configPath !== undefined) {
    found.push(
      signal({
        kind: 'unreadable-config',
        argues: null,
        origin: view.label,
        detail: at(`${configPath} could not be read`),
        clause: 'The named WebdriverIO config could not be read.',
        priority: 80,
        inferred: true,
        confidence: 'low',
      }),
    );
  }

  if (config !== undefined) {
    const capabilities = webdriverCapabilities(config.file, config.text);
    // A remote grid moves the browser off this machine, which makes the local
    // launch options in the same file irrelevant to your screen.
    /* wdio has no headless default, so a value offstage could not read must not
       fall back to one. See configSignals' `defaultsHeadless`. */
    if (!capabilities.remote) found.push(...configSignals(config.file, config.text, false));
    found.push(...capabilities.signals);
  }

  const decided = settledByArgv !== undefined || found.some((item) => item.argues !== null);
  if (!decided) found.push(driverGuess(view, 'wdio', 'runner'));
  return found;
}

/* ------------------------------ config files ------------------------------ */

/**
 * Turn what a file was willing to reveal about `headless` into one signal.
 *
 * The two readable shapes keep the confident answers they have always had. The
 * three unreadable ones are the point of this function: rather than fall
 * through to "the tool is headless by default" — true of the tool, unknown of
 * this repository — they produce a signal that argues for the default lane and
 * says, in the reason the user actually reads, which expression offstage could
 * not evaluate and what to do about it.
 */
function headlessEvidenceSignal(
  file: string,
  evidence: HeadlessEvidence,
  source: 'config' | 'script',
  /**
   * Whether the tool this file configures runs headless when the file says
   * nothing. Playwright, Puppeteer and Vitest browser mode do; WebDriver does
   * not. It only matters for the two shapes offstage cannot read — `computed`
   * and `delegated` — where the fallback *is* the tool's default, and assuming
   * a headless one the tool does not have would put a real window on the
   * user's screen.
   */
  defaultsHeadless = true,
): Signal | undefined {
  /** Same sentence either way; only the noun for the file changes. */
  const noun = source === 'config' ? 'config' : 'script';

  switch (evidence.shape) {
    case 'literal-false':
      return signal({
        kind: 'config-headed',
        argues: 'container',
        origin: file,
        detail: `${file}: headless: false`,
        clause: `${file} sets headless: false, so this run would open a real browser window on your desktop; the container lane gives it an Xvfb display to open into instead.`,
        priority: 22,
        inferred: true,
        confidence: 'high',
      });

    case 'literal-true':
      return signal({
        kind: 'config-headless',
        argues: 'headless',
        origin: file,
        detail: `${file}: headless: true`,
        clause: `${file} pins headless: true, so no window opens anywhere and the run is already safe to do in place.`,
        priority: 39,
        inferred: true,
        confidence: 'high',
      });

    case 'conditional':
      // Both spellings are in the file, so the branch that runs is chosen at
      // runtime. Keeping `config-headed` matters: an explicit `--headless` on
      // the command line still overrides this, exactly as it overrides a plain
      // `headless: false`.
      return signal({
        kind: 'config-headed',
        argues: 'container',
        origin: file,
        detail: `${file}: headless is set both false and true; the branch is chosen at runtime`,
        clause: `${file} spells out headless both ways and picks between them at runtime, which offstage reads but does not evaluate, so it cannot tell which one this run gets; it took the branch that would open a window and routed to the container lane, because that is the cheaper way to be wrong. Pass --headless if you know this run is the headless branch.`,
        priority: 22,
        inferred: true,
        confidence: 'low',
      });

    case 'computed':
      return signal({
        kind: 'computed-headless',
        argues: defaultsHeadless ? 'headless' : 'container',
        origin: file,
        detail: `${file}: headless is computed at runtime (headless: ${evidence.expression})`,
        clause: defaultsHeadless
          ? `${file} computes headless at runtime, from \`${evidence.expression}\`, and offstage reads files without ever executing them — so it genuinely cannot know whether this run opens a window. It kept the default headless lane rather than bill you for a container on a guess; if a window does open, re-run with --headed and it goes to the container lane.`
          : `${file} computes headless at runtime, from \`${evidence.expression}\`, and offstage reads files without ever executing them — so it genuinely cannot know whether this run opens a window. Unlike Playwright, this tool has no headless default to fall back on: if that expression comes out false, a real window opens on your desktop. It routed to the container lane, because that is the cheaper way to be wrong. Pass --headless if you know this run is the headless one.`,
        priority: defaultsHeadless ? 38 : 22,
        inferred: true,
        confidence: 'low',
      });

    case 'delegated':
      return signal({
        kind: 'computed-headless',
        argues: defaultsHeadless ? 'headless' : 'container',
        origin: file,
        detail: `${file}: browser options come from \`${evidence.key}\`, which offstage does not resolve`,
        clause: defaultsHeadless
          ? `${file} hands its browser options over as \`${evidence.key}\` rather than writing them out, and offstage reads one ${noun} without following what it imports, so a headless: false could be sitting one file away. It kept the default headless lane and lowered its confidence instead of claiming a window will not open; re-run with --headed if one does.`
          : `${file} hands its browser options over as \`${evidence.key}\` rather than writing them out, and offstage reads one ${noun} without following what it imports, so a headless: false could be sitting one file away. This tool has no headless default that would make that a safe bet, so it routed to the container lane rather than risk a window on your desktop; pass --headless if you know this run is the headless one.`,
        priority: defaultsHeadless ? 38 : 22,
        inferred: true,
        confidence: 'low',
      });

    case 'absent':
      return undefined;
  }
}

/**
 * Signals read out of a browser config file.
 *
 * `defaultsHeadless` describes the tool the file belongs to, not the file: it
 * is what the run does when the file settles nothing. Playwright-shaped configs
 * leave it true; WebdriverIO passes false, because wdio has no headless default
 * and the whole point of reading its config is that guessing one is unsafe.
 */
function configSignals(file: string, text: string, defaultsHeadless = true): Signal[] {
  const found: Signal[] = [];

  const headlessSignal = headlessEvidenceSignal(
    file,
    readHeadlessEvidence(text),
    'config',
    defaultsHeadless,
  );
  if (headlessSignal !== undefined) found.push(headlessSignal);

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

    const evidence = readHeadlessEvidence(file.text);
    const unreadable =
      evidence.shape === 'computed' || evidence.shape === 'delegated'
        ? headlessEvidenceSignal(file.file, evidence, 'script')
        : undefined;

    if (evidence.shape === 'literal-false' || evidence.shape === 'conditional') {
      const conditional = evidence.shape === 'conditional';
      found.push(
        signal({
          kind: 'script-headed',
          argues: 'container',
          origin: file.file,
          detail: conditional
            ? `${file.file}: launches ${library} with headless set both ways, chosen at runtime`
            : `${file.file}: launches ${library} with headless: false`,
          clause: conditional
            ? `${file.file} launches ${library} with headless spelled both false and true and chooses between them at runtime; offstage reads the script without running it, so it cannot tell which branch this run takes and sent it to the container lane, where a window that does open lands on a virtual display instead of yours.`
            : `${file.file} launches ${library} with headless: false, so running it here would open a real browser window; the container lane gives that window a virtual display.`,
          priority: 23,
          inferred,
          confidence: conditional ? 'low' : 'high',
        }),
      );
    } else if (unreadable !== undefined) {
      found.push(unreadable);
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
