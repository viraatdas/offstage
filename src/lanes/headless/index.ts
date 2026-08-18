/**
 * The headless lane — no isolation, because none is needed.
 *
 * ```ts
 * import { headlessLane } from '../lanes/headless/index.js';
 * import { allocateRunDir } from '../contract/artifacts.js';
 *
 * const run = await allocateRunDir({ cwd: repoRoot });
 * const result = await headlessLane.run({
 *   cwd: repoRoot,
 *   command: ['npx', 'playwright', 'test'],
 *   artifactsDir: run.artifactsDir,
 *   timeoutMs: 10 * 60_000,
 * });
 * ```
 *
 * See `./runner.ts` for what the lane guarantees and `./parse.ts` for the
 * reporter formats whose failures it can extract.
 */

export {
  COMMAND_LOG_FILENAME,
  HeadlessLane,
  LOG_FLUSH_GRACE_MS,
  LOG_FLUSH_STALL_MS,
  LogSink,
  MAX_BUFFERED_LOG_BYTES,
  MAX_CAPTURED_CHARS,
  detectHeadedRequest,
  headlessLane,
} from './runner.js';

export type { ParseFailuresOptions } from './parse.js';
export { parseFailures, stripAnsi, tailOf, toLines } from './parse.js';
