/**
 * offstage — the router.
 *
 * Give it a repository and a command; it answers with a lane and a sentence a
 * human can agree or disagree with. It never runs the command, never starts a
 * browser, never shells out to anything: classifying is argv inspection plus a
 * few small read-only file probes, which makes it fast enough to do on every
 * invocation and cheap enough to unit test exhaustively.
 *
 * ## The policy, in one place
 *
 * - **headless is the default, and that is the point.** `npx playwright test`
 *   and a plain `puppeteer.launch()` are already headless: they open no window
 *   and steal no focus. Wrapping them in a container buys nothing and costs
 *   container startup on every run, so offstage says "run it right here, and
 *   here is why that was already safe."
 * - **container when the web command genuinely needs a head**: `--headed`,
 *   `headless: false` in a detected config, WebGL/GPU switches, Chrome
 *   extension loading, video or screen capture, Playwright UI mode, `cypress
 *   open`, vitest browser mode outside CI. These cannot honestly run headless,
 *   so they get a Linux container with an Xvfb virtual display — a real head,
 *   just not yours.
 * - **WebDriver is read, not guessed.** `wdio` has no headless default, so the
 *   router opens the config the command names and looks for what actually
 *   settles it — a `--headless` switch in the capabilities, a `headless` key,
 *   or a hosted grid that runs the browser on someone else's machine. Only
 *   when there is nothing to read does it fall back to the container lane, and
 *   it says so at low confidence.
 * - **vm for macOS-native work**: `xcodebuild`, `xcrun simctl`, XCUITest
 *   schemes, `open` of a `.app`, a `.dmg`, a targeted `.xcodeproj`,
 *   `safaridriver`. No container can run these at all.
 * - **everything else is headless**, because no display is involved anywhere.
 *
 * When the evidence is thin or contradictory the answer comes back with
 * `confidence: 'low'` and a `reason` that says so, rather than a confident
 * guess.
 */

import type { Lane, RouteDecision } from '../contract/index.js';
import { RouteDecisionSchema } from '../contract/index.js';

import { createInspector } from './inspect.js';
import type { Inspector } from './inspect.js';
import type { ClassifyHints, Signal } from './signals.js';
import { buildViews, collectSignals } from './signals.js';

export type { ClassifyHints, CommandView, Signal, SignalKind } from './signals.js';
export type { Inspector, InspectedFile, PackageFacts } from './inspect.js';
export type { Invocation, ScriptInvocation } from './tokenize.js';
export { createInspector } from './inspect.js';
export { basenameOf, normalizeInvocation, parseScriptInvocation, tokenizeShellish } from './tokenize.js';

/** What the router needs to decide. */
export interface ClassifyInput {
  /** Absolute path to the repository the command runs against. */
  cwd: string;
  /** Already-split argv. Never a shell string. */
  command: string[];
  /** Caller intent, from `offstage run --headed` or an MCP argument. */
  hints?: ClassifyHints;
  /**
   * Reuse an inspector instead of building one. Only useful for tests and for
   * callers that classify several commands against the same repository.
   */
  inspector?: Inspector;
}

/**
 * Decide which lane should run `command`, and say why.
 *
 * Never throws for a repository it cannot read — a missing `package.json`,
 * an unreadable config, a `cwd` that does not exist are all just less evidence.
 * It does throw for a malformed call, because an empty argv is a bug in the
 * caller and silently returning "headless" would hide it.
 */
export async function classify(input: ClassifyInput): Promise<RouteDecision> {
  if (typeof input?.cwd !== 'string' || input.cwd.length === 0) {
    throw new TypeError('classify() requires a non-empty cwd');
  }
  if (!Array.isArray(input.command) || input.command.length === 0) {
    throw new TypeError('classify() requires a non-empty command argv');
  }
  if (input.command.some((token) => typeof token !== 'string')) {
    throw new TypeError('classify() requires every command token to be a string');
  }

  const inspector = input.inspector ?? createInspector(input.cwd);
  const views = await buildViews(input.command, inspector);
  const signals = await collectSignals(views, inspector, input.hints);

  return RouteDecisionSchema.parse(decide(signals));
}

/* -------------------------------------------------------------------------- */
/* Deciding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Signals that only make sense as an explanation of a headless verdict.
 * "Playwright is headless by default" is true but misleading next to a
 * `--headed` that overrode it, so these are dropped unless headless wins.
 */
const FRAMING_KINDS = new Set(['browser-default', 'no-display-tool', 'no-signal']);

/**
 * Container evidence that is a default or an inference rather than something
 * the command literally says. An explicit `--headless` on the command line
 * outranks these — it is the thing that will actually be executed. It does
 * *not* outrank a literal `--headed`.
 *
 * `headed-driver` belongs here for the same reason `config-headed` does, only
 * more so: it is the router admitting it could not find the capabilities, so a
 * caller who knows the run is headless must be able to say so and be believed.
 */
const OVERRIDABLE_KINDS = new Set([
  'config-headed',
  'script-headed',
  'vitest-browser-config',
  'headed-driver',
]);

const NOTHING_FOUND: Signal = {
  kind: 'no-signal',
  argues: 'headless',
  origin: 'argv',
  detail: 'argv: no browser, GPU or macOS-native signal found',
  clause:
    'Nothing in this command names a browser, a GPU, or a macOS-native tool, so offstage found no display to protect and runs it in place. If it does open a window, re-run with --headed and it will go to the container lane.',
  priority: 90,
  inferred: false,
  confidence: 'low',
};

function decide(collected: Signal[]): RouteDecision {
  const signals = collected.map((item) => ({ ...item }));

  // An explicit headless request on the command line, or from the caller.
  const override = signals.find(
    (item) => (item.kind === 'headless-flag' && !item.inferred) || item.kind === 'headless-hint',
  );

  const overridePhrase =
    override === undefined
      ? ''
      : override.kind === 'headless-hint'
        ? "the caller's headless hint"
        : override.detail.replace(/^[^:]+:\s*/, '');

  let suppressed = 0;
  const suppressedKinds = new Set<string>();
  if (override !== undefined) {
    for (const item of signals) {
      if (item.argues === 'container' && OVERRIDABLE_KINDS.has(item.kind)) {
        item.argues = null;
        item.detail = `${item.detail} (overridden by ${overridePhrase})`;
        suppressedKinds.add(item.kind);
        suppressed += 1;
      }
    }
  }

  if (!signals.some((item) => item.argues !== null)) signals.push({ ...NOTHING_FOUND });

  const hasVm = signals.some((item) => item.argues === 'vm');
  const hasContainer = signals.some((item) => item.argues === 'container');
  const lane: Lane = hasVm ? 'vm' : hasContainer ? 'container' : 'headless';

  const kept = signals.filter((item) => lane === 'headless' || !FRAMING_KINDS.has(item.kind));
  const forLane = kept.filter((item) => item.argues === lane).sort((a, b) => a.priority - b.priority);
  const primary = forLane[0] ?? NOTHING_FOUND;

  const notes: string[] = [];
  let confidence: 'high' | 'low' = primary.confidence;

  if (hasVm && hasContainer) {
    confidence = 'low';
    notes.push(
      'This command also carries headed-browser signals; the macOS VM lane wins because a Linux container cannot run macOS tooling at all.',
    );
  }
  if (lane === 'container' && override !== undefined) {
    confidence = 'low';
    notes.push(
      `This also carries ${overridePhrase}, which contradicts the headed request above; offstage kept the container lane because a headed run on your real screen is the worse way to be wrong.`,
    );
  }
  if (lane === 'headless' && suppressed > 0) {
    const driverOnly = suppressedKinds.size === 1 && suppressedKinds.has('headed-driver');
    notes.push(
      driverOnly
        ? 'A WebDriver tool here has no headless default and offstage could not find the capabilities, but the command overrides that guess, so nothing will open a window.'
        : 'A config in this repository asks for a headed browser, but the command overrides it, so nothing will open a window.',
    );
  }

  const reason = [primary.clause, ...notes].join(' ');

  const rank = (item: Signal): number => (item.argues === lane ? 0 : item.argues === null ? 2 : 1);
  const ordered = [...kept].sort((a, b) => rank(a) - rank(b) || a.priority - b.priority);

  const details: string[] = [];
  for (const item of ordered) {
    if (!details.includes(item.detail)) details.push(item.detail);
  }

  return { lane, reason, confidence, signals: details };
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

export interface ExplainOptions {
  /** Hard cap on the rendered line, including the ellipsis. Default 160. */
  maxLength?: number;
  /** Echo the command being classified, between the lane and the reason. */
  command?: string[];
  /** Include the observations behind the decision. Default true. */
  includeSignals?: boolean;
}

const DEFAULT_MAX_LENGTH = 160;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Render a decision as one line, for a terminal or an agent transcript.
 *
 * ```
 * container (high) — npx playwright test --headed — The command asks for a headed browser… — signals: argv: --headed
 * ```
 *
 * The result never contains a newline or a tab, and never exceeds `maxLength`,
 * so it is safe to drop into a progress line or a table cell.
 */
export function explain(decision: RouteDecision, options: ExplainOptions = {}): string {
  const maxLength = Math.max(8, options.maxLength ?? DEFAULT_MAX_LENGTH);

  const render = (withSignals: boolean): string => {
    const parts = [`${decision.lane} (${decision.confidence})`];
    if (options.command !== undefined && options.command.length > 0) {
      parts.push(collapse(options.command.join(' ')));
    }
    parts.push(collapse(decision.reason));
    if (withSignals && decision.signals.length > 0) {
      parts.push(`signals: ${decision.signals.map(collapse).join('; ')}`);
    }
    return collapse(parts.join(' — '));
  };

  const full = render(options.includeSignals !== false);
  if (full.length <= maxLength) return full;

  // The reason is the part worth keeping, so the observations go first when the
  // line does not fit. Only then does it get cut mid-sentence.
  const withoutSignals = render(false);
  if (withoutSignals.length <= maxLength) return withoutSignals;

  return `${withoutSignals.slice(0, maxLength - 1).trimEnd()}…`;
}
