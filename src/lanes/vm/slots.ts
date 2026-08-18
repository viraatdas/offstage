/**
 * The two-VM ceiling.
 *
 * Apple's Virtualization.framework refuses to start a third concurrent macOS
 * guest on a host. Not "it gets slow" — the third `VZVirtualMachine` start
 * fails. `tart-runner` happily runs in parallel (each run gets its own clone,
 * and its lock covers only the brief clone step), so nothing below offstage
 * stops a fleet of agents from asking for five VMs at once and getting three
 * hard failures that look like flaky tests.
 *
 * So offstage queues. This is a counting semaphore built out of lockfiles:
 * `<dir>/vm-slots/slot-0.lock` and `slot-1.lock`. Creating a slot file with
 * `wx` (exclusive create) is atomic on every filesystem that matters, which
 * makes "who got the slot" a decision the kernel makes rather than one we race
 * over. A slot whose owning process is gone is reclaimed, so a `kill -9` mid-run
 * costs one stale-check rather than a permanently wedged lane.
 *
 * ## Scope caveat
 *
 * The ceiling is a property of the *host*, but these lockfiles live under the
 * repository's `.offstage/` directory. Two different checkouts therefore get two
 * independent pairs of slots and can, between them, ask for four VMs. Set
 * {@link SLOT_DIR_ENV_VAR} to one absolute path across every checkout to make
 * the ceiling genuinely host-wide.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Concurrent macOS guests Virtualization.framework will host. Not a tuning knob. */
export const MAX_CONCURRENT_VMS = 2;

/** Slot files live here, under the offstage state directory. */
export const SLOT_DIR_NAME = 'vm-slots';

/** Points the semaphore at a shared directory, making the ceiling host-wide. */
export const SLOT_DIR_ENV_VAR = 'OFFSTAGE_VM_SLOT_DIR';

/** A slot held by a process that stopped this long ago is presumed abandoned. */
const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000; // 6h — above the runner's 2h watchdog.

/** How long to wait for a slot before giving up. */
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30 * 60 * 1000;

/** How often to re-check for a free slot while queued. */
const DEFAULT_POLL_INTERVAL_MS = 500;

/** What gets written into a slot file, so a holder can be identified. */
interface SlotRecord {
  pid: number;
  hostname: string;
  acquiredAt: string;
  /** Random token proving ownership, so we never release someone else's slot. */
  token: string;
  /** Free-form label, e.g. the offstage run id. Purely for humans. */
  label?: string;
}

/** A held slot. Call {@link VmSlot.release} exactly once, from a `finally`. */
export interface VmSlot {
  /** Which slot index was taken, `0` or `1`. */
  index: number;
  /** Absolute path to the lockfile. */
  path: string;
  /** How long the caller waited before the slot was granted. */
  waitedMs: number;
  /** Idempotent, and never throws: releasing must not fail a run. */
  release(): Promise<void>;
}

export interface AcquireOptions {
  /** Repository root; slots go under `<cwd>/.offstage/vm-slots`. */
  cwd?: string;
  /** Environment to read {@link SLOT_DIR_ENV_VAR} from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Absolute slot directory, overriding both `cwd` and the env var. */
  slotDir?: string;
  /** How many slots exist. Defaults to {@link MAX_CONCURRENT_VMS}. */
  limit?: number;
  /** Give up after this long. Defaults to 30 minutes. */
  timeoutMs?: number;
  /** Poll interval while queued. */
  pollIntervalMs?: number;
  /** Age past which a slot with a dead owner is reclaimed. */
  staleAfterMs?: number;
  /** Human-readable label recorded in the lockfile. */
  label?: string;
  /** Clock injection point for tests. */
  now?: () => number;
}

/** Thrown by {@link acquireVmSlot} when the queue never drained in time. */
export class VmSlotTimeoutError extends Error {
  readonly waitedMs: number;
  readonly limit: number;

  constructor(waitedMs: number, limit: number) {
    super(
      `Timed out after ${Math.round(waitedMs / 1000)}s waiting for one of ${limit} VM slots. ` +
        `macOS hosts at most ${MAX_CONCURRENT_VMS} concurrent guests, so offstage queues rather ` +
        'than letting Virtualization.framework fail the third boot.',
    );
    this.name = 'VmSlotTimeoutError';
    this.waitedMs = waitedMs;
    this.limit = limit;
  }
}

/** Resolve the slot directory from the explicit path, the env var, or `cwd`. */
export function slotDirFor(options: AcquireOptions = {}): string {
  if (options.slotDir) return path.resolve(options.slotDir);
  const fromEnv = (options.env ?? process.env)[SLOT_DIR_ENV_VAR]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(path.resolve(options.cwd ?? process.cwd()), '.offstage', SLOT_DIR_NAME);
}

/**
 * Is this pid still running?
 *
 * `kill(pid, 0)` sends no signal; it only asks the kernel whether it could.
 * `EPERM` means the process exists but belongs to another user — alive. Any
 * other error (`ESRCH`) means it is gone.
 */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function readSlot(file: string): Promise<SlotRecord | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as SlotRecord;
  } catch {
    // Missing, half-written, or corrupt. Callers treat all three the same:
    // there is no trustworthy owner recorded here.
    return null;
  }
}

/**
 * Delete a slot file whose owner is provably gone.
 *
 * Conservative on purpose. A slot is only reclaimed when the recorded process
 * is dead *on this host*, or when the record is unreadable/ancient. A live
 * holder on another machine (a shared slot directory over NFS) is left alone
 * until it ages out, because stealing a slot from a running VM is worse than
 * queueing behind a ghost.
 */
async function reclaimIfStale(file: string, staleAfterMs: number, nowMs: number): Promise<boolean> {
  const record = await readSlot(file);

  if (record === null) {
    // Unreadable. If it is also old, it is debris from a crash mid-write.
    try {
      const stats = await fs.stat(file);
      if (nowMs - stats.mtimeMs < staleAfterMs) return false;
    } catch {
      return true; // Already gone — the slot is free.
    }
    await fs.rm(file, { force: true });
    return true;
  }

  const ageMs = nowMs - Date.parse(record.acquiredAt);
  const sameHost = record.hostname === os.hostname();

  if (sameHost && !processIsAlive(record.pid)) {
    await fs.rm(file, { force: true });
    return true;
  }
  if (Number.isFinite(ageMs) && ageMs > staleAfterMs) {
    await fs.rm(file, { force: true });
    return true;
  }
  return false;
}

/** Try once to take any free slot. Returns `null` when all are held. */
async function tryAcquire(
  dir: string,
  limit: number,
  staleAfterMs: number,
  nowMs: number,
  label: string | undefined,
): Promise<{ index: number; file: string; token: string } | null> {
  for (let index = 0; index < limit; index += 1) {
    const file = path.join(dir, `slot-${index}.lock`);
    const token = randomToken();
    const record: SlotRecord = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date(nowMs).toISOString(),
      token,
      ...(label === undefined ? {} : { label }),
    };

    try {
      // `wx` fails with EEXIST if the file is already there. That atomicity is
      // the entire mutual-exclusion mechanism.
      await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
      return { index, file, token };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await reclaimIfStale(file, staleAfterMs, nowMs)) {
        try {
          await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
          return { index, file, token };
        } catch (retryError) {
          // Someone else won the reclaimed slot between our rm and our write.
          if ((retryError as NodeJS.ErrnoException).code !== 'EEXIST') throw retryError;
        }
      }
    }
  }
  return null;
}

/**
 * Take one of the {@link MAX_CONCURRENT_VMS} slots, waiting if both are busy.
 *
 * @throws {VmSlotTimeoutError} when `timeoutMs` elapses with no slot free. The
 * lane turns this into an `errored` result rather than propagating it.
 */
export async function acquireVmSlot(options: AcquireOptions = {}): Promise<VmSlot> {
  const dir = slotDirFor(options);
  const limit = options.limit ?? MAX_CONCURRENT_VMS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = options.now ?? Date.now;

  await fs.mkdir(dir, { recursive: true });
  const startedAt = now();

  for (;;) {
    const taken = await tryAcquire(dir, limit, staleAfterMs, now(), options.label);
    if (taken) {
      let released = false;
      return {
        index: taken.index,
        path: taken.file,
        waitedMs: now() - startedAt,
        async release() {
          // Idempotent and non-throwing: release runs on every error path, and
          // a failure to clean up must never mask the real failure.
          if (released) return;
          released = true;
          try {
            const current = await readSlot(taken.file);
            // Only delete a slot we still own. If it was reclaimed as stale and
            // handed to someone else, removing it would over-subscribe the host.
            if (current === null || current.token === taken.token) {
              await fs.rm(taken.file, { force: true });
            }
          } catch {
            /* ignore */
          }
        },
      };
    }

    const waitedMs = now() - startedAt;
    if (waitedMs >= timeoutMs) throw new VmSlotTimeoutError(waitedMs, limit);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/** How many slots are currently held. Read-only; used by `offstage doctor`. */
export async function countHeldSlots(options: AcquireOptions = {}): Promise<number> {
  const dir = slotDirFor(options);
  const limit = options.limit ?? MAX_CONCURRENT_VMS;
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const nowMs = (options.now ?? Date.now)();

  let held = 0;
  for (let index = 0; index < limit; index += 1) {
    const file = path.join(dir, `slot-${index}.lock`);
    try {
      await fs.stat(file);
    } catch {
      continue;
    }
    const record = await readSlot(file);
    if (record === null) continue;
    const stale =
      (record.hostname === os.hostname() && !processIsAlive(record.pid)) ||
      nowMs - Date.parse(record.acquiredAt) > staleAfterMs;
    if (!stale) held += 1;
  }
  return held;
}
