/**
 * offstage: what each web test runner does by default.
 *
 * Playwright, Vitest, Cypress and Puppeteer each have their own answer to
 * "does this open a window", and the answer is usually "no". This module knows
 * those defaults and knows which subcommands break them (`cypress open`,
 * `playwright test --ui`, vitest browser mode outside CI), so the common case
 * stays on the headless lane instead of paying for a container it does not need.
 */

import {
  BROWSER_BINS,
  CYPRESS_BINS,
  NON_DISPLAY_BINS,
  PLAYWRIGHT_BINS,
  PUPPETEER_BINS,
  VITEST_BINS,
  WEBDRIVER_SERVER_BINS,
} from './bins.js';
import { configSignals, readHeadlessEvidence } from './configs.js';
import { flagValue, isFalseish, isHeadlessFlag, parseFlag, subcommandOf } from './flags.js';
import type { Inspector } from './inspect.js';
import type { Signal } from './signal.js';
import { signal } from './signal.js';
import type { CommandView } from './views.js';
import { commandLineHeadless, driverGuess, webdriverSignals } from './webdriver.js';

/* --------------------------------- tools --------------------------------- */

export async function toolSignals(view: CommandView, inspector: Inspector): Promise<Signal[]> {
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
    // container signal, but only when nothing on the command line already
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
        argues: 'session',
        origin: view.label,
        detail: at('safaridriver'),
        clause:
          'safaridriver drives Safari, which ships only with macOS and has no headless mode at all, so no Linux container can run this; offstage runs it in the session lane (a second, logged-in macOS account whose display and input are its own) so the Safari window it opens never reaches your desktop.',
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
      // mode is headed outside CI unless something pins it, but the detail has
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
