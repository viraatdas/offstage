/**
 * offstage: keeping a launched app's windows where the capture can see them.
 *
 * The helper account shares the Mac's physical displays, and the daemon's
 * screenshot (`/usr/sbin/screencapture`) and input coordinates cover only the
 * MAIN display. An app may open its window on any display. Measured: with a
 * second display at x=-1920, i2Message's only window came up at
 * {x:-1920, y:67, w:1920, h:1050}, and every screenshot showed an empty desktop.
 *
 * The daemon's `gather-windows` op moves such windows onto the main display
 * through Accessibility. This module is the host side of that: poll the op
 * until the app has a window, and turn what it did into diagnostics. It is a
 * leaf: it takes a client and injected clock/sleep, and imports nothing from
 * the verbs that call it.
 */

import type { OffDisplayWindow, SessionClient, SessionGatherWindows, WindowFrame } from '../session/index.js';
import { SessionRpcError, isUnknownOpError } from '../session/index.js';

/** How long {@link gatherWindowsOf} keeps asking for a window, by default. */
export const SESSION_GATHER_DEFAULT_WAIT_MS = 3_000;

/** Pause between `gather-windows` attempts while the app has no window yet. */
export const SESSION_GATHER_POLL_MS = 250;

/** The fix line for a daemon that predates `gather-windows`. */
export const GATHER_UPDATE_FIX =
  'Run `offstage session update` (no password) to install the current daemon; `offstage session setup` also installs it.';

export interface GatherOutcome {
  /** False when the daemon predates `gather-windows`. */
  supported: boolean;
  /** The last answer, or null when the op never succeeded. */
  result: SessionGatherWindows | null;
  /** Windows that were moved onto the main display. */
  moved: number;
  diagnostics: string[];
}

const frame = (f: WindowFrame | null): string =>
  f === null ? '(unknown)' : `{x:${Math.round(f.x)}, y:${Math.round(f.y)}, w:${Math.round(f.w)}, h:${Math.round(f.h)}}`;

/** Do two frames overlap by any positive area? Same test as CGRect.intersects. Pure. */
export function intersects(a: WindowFrame, b: WindowFrame): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h && a.w > 0 && a.h > 0;
}

/**
 * Describe what one `gather-windows` answer did, one sentence per window that
 * was off the main display. Windows already on it are not mentioned. Pure.
 */
export function describeGather(result: SessionGatherWindows, label: string): string[] {
  const lines: string[] = [];
  for (const window of result.windows) {
    if (window.before === null) {
      lines.push(`A window of ${label} could not be read through Accessibility${window.error ? ` (${window.error})` : ''}.`);
      continue;
    }
    if (!window.moved && intersects(window.before, result.mainDisplay)) continue; // already on the main display
    if (window.moved) {
      lines.push(
        `Moved a window of ${label} from ${frame(window.before)}, which is off the captured main display ${frame(
          result.mainDisplay,
        )}, to ${frame(window.after)}: screenshots and input only cover the main display.${
          window.error ? ` (partly: ${window.error})` : ''
        }`,
      );
    } else {
      lines.push(
        `A window of ${label} is at ${frame(window.before)}, off the captured main display ${frame(
          result.mainDisplay,
        )}, and could not be moved${window.error ? `: ${window.error}` : ''}. Screenshots will not show it.`,
      );
    }
  }
  return lines;
}

/**
 * Ask the daemon to gather `pid`'s windows, retrying until at least one window
 * is seen or `waitMs` runs out: windows often appear after the app registers.
 *
 * Never throws. A daemon without the op, a missing Accessibility grant and an
 * unreachable socket all become diagnostics, because a launch that succeeded
 * must not be reported as failed over where its window landed.
 */
export async function gatherWindowsOf(
  client: SessionClient,
  pid: number,
  options: {
    label: string;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    waitMs?: number;
  },
): Promise<GatherOutcome> {
  const waitMs = options.waitMs ?? SESSION_GATHER_DEFAULT_WAIT_MS;
  const deadline = options.now() + waitMs;
  let last: SessionGatherWindows | null = null;
  for (;;) {
    try {
      last = await client.gatherWindows(pid);
    } catch (error) {
      if (isUnknownOpError(error)) {
        return {
          supported: false,
          result: null,
          moved: 0,
          diagnostics: [
            `The helper session's daemon is older than window gathering, so ${options.label}'s windows were not checked: if one opened on a display other than the main one, screenshots will not show it. ${GATHER_UPDATE_FIX}`,
          ],
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      const fix = error instanceof SessionRpcError && error.fix !== undefined ? ` Fix: ${error.fix}.` : '';
      return {
        supported: true,
        result: null,
        moved: 0,
        diagnostics: [`Could not check where ${options.label}'s windows opened: ${message}.${fix}`],
      };
    }
    if (last.windows.length > 0) break;
    if (options.now() >= deadline) {
      return {
        supported: true,
        result: last,
        moved: 0,
        diagnostics: [
          `${options.label} showed no window${
            waitMs > 0 ? ` within ${(waitMs / 1000).toFixed(1)}s` : ''
          }, so none was gathered onto the captured display${
            last.axError === null ? '' : ` (AXError ${last.axError})`
          }. If a screenshot does not show it, run \`offstage session gather\` once it has a window.`,
        ],
      };
    }
    await options.sleep(SESSION_GATHER_POLL_MS);
  }
  return {
    supported: true,
    result: last,
    moved: last.windows.filter((window) => window.moved).length,
    diagnostics: describeGather(last, options.label),
  };
}

/**
 * The warning a screenshot carries when windows sit outside what it captured.
 * Empty when there are none. Pure.
 */
export function describeOffDisplayWindows(windows: OffDisplayWindow[]): string[] {
  if (windows.length === 0) return [];
  const list = windows
    .map((w) => `${w.owner ?? `pid ${w.pid}`}${w.name ? ` "${w.name}"` : ''} (pid ${w.pid}) at ${frame(w.bounds)}`)
    .join('; ');
  return [
    `${windows.length} window(s) are on a display this capture doesn't include: ${list}. Run \`offstage session gather <app>\` (or launch the app again with \`offstage session launch\`) to move them onto the main display.`,
  ];
}
