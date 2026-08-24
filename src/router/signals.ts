/**
 * offstage: collecting the evidence, and reading the argv itself.
 *
 * `classify()` does not pattern-match a command straight onto a lane. It
 * collects *signals* (individual, quotable observations like "argv contains
 * --headed" or "playwright.config.ts sets headless: false") and then decides.
 * That separation is what lets the router explain itself: the lane comes from
 * the strongest signal, and every other observation is still there to print.
 *
 * `collectSignals` is the one place that runs every collector, so the order in
 * which evidence is gathered is visible in a single function. The collectors
 * themselves are split by what they read:
 *
 * - `./macos.ts` reads argv for macOS GUI tools, and for the machine-changing
 *   commands that get refused rather than routed.
 * - `./tools.ts` reads argv for the web test runners and their defaults.
 * - `./webdriver.ts` opens a WebDriver config, because WebDriver has no default
 *   worth guessing at.
 * - `./configs.ts` opens everything else on disk: configs, referenced scripts,
 *   and the repository around them.
 *
 * What stays here is the evidence that comes from the command line and nothing
 * else: env-var prefixes, inline `-e`/`-c` code, unresolvable shell expansions,
 * and whole-token flags. That is the evidence offstage trusts most, because it
 * is the text that will literally be executed.
 */
import { BROWSER_LIBRARY, PLAYWRIGHT_BINS, VITEST_BINS } from './bins.js';
import {
  readHeadlessEvidence,
  referencedScriptSignals,
  repositorySignals,
  shorten,
} from './configs.js';
import {
  isExtensionFlag,
  isFalseish,
  isGpuFlag,
  isHeadedFlag,
  isHeadlessFlag,
  isNoGpuFlag,
  isRecordedVideoFlag,
  isScreenCaptureFlag,
  isTrueish,
  parseFlag,
} from './flags.js';
import { macosSignals } from './macos.js';
import type { Signal } from './signal.js';
import { signal } from './signal.js';
import { toolSignals } from './tools.js';
import type { Inspector } from './inspect.js';
import { basenameOf, normalizeInvocation, parseScriptInvocation, tokenizeShellish } from './tokenize.js';
import type { CommandView } from './views.js';

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
    signals.push(...envPrefixSignals(view));
    signals.push(...flagSignals(view));
    signals.push(...inlineMachineChangeSignals(view));
    signals.push(...inlineScriptSignals(view));
    signals.push(...expansionSignals(view));
    signals.push(...(await toolSignals(view, inspector)));
    signals.push(...(await referencedScriptSignals(view, inspector)));
  }

  signals.push(...(await repositorySignals(signals, inspector)));

  return signals;
}

/* --------------------------------- flags --------------------------------- */

/**
 * Environment assignments carried in the command itself.
 *
 * `env PWDEBUG=1 npx playwright test` normalizes to bin `playwright` with
 * `env` and `PWDEBUG=1` peeled into `prefixes`, so every flag-based signal
 * correctly sees a plain Playwright run, and would route it headless, at high
 * confidence, straight onto the user's screen. The assignment is the whole
 * signal, so it has to be read where it actually is.
 *
 * These are read from argv, never from `process.env`: the router's promise is
 * that its inputs are the ones the caller can see. The CLI maps the ambient
 * `PWDEBUG` onto the `headed` hint separately.
 */
function envPrefixSignals(view: CommandView): Signal[] {
  const found: Signal[] = [];
  const at = (text: string): string => `${view.label}: ${text}`;

  for (const prefix of view.invocation.prefixes) {
    const eq = prefix.indexOf('=');
    if (eq === -1) continue;
    const name = prefix.slice(0, eq).toUpperCase();
    const value = prefix.slice(eq + 1);

    if (name === 'PWDEBUG' && value !== '' && value !== '0') {
      found.push(
        signal({
          kind: 'headed-env',
          argues: 'container',
          origin: view.label,
          detail: at(prefix),
          clause:
            'PWDEBUG opens the Playwright Inspector, which is a real window on a real display whatever the config says; the container lane gives it an Xvfb display to open into instead of your screen.',
          priority: 19,
          inferred: false,
          confidence: 'high',
        }),
      );
      continue;
    }

    if (name === 'HEADLESS' || name === 'HEADED') {
      const asks = name === 'HEADED' ? isTrueish(value) : isFalseish(value);
      const denies = name === 'HEADED' ? isFalseish(value) : isTrueish(value);
      if (asks) {
        found.push(
          signal({
            kind: 'headed-env',
            argues: 'container',
            origin: view.label,
            detail: at(prefix),
            clause:
              `The command sets ${prefix}, which is how this repository asks for a visible browser; the container lane opens that window against an Xvfb virtual display instead of yours.`,
            priority: 22,
            inferred: false,
            confidence: 'high',
          }),
        );
      } else if (denies) {
        found.push(
          signal({
            kind: 'headless-env',
            argues: 'headless',
            origin: view.label,
            detail: at(prefix),
            clause:
              `The command sets ${prefix}, pinning the run headless, so no window opens and there is nothing to isolate.`,
            priority: 39,
            inferred: false,
            confidence: 'high',
          }),
        );
      }
    }
  }

  return found;
}

/** Runtimes that take a program as a string argument rather than a file. */
const INLINE_SCRIPT_BINS = new Set(['node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node']);
const INLINE_SCRIPT_FLAGS = new Set(['-e', '--eval', '-p', '--print', '--eval-file']);

/**
 * A program passed inline: `node -e 'require("puppeteer").launch({headless:false})'`.
 *
 * The router already reads a script the command *names*, and this is the same
 * evidence: the source is simply in argv rather than in a file. Reading it is
 * free and requires no filesystem access at all. Without this the argv
 * literally contains `headless:false` while the router reports, at high
 * confidence, that "no display is involved at all".
 */
/**
 * Interpreters that take a program as a STRING argument. `sh -c` is already
 * tokenized and re-inspected; these are not, and that difference was a hole:
 * `python3 -c "os.execv('/usr/sbin/installer', ...)"` routed to the headless
 * lane with high confidence, which runs it as a direct child with no isolation
 * at all. `osascript -e 'do shell script "..."'` was worse, routing to the
 * session lane, which shares the user's OS and disk and was never isolation
 * from a machine change.
 */
const INLINE_CODE_BINS = new Set([
  'python', 'python2', 'python3', 'ruby', 'perl', 'php', 'osascript',
  'node', 'deno', 'bun', 'tsx', 'ts-node', 'swift',
]);

/** Flags whose VALUE is a program, across those interpreters. */
const INLINE_CODE_FLAGS = new Set(['-c', '-e', '-E', '--eval', '--eval-string']);

/**
 * A machine-changing tool named inside a string of code.
 *
 * Deliberately blunt. Refusing a program that merely mentions the word is the
 * safe direction, and a static router cannot tell a call from a comment; the
 * refusal text tells the caller to run it themselves if that is what they
 * meant. What this CANNOT do is see inside a compiled binary, a script file, a
 * Makefile or an npm script, which is why the guarantee is documented as
 * covering commands that name these tools, not every possible route to one.
 */
const MACHINE_TOOL_IN_CODE =
  /\/usr\/sbin\/installer\b|\/usr\/bin\/hdiutil\b|\binstaller\b|\bhdiutil\b|\.pkg\b|\.dmg\b/;

/** Refuse an inline program that names a machine-changing tool. */
function inlineMachineChangeSignals(view: CommandView): Signal[] {
  if (!INLINE_CODE_BINS.has(view.invocation.bin)) return [];
  const args = view.invocation.args;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    const inline = INLINE_CODE_FLAGS.has(flag)
      ? args[index + 1]
      : /^(?:-e|-c|--eval)=/.test(flag)
        ? flag.slice(flag.indexOf('=') + 1)
        : undefined;
    if (typeof inline !== 'string' || inline === '') continue;
    if (!MACHINE_TOOL_IN_CODE.test(inline)) continue;
    return [
      signal({
        kind: 'installer',
        argues: 'session',
        origin: view.label,
        detail: `${view.label}: ${view.invocation.bin} ${flag} names a machine-changing tool`,
        clause:
          `The program passed inline to ${view.invocation.bin} names installer, hdiutil or an installer package, and running it would change the machine it runs on. offstage cannot read what an arbitrary program will do, so it refuses this rather than route it somewhere that cannot contain it: the session lane is a second account on your own OS and disk, not a second machine. Run it directly yourself if you accept the risk.`,
        priority: 5,
        inferred: false,
        confidence: 'high',
        refuses: true,
      }),
    ];
  }
  return [];
}

function inlineScriptSignals(view: CommandView): Signal[] {
  if (!INLINE_SCRIPT_BINS.has(view.invocation.bin)) return [];
  const found: Signal[] = [];

  const args = view.invocation.args;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] as string;
    const inline = INLINE_SCRIPT_FLAGS.has(flag)
      ? args[index + 1]
      : /^(?:-e|--eval)=/.test(flag)
        ? flag.slice(flag.indexOf('=') + 1)
        : undefined;
    if (typeof inline !== 'string' || inline === '') continue;
    if (!BROWSER_LIBRARY.test(inline)) continue;

    const library = /puppeteer/i.test(inline) ? 'puppeteer' : 'a browser library';
    const evidence = readHeadlessEvidence(inline);
    const where = `${view.label}: ${view.invocation.bin} ${flag}`;

    if (evidence.shape === 'literal-false' || evidence.shape === 'conditional') {
      found.push(
        signal({
          kind: 'script-headed',
          argues: 'container',
          origin: view.label,
          detail: `${where} launches ${library} with headless: false`,
          clause: `The script passed inline to ${view.invocation.bin} launches ${library} with headless: false, so running it here would open a real browser window; the container lane gives that window a virtual display instead of yours.`,
          priority: 23,
          inferred: false,
          confidence: evidence.shape === 'conditional' ? 'low' : 'high',
        }),
      );
    } else if (evidence.shape === 'computed' || evidence.shape === 'delegated') {
      found.push(
        signal({
          kind: 'computed-headless',
          argues: null,
          origin: view.label,
          detail: `${where} computes headless at runtime`,
          clause: `The script passed inline to ${view.invocation.bin} launches ${library} but decides headless at runtime, and offstage reads without evaluating, so it cannot tell whether this run opens a window.`,
          priority: 34,
          inferred: false,
          confidence: 'low',
        }),
      );
    }
  }

  return found;
}

/** `$FOO`, `${FOO}`, `$(cmd)` and backticks: text only a shell can resolve. */
const UNRESOLVABLE_EXPANSION = /\$\(|\$\{|\$[A-Za-z_]|`/;

/**
 * Argv that still contains a shell expansion after everything readable has been
 * read.
 *
 * `npx playwright test $FLAGS` and `sh -c 'npx playwright test ${HEADED:+--headed}'`
 * may or may not open a window; only the shell that runs them knows, and
 * offstage will not run one to find out. Saying nothing would report the
 * confident default. This says "there is text here I could not resolve", which
 * is the same honesty the router already applies to a config it cannot
 * evaluate: keep the cheap lane, drop the confidence, quote the thing.
 */
function expansionSignals(view: CommandView): Signal[] {
  const unresolved = view.invocation.tokens.filter((token) => UNRESOLVABLE_EXPANSION.test(token));
  if (unresolved.length === 0) return [];

  return [
    signal({
      kind: 'shell-expansion',
      argues: null,
      origin: view.label,
      detail: `${view.label}: unresolved shell expansion ${shorten(unresolved[0] as string)}`,
      clause: `This command contains a shell expansion (${shorten(
        unresolved[0] as string,
      )}) that only a shell can resolve, and offstage does not run one to find out what it becomes, so it cannot rule out a flag that opens a window. It kept the cheap lane rather than guess; pass --headed if this run does open one.`,
      priority: 36,
      inferred: false,
      confidence: 'low',
    }),
  ];
}

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
