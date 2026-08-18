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
 * container runtime or a VM.
 */

import type { RouteDecision } from '../contract/index.js';
import type { DoctorReport, ProbeInput, RouteInput, RunInput, RunOutcome } from '../cli/api.js';
import { doctor, probe, route, run } from '../cli/api.js';
import type { EntitlementsProbeReport } from '../probe/index.js';

export type { DoctorReport, ProbeInput, RouteInput, RunInput, RunOutcome } from '../cli/api.js';

export interface OffstageCore {
  doctor(): Promise<DoctorReport>;
  route(input: RouteInput): Promise<RouteDecision>;
  run(input: RunInput): Promise<RunOutcome>;
  probe(input: ProbeInput): Promise<EntitlementsProbeReport>;
}

export function createDefaultCore(): OffstageCore {
  return {
    doctor: () => doctor(),
    route: (input) => route(input),
    run: (input) => run(input),
    probe: (input) => probe(input),
  };
}
