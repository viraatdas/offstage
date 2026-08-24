/**
 * offstage: what a signal is.
 *
 * The router does not pattern-match a command onto a lane. It collects
 * individual, quotable observations, and then decides. This module is the type
 * that carries one such observation, and nothing else: every other file under
 * `src/router/` produces these, and `./signals.ts` weighs them.
 *
 * A signal carries four things beyond its text:
 *
 * - `argues`: which lane it is evidence for, or `null` for pure context.
 * - `priority`: lower wins the right to phrase the decision's `reason`.
 * - `inferred`: true when it came from a config file, a script, or a caller
 *   hint rather than from the argv that will literally be executed. Inferred
 *   evidence can be overridden by an explicit `--headless`; literal argv cannot.
 * - `confidence`: whether this observation alone is enough to be sure.
 */

import type { Lane } from '../contract/index.js';

/* -------------------------------------------------------------------------- */
/* Signal shape                                                               */
/* -------------------------------------------------------------------------- */

export type SignalKind =
  // session: macOS-native GUI work, which needs a real window server but not
  // a fresh machine.
  | 'xcodebuild'
  | 'xcrun-simctl'
  | 'xcrun'
  | 'uitest-scheme'
  | 'xcode-target'
  | 'open-app'
  | 'app-binary'
  | 'macos-gui-tool'
  | 'open-other'
  // refused: anything that could change the machine it runs on. offstage has
  // no lane that isolates that, so these force `RouteDecision.refuse` instead
  // of arguing for a lane. `macos-gui-tool` covers `hdiutil` here too, the one
  // MACOS_GUI_BINS member that refuses rather than arguing `session`.
  | 'dmg-path'
  | 'pkg-path'
  | 'installer'
  // container
  | 'headed-flag'
  | 'headed-hint'
  | 'config-headed'
  | 'script-headed'
  | 'inspector-flag'
  | 'headed-subcommand'
  | 'headed-env'
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
  | 'headless-env'
  | 'config-headless'
  | 'computed-headless'
  | 'browser-default'
  | 'no-display-tool'
  | 'disable-gpu'
  | 'no-signal'
  // context only
  | 'recorded-video'
  | 'xcode-repo'
  | 'shell-expansion'
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
  /**
   * True when this observation, on its own, means offstage refuses to run the
   * command in any lane: it could change the machine, and no lane isolates
   * that. Independent of `argues`: a refusing signal usually argues `null`,
   * since it is not evidence *for* a lane. See `decide()` in `./index.js`.
   */
  refuses?: boolean;
}

export function signal(init: Signal): Signal {
  return init;
}
