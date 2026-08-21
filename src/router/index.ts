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
 *   extension loading, desktop or tab screen capture, Playwright UI mode,
 *   `cypress open`, vitest browser mode outside CI. These cannot honestly run
 *   headless, so they get a Linux container with an Xvfb virtual display — a
 *   real head, just not yours.
 * - **recording video is not one of them.** `--video=on` looks like it needs a
 *   screen and does not: Playwright pulls frames out of the browser over CDP
 *   and muxes them with its own ffmpeg, so a headless run writes the same
 *   `.webm`. Only capture of a *desktop or another window* needs a display.
 * - **WebDriver is read, not guessed.** `wdio` has no headless default, so the
 *   router opens the config the command names and looks for what actually
 *   settles it — a `--headless` switch in the capabilities, a `headless` key,
 *   or a hosted grid that runs the browser on someone else's machine. Only
 *   when there is nothing to read does it fall back to the container lane, and
 *   it says so at low confidence.
 * - **what it cannot see, it says out loud.** A repository that computes
 *   `headless` at runtime — from an env var, a variable, a call, another module
 *   — is invisible to the router by construction, because reading files is the
 *   whole safety argument: a router that evaluated your config to find out
 *   whether it opens a window could open a window while deciding. So offstage
 *   keeps the default lane, drops to `confidence: 'low'`, and names the
 *   expression it could not evaluate, instead of reporting the tool's default
 *   as though it had read yours.
 * - **session for macOS-native GUI work**: `xcodebuild`, `xcrun`, `xcrun
 *   simctl`, XCUITest schemes, a targeted `.xcodeproj`, `open -a`, the binary
 *   inside a `.app`, `safaridriver`, `osascript`, `instruments`. No Linux
 *   container can run any of these — they need a real macOS window server. But
 *   they do not need a *fresh machine*, only a display that is not yours, and
 *   macOS already has one: a second local account, logged in and sitting in the
 *   background with its own framebuffer, its own keyboard and mouse stream and
 *   its own running apps. That is the session lane, and it costs a socket
 *   connection rather than a 27–69 GB VM image. See `docs/session-lane.md`.
 * - **vm for work that can change the machine**: a `.dmg`, a `.pkg`, the
 *   `installer` command, `hdiutil`. The session lane is session isolation, not
 *   machine isolation — same OS, same kernel, same disk — so an installer that
 *   damages the system would damage *your* system. Those get a disposable macOS
 *   guest instead, and they outrank every session signal for exactly that
 *   reason.
 * - **everything else is headless**, because no display is involved anywhere.
 *
 * Precedence when signals disagree: `vm` > `session` > `container` >
 * `headless`. A disposable machine beats a spare display, a spare macOS display
 * beats a Linux one, and any of them beats running on your screen.
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

/**
 * Evidence that says "a file decides this at runtime and offstage does not run
 * files". An explicit `--headless` settles that question: the value the router
 * could not read is no longer the value that will be used, so the doubt is
 * retired rather than left to drag the decision's confidence down. It stays in
 * `signals`, annotated, because the config still says what it says.
 */
const UNREADABLE_KINDS = new Set(['computed-headless']);

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
      } else if (UNREADABLE_KINDS.has(item.kind)) {
        item.argues = null;
        item.detail = `${item.detail} (settled by ${overridePhrase})`;
      }
    }
  }

  if (!signals.some((item) => item.argues !== null)) signals.push({ ...NOTHING_FOUND });

  const hasVm = signals.some((item) => item.argues === 'vm');
  const hasSession = signals.some((item) => item.argues === 'session');
  const hasContainer = signals.some((item) => item.argues === 'container');
  const lane: Lane = hasVm ? 'vm' : hasSession ? 'session' : hasContainer ? 'container' : 'headless';

  const kept = signals.filter((item) => lane === 'headless' || !FRAMING_KINDS.has(item.kind));
  const forLane = kept.filter((item) => item.argues === lane).sort((a, b) => a.priority - b.priority);
  const primary = forLane[0] ?? NOTHING_FOUND;

  const notes: string[] = [];
  let confidence: 'high' | 'low' = primary.confidence;

  if (hasVm && hasSession) {
    notes.push(
      'The command also carries macOS GUI signals that the session lane could run, but an installer/disk image needs a disposable machine, so the VM lane wins.',
    );
  }
  if (hasVm && hasContainer) {
    confidence = 'low';
    notes.push(
      'This command also carries headed-browser signals; the macOS VM lane wins because a Linux container cannot run macOS tooling at all.',
    );
  }
  if (lane === 'session' && hasContainer) {
    confidence = 'low';
    notes.push(
      'This also carries headed-browser signals; the session lane wins because a Linux container cannot run macOS apps.',
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
  // An unresolved shell expansion is the one thing the router cannot read its
  // way past: `npx playwright test $FLAGS` may or may not open a window, and
  // only the shell that runs it knows. Reporting the confident default here
  // would be the router asserting something it has no evidence for. An
  // explicit headless flag on the command line still settles it.
  const expansion = signals.find((item) => item.kind === 'shell-expansion');
  if (lane === 'headless' && expansion !== undefined && override === undefined) {
    confidence = 'low';
    notes.push(
      'Part of this command is a shell expansion offstage cannot resolve without running a shell, so it cannot rule out a flag that opens a window; it kept the cheap lane rather than guess. Pass --headed if this run does open one.',
    );
  }
  if (lane === 'headless' && signals.some((item) => item.kind === 'recorded-video')) {
    notes.push(
      'The video recording does not change that: the runner captures frames from the browser it is already driving and encodes them itself, so the file it writes here is the one a headed run would have written. Only capturing a desktop or another window needs a real display.',
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
