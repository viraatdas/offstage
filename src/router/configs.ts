/**
 * offstage: what a file on disk says about `headless`.
 *
 * This is the router's honesty boundary. offstage reads configs and scripts; it
 * never evaluates them, because a router that evaluated your config to find out
 * whether it opens a window could open a window while deciding. So a file that
 * computes `headless` at runtime comes back as `computed` with the expression
 * quoted, not as a guess at what that expression will produce.
 */

import { BROWSER_LIBRARY, SCRIPT_REFERENCE } from './bins.js';
import { isExtensionFlag, isGpuFlag, parseFlag } from './flags.js';
import type { Inspector } from './inspect.js';
import type { Signal } from './signal.js';
import { signal } from './signal.js';
import type { CommandView } from './views.js';

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
 * - `literal-false` / `literal-true`: the value is spelled out; believe it.
 * - `conditional`: the file spells out *both*, so which one applies is decided
 *   at runtime. Container is the safe way to be wrong, but not a confident one.
 * - `computed`: the key is there and the value is an expression: an env var, a
 *   variable, a ternary, a function call.
 * - `delegated`: the browser options are a reference to something offstage did
 *   not read; the `headless` that matters may be one import away.
 * - `absent`: no `headless` key at all, which is the honest, common case where
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
 * reference rather than an object literal (`use: baseUse`, `use: makeUse()`,
 * or the `{ use }` shorthand over an import) everything offstage cares about
 * lives in a file it did not open.
 */
const BROWSER_OPTION_KEYS = ['use', 'launchOptions', 'contextOptions'];

/** Keep a quoted expression short enough to sit in a one-line signal. */
export function shorten(expression: string, limit = 60): string {
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
 * open is the thing offstage exists to catch, but when the same file also
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


/* ------------------------------ config files ------------------------------ */

/**
 * Turn what a file was willing to reveal about `headless` into one signal.
 *
 * The two readable shapes keep the confident answers they have always had. The
 * three unreadable ones are the point of this function: rather than fall
 * through to "the tool is headless by default" (true of the tool, unknown of
 * this repository) they produce a signal that argues for the default lane and
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
   * not. It only matters for the two shapes offstage cannot read, `computed`
   * and `delegated`, where the fallback *is* the tool's default, and assuming
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
          ? `${file} computes headless at runtime, from \`${evidence.expression}\`, and offstage reads files without ever executing them, so it genuinely cannot know whether this run opens a window. It kept the default headless lane rather than bill you for a container on a guess; if a window does open, re-run with --headed and it goes to the container lane.`
          : `${file} computes headless at runtime, from \`${evidence.expression}\`, and offstage reads files without ever executing them, so it genuinely cannot know whether this run opens a window. Unlike Playwright, this tool has no headless default to fall back on: if that expression comes out false, a real window opens on your desktop. It routed to the container lane, because that is the cheaper way to be wrong. Pass --headless if you know this run is the headless one.`,
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
export function configSignals(file: string, text: string, defaultsHeadless = true): Signal[] {
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
 * names a local source file, the router reads it, never runs it, and looks for
 * a browser launch.
 */
export async function referencedScriptSignals(view: CommandView, inspector: Inspector): Promise<Signal[]> {
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
export async function repositorySignals(existing: Signal[], inspector: Inspector): Promise<Signal[]> {
  const projects = await inspector.xcodeProjects();
  if (projects.length === 0) return [];

  const names = projects.join(', ');
  const targeted = existing.some((item) => item.argues === 'session' || item.refuses === true);

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