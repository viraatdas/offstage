import type { Lane, LaneAvailability, LaneResult, LaneRunner, RouteDecision } from '../contract/index.js';
import { LaneResultSchema } from '../contract/index.js';
import { allocateRunDir, writeResult } from '../contract/artifacts.js';
import { containerLane } from '../lanes/container/index.js';
import { headlessLane } from '../lanes/headless/index.js';
import { vmLane } from '../lanes/vm/index.js';
import { probeEntitlements } from '../probe/index.js';
import type { EntitlementsProbeReport } from '../probe/index.js';
import { classify } from '../router/index.js';

export interface DoctorReport {
  lanes: Record<Lane, LaneAvailability>;
}

export interface RouteInput {
  cwd: string;
  command: string[];
}

export interface RunInput extends RouteInput {
  lane?: Lane;
  timeoutMs?: number;
}

export interface ProbeInput {
  path: string;
}

export interface OffstageCore {
  doctor(): Promise<DoctorReport>;
  route(input: RouteInput): Promise<RouteDecision>;
  run(input: RunInput): Promise<LaneResult>;
  probe(input: ProbeInput): Promise<EntitlementsProbeReport>;
}

const laneRunners: Record<Lane, LaneRunner> = {
  headless: headlessLane,
  container: containerLane,
  vm: vmLane,
};

export function createDefaultCore(): OffstageCore {
  return {
    async doctor(): Promise<DoctorReport> {
      const entries = await Promise.all(
        Object.entries(laneRunners).map(async ([lane, runner]) => [
          lane,
          await runner.isAvailable(),
        ] as const),
      );
      return { lanes: Object.fromEntries(entries) as Record<Lane, LaneAvailability> };
    },

    route(input: RouteInput): Promise<RouteDecision> {
      return classify(input);
    },

    async run(input: RunInput): Promise<LaneResult> {
      const lane = input.lane ?? (await classify(input)).lane;
      const runDir = await allocateRunDir({ cwd: input.cwd });
      const result = LaneResultSchema.parse(
        await laneRunners[lane].run({
          cwd: input.cwd,
          command: input.command,
          timeoutMs: input.timeoutMs,
          artifactsDir: runDir.artifactsDir,
        }),
      );
      await writeResult(result);
      return result;
    },

    probe(input: ProbeInput): Promise<EntitlementsProbeReport> {
      return probeEntitlements(input.path);
    },
  };
}
