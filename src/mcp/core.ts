/**
 * offstage — what the MCP server calls.
 *
 * This is a seam, not an implementation. Every tool is `src/cli/api.ts`, which
 * is the same code path `offstage run` takes: one router, one dispatch, one
 * `result.json`, one safety refusal. An agent calling `offstage_run` and a
 * human typing `offstage run` must never be able to get different answers, and
 * the only way to guarantee that is for there to be nothing here to diverge.
 *
 * The interface exists so tests can hand the server a fake core without a
 * container runtime or a live macOS helper session.
 */

import type { RouteDecision } from '../contract/index.js';
import type {
  DoctorReport,
  ProbeInput,
  RouteInput,
  RunInput,
  RunOutcome,
  SessionInputResult,
  SessionScreenshotInput,
  SessionScreenshotResult,
  SessionStatus,
} from '../cli/api.js';
import {
  doctor,
  probe,
  route,
  run,
  sessionApps,
  sessionInput,
  sessionScreenshot,
  sessionStatus,
} from '../cli/api.js';
import type { EntitlementsProbeReport } from '../probe/index.js';
import type { SessionApp } from '../session/index.js';

export type {
  DoctorReport,
  ProbeInput,
  RouteInput,
  RunInput,
  RunOutcome,
  SessionInputResult,
  SessionScreenshotInput,
  SessionScreenshotResult,
  SessionStatus,
} from '../cli/api.js';

/**
 * `offstage session setup` is deliberately absent.
 *
 * It runs one script as root through `sudo`, and `sudo` needs a terminal to
 * prompt on. An MCP server has none, so the tool would either hang forever or
 * fail with a message about askpass. The status tool says "run `offstage
 * session setup` in a terminal" instead, which is an instruction the agent can
 * pass to the human who has one.
 */
export interface OffstageCore {
  doctor(): Promise<DoctorReport>;
  route(input: RouteInput): Promise<RouteDecision>;
  run(input: RunInput): Promise<RunOutcome>;
  probe(input: ProbeInput): Promise<EntitlementsProbeReport>;
  sessionStatus(input: { user?: string }): Promise<SessionStatus>;
  sessionScreenshot(input: SessionScreenshotInput): Promise<SessionScreenshotResult>;
  sessionInput(input: { actions: unknown; user?: string }): Promise<SessionInputResult>;
  sessionApps(input: { user?: string }): Promise<SessionApp[]>;
}

export function createDefaultCore(): OffstageCore {
  return {
    doctor: () => doctor(),
    route: (input) => route(input),
    run: (input) => run(input),
    probe: (input) => probe(input),
    sessionStatus: (input) => sessionStatus(input),
    sessionScreenshot: (input) => sessionScreenshot(input),
    sessionInput: (input) => sessionInput(input),
    sessionApps: (input) => sessionApps(input),
  };
}
