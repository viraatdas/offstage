/**
 * Session client tests, against a fake daemon.
 *
 * No `offstage-sessiond` is installed on the machine these were written on, and
 * none is needed: this file stands up a `net.createServer` on a socket in a
 * temp directory that speaks the daemon's protocol — one
 * request per connection, zero or more `event` lines, then exactly one final
 * line, then close. That exercises the real client over a real unix socket,
 * which is the half of the protocol offstage owns.
 *
 * The daemon-side behaviours worth pinning are the ugly ones: a failure final
 * line, a line that is not JSON, a response that does not match the schema, a
 * socket that closes without answering, and a socket that is not there at all.
 */

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SessionClient } from '../src/session/index.js';
import {
  SessionRpcError,
  SessionUnreachableError,
  createSessionClient,
  parseInputActions,
} from '../src/session/index.js';

/* -------------------------------------------------------------------------- */
/* The fake daemon                                                            */
/* -------------------------------------------------------------------------- */

/** Whatever a test wants the daemon to do with one request. */
type Handler = (request: Record<string, unknown>, socket: net.Socket) => void | Promise<void>;

interface FakeDaemon {
  socketPath: string;
  /** Every request line the daemon received, in order. */
  requests: Array<Record<string, unknown>>;
  /** How many connections were opened — the protocol says one per request. */
  connections: number;
  setHandler(handler: Handler): void;
  close(): Promise<void>;
}

async function startFakeDaemon(): Promise<FakeDaemon> {
  /* /tmp rather than os.tmpdir(): a unix socket path has ~104 bytes to live in,
     and macOS's per-user temp directory spends most of them on its own. */
  const dir = await fs.mkdtemp('/tmp/offstage-session-test-');
  const socketPath = path.join(dir, 'daemon.sock');

  const daemon: FakeDaemon = {
    socketPath,
    requests: [],
    connections: 0,
    setHandler(handler) {
      current = handler;
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await fs.rm(dir, { recursive: true, force: true });
    },
  };

  let current: Handler = (_request, socket) => {
    socket.end(`${JSON.stringify({ ok: true })}\n`);
  };

  const server = net.createServer((socket) => {
    daemon.connections += 1;
    let buffer = '';
    let handled = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const index = buffer.indexOf('\n');
      if (index === -1 || handled) return;
      handled = true;
      const line = buffer.slice(0, index);
      const request = JSON.parse(line) as Record<string, unknown>;
      daemon.requests.push(request);
      void Promise.resolve(current(request, socket)).catch(() => {
        socket.destroy();
      });
    });
    socket.on('error', () => {
      /* A client that hangs up early is cancellation, not a crash. */
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return daemon;
}

/** Write the given lines (already objects) and close, as the daemon does. */
function answer(socket: net.Socket, ...lines: Array<Record<string, unknown>>): void {
  socket.end(lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

const HELLO = {
  ok: true,
  op: 'hello',
  daemon: { version: '1', pid: 4242, protocol: 1 },
  user: { uid: 502, name: 'computeruse', home: '/Users/computeruse' },
  session: { onConsole: false, managerName: 'Aqua' },
  display: { width: 1728, height: 1117, scale: 2 },
  permissions: { screenCapture: true, accessibility: false },
};

/* -------------------------------------------------------------------------- */
/* Tests                                                                      */
/* -------------------------------------------------------------------------- */

describe('createSessionClient', () => {
  let daemon: FakeDaemon;
  let client: SessionClient;

  beforeEach(async () => {
    daemon = await startFakeDaemon();
    client = createSessionClient({ socketPath: daemon.socketPath, connectTimeoutMs: 2_000 });
  });

  afterEach(async () => {
    await daemon.close();
  });

  it('round-trips hello and validates the answer', async () => {
    daemon.setHandler((_request, socket) => {
      answer(socket, HELLO);
    });

    const hello = await client.hello();
    expect(hello.user.name).toBe('computeruse');
    expect(hello.session.onConsole).toBe(false);
    expect(hello.display).toEqual({ width: 1728, height: 1117, scale: 2 });
    expect(hello.permissions).toEqual({ screenCapture: true, accessibility: false });
    expect(daemon.requests).toEqual([{ op: 'hello' }]);
  });

  it('opens one connection per call, as the protocol requires', async () => {
    daemon.setHandler((_request, socket) => {
      answer(socket, HELLO);
    });
    await client.hello();
    await client.hello();
    expect(daemon.connections).toBe(2);
  });

  it('asks access about one path and reports every flag', async () => {
    daemon.setHandler((request, socket) => {
      answer(socket, {
        ok: true,
        exists: true,
        readable: request['path'] === '/Users/viraat/code/app',
        writable: false,
        directory: true,
      });
    });

    expect(await client.access('/Users/viraat/code/app')).toEqual({
      ok: true,
      exists: true,
      readable: true,
      writable: false,
      directory: true,
    });
    expect(daemon.requests[0]).toEqual({ op: 'access', path: '/Users/viraat/code/app' });
  });

  it('streams run output through onOutput as base64 events arrive', async () => {
    daemon.setHandler((_request, socket) => {
      socket.write(`${JSON.stringify({ event: 'started', pid: 5120 })}\n`);
      socket.write(
        `${JSON.stringify({ event: 'output', data: Buffer.from('hello ').toString('base64') })}\n`,
      );
      socket.write(
        `${JSON.stringify({ event: 'output', data: Buffer.from('world\n').toString('base64') })}\n`,
      );
      answer(socket, { ok: true, exitCode: 1, signal: null, timedOut: false, durationMs: 8421 });
    });

    const chunks: string[] = [];
    let startedPid: number | null = null;
    const result = await client.run({
      argv: ['npx', 'playwright', 'test'],
      cwd: '/Users/viraat/code/app',
      env: { CI: '1' },
      timeoutMs: 600_000,
      onOutput: (chunk) => chunks.push(chunk.toString('utf8')),
      onStarted: (pid) => {
        startedPid = pid;
      },
    });

    expect(chunks.join('')).toBe('hello world\n');
    expect(startedPid).toBe(5120);
    expect(result).toEqual({
      exitCode: 1,
      signal: null,
      timedOut: false,
      durationMs: 8421,
      pid: 5120,
    });
    expect(daemon.requests[0]).toEqual({
      op: 'run',
      argv: ['npx', 'playwright', 'test'],
      cwd: '/Users/viraat/code/app',
      env: { CI: '1' },
      timeoutMs: 600_000,
    });
  });

  it('reports a timeout as data, not as an exception', async () => {
    daemon.setHandler((_request, socket) => {
      answer(socket, {
        ok: true,
        exitCode: null,
        signal: 'SIGKILL',
        timedOut: true,
        durationMs: 5_000,
      });
    });

    const result = await client.run({ argv: ['sleep', '99'], cwd: '/tmp' });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  });

  it('turns an ok:false final line into a typed SessionRpcError', async () => {
    daemon.setHandler((_request, socket) => {
      answer(socket, {
        ok: false,
        error: 'chdir /Users/viraat/code/app: Permission denied',
        code: 'spawn-failed',
        fix: 'offstage session share /Users/viraat/code/app',
      });
    });

    const error = await client
      .run({ argv: ['ls'], cwd: '/Users/viraat/code/app' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SessionRpcError);
    const rpc = error as SessionRpcError;
    expect(rpc.code).toBe('spawn-failed');
    expect(rpc.fix).toBe('offstage session share /Users/viraat/code/app');
    expect(rpc.message).toContain('Permission denied');
  });

  it('carries `performed` back from a failed input batch', async () => {
    daemon.setHandler((_request, socket) => {
      answer(socket, {
        ok: false,
        error: "action 3: unknown key 'foo'",
        code: 'bad-request',
        performed: 3,
      });
    });

    const error = (await client
      .input([{ type: 'key', key: 'foo' }])
      .catch((caught: unknown) => caught)) as SessionRpcError;
    expect(error).toBeInstanceOf(SessionRpcError);
    expect(error.performed).toBe(3);
  });

  it('decodes a screenshot into bytes', async () => {
    const png = Buffer.from('\x89PNG\r\n\x1a\nfake', 'binary');
    daemon.setHandler((_request, socket) => {
      answer(socket, {
        ok: true,
        png: png.toString('base64'),
        width: 1280,
        height: 827,
        scale: 2,
      });
    });

    const shot = await client.screenshot({ maxDimension: 1280 });
    expect(shot.png.equals(png)).toBe(true);
    expect(shot.width).toBe(1280);
    expect(daemon.requests[0]).toEqual({ op: 'screenshot', maxDimension: 1280 });
  });

  it('counts performed input actions and sends them verbatim', async () => {
    daemon.setHandler((_request, socket) => {
      answer(socket, { ok: true, performed: 2 });
    });

    const actions = parseInputActions([
      { type: 'move', x: 640, y: 400 },
      { type: 'click', x: 640, y: 400, button: 'left', count: 2, modifiers: ['cmd'] },
    ]);
    expect(await client.input(actions)).toEqual({ performed: 2 });
    expect(daemon.requests[0]).toEqual({ op: 'input', actions });
  });

  it('lists apps and request-permissions in either accepted shape', async () => {
    daemon.setHandler((request, socket) => {
      if (request['op'] === 'apps') {
        answer(socket, {
          ok: true,
          apps: [
            { pid: 5120, name: 'Safari', bundleId: 'com.apple.Safari', active: true, hidden: false },
          ],
        });
        return;
      }
      answer(socket, { ok: true, screenCapture: true, accessibility: true });
    });

    expect(await client.apps()).toEqual([
      { pid: 5120, name: 'Safari', bundleId: 'com.apple.Safari', active: true, hidden: false },
    ]);
    expect(await client.requestPermissions()).toEqual({
      screenCapture: true,
      accessibility: true,
    });

    daemon.setHandler((_request, socket) => {
      answer(socket, { ok: true, permissions: { screenCapture: false, accessibility: true } });
    });
    expect(await client.requestPermissions()).toEqual({
      screenCapture: false,
      accessibility: true,
    });
  });

  it('rejects a response that does not match the protocol', async () => {
    daemon.setHandler((_request, socket) => {
      answer(socket, { ok: true, daemon: { version: '1' } });
    });

    const error = (await client.hello().catch((caught: unknown) => caught)) as SessionRpcError;
    expect(error).toBeInstanceOf(SessionRpcError);
    expect(error.code).toBe('bad-response');
    expect(error.message).toContain('does not match the protocol');
  });

  it('rejects a line that is not JSON at all', async () => {
    daemon.setHandler((_request, socket) => {
      socket.end('not json\n');
    });

    const error = (await client.hello().catch((caught: unknown) => caught)) as SessionRpcError;
    expect(error).toBeInstanceOf(SessionRpcError);
    expect(error.code).toBe('bad-response');
  });

  it('treats a connection closed without a final line as unreachable', async () => {
    daemon.setHandler((_request, socket) => {
      socket.write(`${JSON.stringify({ event: 'started', pid: 1 })}\n`);
      socket.destroy();
    });

    const error = (await client
      .run({ argv: ['ls'], cwd: '/tmp' })
      .catch((caught: unknown) => caught)) as SessionUnreachableError;
    expect(error).toBeInstanceOf(SessionUnreachableError);
    expect(error.socketPath).toBe(daemon.socketPath);
  });

  it('reads a final line that arrives without its trailing newline', async () => {
    daemon.setHandler((_request, socket) => {
      socket.end(JSON.stringify(HELLO));
    });
    expect((await client.hello()).daemon.pid).toBe(4242);
  });

  it('reports a socket that is not there as unreachable, with the path', async () => {
    const missing = createSessionClient({
      socketPath: '/tmp/offstage-session-test-does-not-exist/daemon.sock',
      connectTimeoutMs: 1_000,
    });
    const error = (await missing.hello().catch((caught: unknown) => caught)) as SessionUnreachableError;
    expect(error).toBeInstanceOf(SessionUnreachableError);
    expect(error.code).toBe('ENOENT');
    expect(error.message).toContain('/tmp/offstage-session-test-does-not-exist/daemon.sock');
  });

  it('gives up on a daemon that accepts the connection and never answers', async () => {
    daemon.setHandler(() => {
      /* Accept, read the request, say nothing. */
    });
    const impatient = createSessionClient({
      socketPath: daemon.socketPath,
      connectTimeoutMs: 1_000,
      requestTimeoutMs: 150,
    });
    const error = (await impatient.hello().catch((caught: unknown) => caught)) as SessionUnreachableError;
    expect(error).toBeInstanceOf(SessionUnreachableError);
    expect(error.code).toBe('timeout');
  });
});

describe('parseInputActions', () => {
  it('accepts every action in the protocol', () => {
    const actions = parseInputActions([
      { type: 'move', x: 640, y: 400 },
      { type: 'click', x: 640, y: 400, button: 'left', count: 1, modifiers: ['cmd'] },
      { type: 'drag', fromX: 100, fromY: 100, toX: 300, toY: 300 },
      { type: 'scroll', x: 640, y: 400, dx: 0, dy: -5 },
      { type: 'type', text: 'hello world' },
      { type: 'key', key: 'cmd+shift+t' },
      { type: 'wait', ms: 250 },
    ]);
    expect(actions).toHaveLength(7);
  });

  it('rejects an unknown action and an over-long wait', () => {
    expect(() => parseInputActions([{ type: 'teleport', x: 1, y: 1 }])).toThrow();
    expect(() => parseInputActions([{ type: 'wait', ms: 10_001 }])).toThrow();
  });
});
