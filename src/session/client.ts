/**
 * The typed client for `offstage-sessiond`.
 *
 * The daemon speaks JSON Lines over a unix socket, **one request per
 * connection**: the client writes one object and a newline, the daemon answers
 * with zero or more `event` lines, then exactly one *final* line carrying
 * `ok: true` or `ok: false`, then closes. See `docs/session-lane.md` for the
 * wire protocol itself.
 *
 * Three rules this module holds to:
 *
 * - **Every final line is zod-validated.** The daemon is a separate program,
 *   compiled separately, possibly older than this client. A response that does
 *   not match the schema is a protocol error with a readable message, never a
 *   silently-`undefined` field three call sites later.
 * - **Failures are typed, not stringly.** `ok:false` becomes
 *   {@link SessionRpcError} carrying the daemon's `code` and `fix`, so the lane
 *   can tell `spawn-failed` (say how to share the directory) from
 *   `tcc-screen-capture` (a diagnostic, not an error) without regexing prose.
 * - **"There is no daemon" is its own error.** ENOENT/ECONNREFUSED on the
 *   socket, or a connection that closes before a final line, is
 *   {@link SessionUnreachableError} — the one condition whose fix is
 *   `offstage session setup`.
 */

import net from 'node:net';

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** Codes the daemon may return on an `ok:false` final line. */
export const SESSION_ERROR_CODES = [
  'bad-request',
  'spawn-failed',
  'tcc-screen-capture',
  'tcc-accessibility',
  'not-found',
  'internal',
] as const;

export type SessionErrorCode = (typeof SESSION_ERROR_CODES)[number];

/**
 * The daemon answered, and the answer was "no".
 *
 * `code` is the daemon's kebab-code (see {@link SESSION_ERROR_CODES}), or
 * `bad-response` when the daemon said something this client cannot parse —
 * both are "the socket worked, the request did not", which is the distinction
 * callers actually branch on.
 */
export class SessionRpcError extends Error {
  readonly code: string;
  readonly fix: string | undefined;
  /** For `input`: how many actions ran before the failing one. */
  readonly performed: number | undefined;

  constructor(message: string, code: string, fix?: string, performed?: number) {
    super(message);
    this.name = 'SessionRpcError';
    this.code = code;
    this.fix = fix;
    this.performed = performed;
  }
}

/** The socket could not be reached, or died before answering. */
export class SessionUnreachableError extends Error {
  readonly socketPath: string;
  readonly code: string;

  constructor(message: string, socketPath: string, code = 'unreachable') {
    super(message);
    this.name = 'SessionUnreachableError';
    this.socketPath = socketPath;
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                           */
/* -------------------------------------------------------------------------- */

const FailureSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
  code: z.string(),
  fix: z.string().optional(),
  performed: z.number().int().nonnegative().optional(),
});

export const PermissionsSchema = z.object({
  screenCapture: z.boolean(),
  accessibility: z.boolean(),
});

export type SessionPermissions = z.infer<typeof PermissionsSchema>;

export const HelloSchema = z.object({
  ok: z.literal(true),
  daemon: z.object({
    version: z.string(),
    pid: z.number().int(),
    protocol: z.number().int(),
  }),
  user: z.object({
    uid: z.number().int(),
    name: z.string(),
    home: z.string(),
  }),
  session: z.object({
    onConsole: z.boolean(),
    managerName: z.string().nullable().optional(),
  }),
  display: z.object({
    width: z.number(),
    height: z.number(),
    scale: z.number(),
  }),
  permissions: PermissionsSchema,
});

export type SessionHello = z.infer<typeof HelloSchema>;

export const AccessSchema = z.object({
  ok: z.literal(true),
  exists: z.boolean(),
  readable: z.boolean(),
  writable: z.boolean(),
  directory: z.boolean(),
});

export type SessionAccess = z.infer<typeof AccessSchema>;

const RunFinalSchema = z.object({
  ok: z.literal(true),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable().optional(),
  timedOut: z.boolean(),
  durationMs: z.number().nonnegative(),
});

/** What `run` resolves to once the child has exited. */
export interface SessionRunResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Pid reported by the `started` event, when one arrived. */
  pid: number | null;
}

const ScreenshotSchema = z.object({
  ok: z.literal(true),
  png: z.string(),
  width: z.number(),
  height: z.number(),
  scale: z.number(),
});

/** What `screenshot` resolves to; `png` is decoded bytes, not base64. */
export interface SessionScreenshot {
  png: Buffer;
  width: number;
  height: number;
  scale: number;
}

const InputSchema = z.object({
  ok: z.literal(true),
  performed: z.number().int().nonnegative(),
});

/**
 * One running app. `name` and `bundleId` are nullable because
 * `NSRunningApplication` genuinely returns nil for both on occasion — a
 * just-launched process, or one that died between the listing and the read.
 */
export const AppSchema = z.object({
  pid: z.number().int(),
  name: z.string().nullable(),
  bundleId: z.string().nullable().optional(),
  active: z.boolean(),
  hidden: z.boolean(),
});

export type SessionApp = z.infer<typeof AppSchema>;

const AppsSchema = z.object({
  ok: z.literal(true),
  apps: z.array(AppSchema),
});

/**
 * `request-permissions` answers with the permission flags. The spec says "the
 * same shape as `hello.permissions`", which admits both a nested object and
 * the flags inline, so both are accepted rather than making the client brittle
 * about a detail neither side cares about.
 */
const RequestPermissionsSchema = z.union([
  z.object({ ok: z.literal(true), permissions: PermissionsSchema }),
  z.object({ ok: z.literal(true), screenCapture: z.boolean(), accessibility: z.boolean() }),
]);

const StartedEventSchema = z.object({
  event: z.literal('started'),
  pid: z.number().int(),
});

const OutputEventSchema = z.object({
  event: z.literal('output'),
  data: z.string(),
});

/* -------------------------------------------------------------------------- */
/* Input actions                                                              */
/* -------------------------------------------------------------------------- */

export const InputActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), x: z.number(), y: z.number() }),
  z.object({
    type: z.literal('click'),
    x: z.number(),
    y: z.number(),
    button: z.enum(['left', 'right', 'middle']).optional(),
    count: z.number().int().positive().optional(),
    modifiers: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal('drag'),
    fromX: z.number(),
    fromY: z.number(),
    toX: z.number(),
    toY: z.number(),
    button: z.enum(['left', 'right', 'middle']).optional(),
  }),
  z.object({
    type: z.literal('scroll'),
    x: z.number(),
    y: z.number(),
    dx: z.number(),
    dy: z.number(),
  }),
  z.object({ type: z.literal('type'), text: z.string() }),
  z.object({ type: z.literal('key'), key: z.string() }),
  z.object({ type: z.literal('wait'), ms: z.number().int().nonnegative().max(10_000) }),
]);

export type InputAction = z.infer<typeof InputActionSchema>;

/**
 * Validate a JSON value as an actions array — for the CLI and MCP surfaces,
 * which take one from the user and want the error before the socket opens.
 *
 * @throws {z.ZodError}
 */
export function parseInputActions(value: unknown): InputAction[] {
  return z.array(InputActionSchema).parse(value);
}

/* -------------------------------------------------------------------------- */
/* The transport                                                              */
/* -------------------------------------------------------------------------- */

/** Connection failures that mean "no daemon there", rather than "it broke". */
const UNREACHABLE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'ECONNRESET', 'EPIPE']);

interface RequestOptions<T> {
  socketPath: string;
  payload: Record<string, unknown>;
  schema: z.ZodType<T>;
  /** Called for every `event` line, before the final line arrives. */
  onEvent?: (event: Record<string, unknown>) => void;
  /** Wall-clock budget for the whole exchange. `undefined` means "no limit". */
  timeoutMs?: number;
  connectTimeoutMs: number;
}

/**
 * One request, one connection, one final line.
 *
 * Resolves with the validated final line, or rejects with
 * {@link SessionRpcError} / {@link SessionUnreachableError}. Nothing else can
 * escape: an unparseable line, a missing final line and a dead socket all map
 * onto those two.
 */
async function request<T>(options: RequestOptions<T>): Promise<T> {
  const { socketPath, payload, schema } = options;

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    let connectTimer: NodeJS.Timeout | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const socket = net.createConnection({ path: socketPath });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      socket.removeAllListeners();
      socket.destroy();
      fn();
    };

    const fail = (error: Error): void => {
      finish(() => {
        reject(error);
      });
    };

    connectTimer = setTimeout(() => {
      fail(
        new SessionUnreachableError(
          `The offstage session daemon did not accept a connection on ${socketPath} within ${options.connectTimeoutMs}ms.`,
          socketPath,
          'connect-timeout',
        ),
      );
    }, options.connectTimeoutMs);

    if (options.timeoutMs !== undefined) {
      deadlineTimer = setTimeout(() => {
        fail(
          new SessionUnreachableError(
            `The offstage session daemon did not answer "${String(payload['op'])}" within ${options.timeoutMs}ms.`,
            socketPath,
            'timeout',
          ),
        );
      }, options.timeoutMs);
    }

    socket.on('connect', () => {
      connected = true;
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      connectTimer = undefined;
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    socket.on('error', (error: NodeJS.ErrnoException) => {
      const code = error.code ?? 'unreachable';
      if (!connected || UNREACHABLE_CODES.has(code)) {
        fail(
          new SessionUnreachableError(
            `Could not talk to the offstage session daemon on ${socketPath}: ${error.message}`,
            socketPath,
            code,
          ),
        );
        return;
      }
      fail(
        new SessionUnreachableError(
          `The connection to the offstage session daemon failed mid-request: ${error.message}`,
          socketPath,
          code,
        ),
      );
    });

    const handleLine = (line: string): void => {
      if (line.trim() === '') return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(
          new SessionRpcError(
            `The offstage session daemon sent a line that is not JSON: ${truncate(line)}`,
            'bad-response',
          ),
        );
        return;
      }
      if (typeof parsed !== 'object' || parsed === null) {
        fail(
          new SessionRpcError(
            `The offstage session daemon sent ${truncate(line)}, which is not a JSON object.`,
            'bad-response',
          ),
        );
        return;
      }

      const record = parsed as Record<string, unknown>;
      if (typeof record['event'] === 'string') {
        options.onEvent?.(record);
        return;
      }

      if (record['ok'] === false) {
        const failure = FailureSchema.safeParse(record);
        if (!failure.success) {
          fail(
            new SessionRpcError(
              `The offstage session daemon reported a failure this client cannot read: ${truncate(line)}`,
              'bad-response',
            ),
          );
          return;
        }
        fail(
          new SessionRpcError(
            failure.data.error,
            failure.data.code,
            failure.data.fix,
            failure.data.performed,
          ),
        );
        return;
      }

      const validated = schema.safeParse(record);
      if (!validated.success) {
        fail(
          new SessionRpcError(
            `The offstage session daemon's answer to "${String(payload['op'])}" does not match the protocol: ${validated.error.issues
              .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
              .join('; ')}`,
            'bad-response',
          ),
        );
        return;
      }

      const value = validated.data;
      finish(() => {
        resolve(value);
      });
    };

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index !== -1 && !settled) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
        index = buffer.indexOf('\n');
      }
    });

    socket.on('close', () => {
      /* A trailing line with no newline is still an answer worth reading. */
      if (!settled && buffer.trim() !== '') {
        const rest = buffer;
        buffer = '';
        handleLine(rest);
      }
      if (!settled) {
        fail(
          new SessionUnreachableError(
            `The offstage session daemon closed the connection on ${socketPath} without answering "${String(
              payload['op'],
            )}".`,
            socketPath,
            'closed',
          ),
        );
      }
    });
  });
}

function truncate(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/* -------------------------------------------------------------------------- */
/* The client                                                                 */
/* -------------------------------------------------------------------------- */

export interface SessionRunRequest {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Called with each chunk of merged stdout/stderr, as it arrives. */
  onOutput?: (chunk: Buffer) => void;
  /** Called once with the child's pid. */
  onStarted?: (pid: number) => void;
}

export interface SessionClientOptions {
  socketPath: string;
  /** How long to wait for the socket to accept a connection. Default 5000ms. */
  connectTimeoutMs?: number;
  /** Budget for a short op (everything but `run`). Default 30000ms. */
  requestTimeoutMs?: number;
  /**
   * Extra time `run` is allowed on top of its own `timeoutMs` before the
   * client gives up on the daemon. Only applies when the request sets one —
   * an unbounded run stays unbounded here too. Default 30000ms.
   */
  runGraceMs?: number;
}

/** The daemon, as a set of methods. Every call opens its own connection. */
export interface SessionClient {
  readonly socketPath: string;
  hello(): Promise<SessionHello>;
  access(targetPath: string): Promise<SessionAccess>;
  run(request: SessionRunRequest): Promise<SessionRunResult>;
  screenshot(options?: { maxDimension?: number }): Promise<SessionScreenshot>;
  input(actions: InputAction[]): Promise<{ performed: number }>;
  apps(): Promise<SessionApp[]>;
  requestPermissions(): Promise<SessionPermissions>;
}

/**
 * Build a client for the daemon listening at `socketPath`.
 *
 * The returned object holds no connection and no state: it is safe to keep,
 * safe to share, and connects afresh on every call, exactly as the protocol's
 * one-request-per-connection rule requires.
 */
export function createSessionClient(options: SessionClientOptions): SessionClient {
  const socketPath = options.socketPath;
  const connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const runGraceMs = options.runGraceMs ?? 30_000;

  const short = <T>(
    payload: Record<string, unknown>,
    schema: z.ZodType<T>,
    timeoutMs = requestTimeoutMs,
  ): Promise<T> => request({ socketPath, payload, schema, connectTimeoutMs, timeoutMs });

  return {
    socketPath,

    async hello() {
      return await short({ op: 'hello' }, HelloSchema);
    },

    async access(targetPath) {
      return await short({ op: 'access', path: targetPath }, AccessSchema);
    },

    async run(runRequest) {
      let pid: number | null = null;
      const payload: Record<string, unknown> = {
        op: 'run',
        argv: runRequest.argv,
        cwd: runRequest.cwd,
      };
      if (runRequest.env !== undefined) payload['env'] = runRequest.env;
      if (runRequest.timeoutMs !== undefined) payload['timeoutMs'] = runRequest.timeoutMs;

      const final = await request({
        socketPath,
        payload,
        schema: RunFinalSchema,
        connectTimeoutMs,
        ...(runRequest.timeoutMs === undefined
          ? {}
          : { timeoutMs: runRequest.timeoutMs + runGraceMs }),
        onEvent: (event) => {
          const started = StartedEventSchema.safeParse(event);
          if (started.success) {
            pid = started.data.pid;
            runRequest.onStarted?.(started.data.pid);
            return;
          }
          const output = OutputEventSchema.safeParse(event);
          if (output.success && runRequest.onOutput !== undefined) {
            runRequest.onOutput(Buffer.from(output.data.data, 'base64'));
          }
        },
      });

      return {
        exitCode: final.exitCode,
        signal: final.signal ?? null,
        timedOut: final.timedOut,
        durationMs: final.durationMs,
        pid,
      };
    },

    async screenshot(screenshotOptions = {}) {
      const payload: Record<string, unknown> = { op: 'screenshot' };
      if (screenshotOptions.maxDimension !== undefined) {
        payload['maxDimension'] = screenshotOptions.maxDimension;
      }
      const final = await short(payload, ScreenshotSchema, Math.max(requestTimeoutMs, 60_000));
      return {
        png: Buffer.from(final.png, 'base64'),
        width: final.width,
        height: final.height,
        scale: final.scale,
      };
    },

    async input(actions) {
      const final = await short({ op: 'input', actions }, InputSchema);
      return { performed: final.performed };
    },

    async apps() {
      const final = await short({ op: 'apps' }, AppsSchema);
      return final.apps;
    },

    async requestPermissions() {
      const final = await short({ op: 'request-permissions' }, RequestPermissionsSchema);
      if ('permissions' in final) return final.permissions;
      return { screenCapture: final.screenCapture, accessibility: final.accessibility };
    },
  };
}

/** Factory shape the lane takes as an injection point. */
export type SessionClientFactory = (options: SessionClientOptions) => SessionClient;
