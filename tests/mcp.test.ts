import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { LaneResult, RouteDecision } from '../src/contract/index.js';
import { createLaneResult } from '../src/contract/index.js';
import type {
  DoctorReport,
  OffstageCore,
  ProbeInput,
  RouteInput,
  RunInput,
  RunOutcome,
  SessionInputResult,
  SessionScreenshotInput,
  SessionScreenshotResult,
  SessionStatus,
} from '../src/mcp/core.js';
import { createDefaultCore } from '../src/mcp/core.js';
import { createOffstageMcpServer } from '../src/mcp/server.js';
import type { EntitlementsProbeReport } from '../src/probe/index.js';
import type { SessionLaunchResult } from '../src/cli/session-control.js';
import type { InputAction, SessionApp } from '../src/session/index.js';

const routeDecision: RouteDecision = {
  lane: 'headless',
  confidence: 'high',
  reason: 'Playwright defaults to headless, so offstage can run this in place without opening a window.',
  signals: ['argv: playwright test defaults to headless'],
};

/** A 4-byte PNG stand-in; the server must not care what the bytes are. */
const FAKE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

class FakeCore implements OffstageCore {
  screenshotPath: string | null = null;
  /** Every session tool call, so a test can assert what reached the seam. */
  readonly sessionCalls: Array<{ tool: string; input: unknown }> = [];

  async doctor(): Promise<DoctorReport> {
    return {
      offstageVersion: '0.1.0',
      install: { version: '0.1.0', root: '/fake/offstage', fromSource: false },
      warnings: [],
      node: 'v20.0.0',
      platform: 'darwin',
      arch: 'arm64',
      ready: ['headless'],
      lanes: [
        { lane: 'headless', availability: { available: true }, detail: [] },
        {
          lane: 'session',
          availability: {
            available: false,
            reason: 'the offstage session daemon is not listening',
            fix: 'offstage session setup',
          },
          detail: [],
        },
        {
          lane: 'container',
          availability: { available: false, reason: 'no container runtime', fix: 'install Docker or start Colima' },
          detail: [],
        },
      ],
    };
  }

  async route(input: RouteInput): Promise<RouteDecision> {
    expect(input.command.length).toBeGreaterThan(0);
    return routeDecision;
  }

  async run(input: RunInput): Promise<RunOutcome> {
    const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-mcp-artifacts-'));
    const result: LaneResult = createLaneResult({
      lane: input.lane ?? 'container',
      status: 'passed',
      exitCode: 0,
      artifactsDir,
      diagnostics: ['fake run completed off-screen'],
    });
    if (this.screenshotPath !== null) {
      result.artifacts.push({ kind: 'screenshot', path: this.screenshotPath });
    }
    return {
      runId: 'fake-run',
      artifactsDir,
      relativeDir: '.offstage/runs/fake-run',
      resultPath: path.join(artifactsDir, 'result.json'),
      decision: routeDecision,
      lane: result.lane,
      laneSource: input.lane === undefined ? 'router' : 'explicit',
      result,
      exitCode: 0,
    };
  }

  async sessionStatus(input: { user?: string }): Promise<SessionStatus> {
    this.sessionCalls.push({ tool: 'status', input });
    return {
      available: true,
      reason: null,
      fix: null,
      user: input.user ?? 'computeruse',
      fullName: 'Computer Use',
      uid: 502,
      home: '/Users/computeruse',
      accountExists: true,
      guiSession: { exists: true, loginDone: true, onConsole: false, sessionId: 258 },
      socketPath: '/tmp/offstage-session/502.sock',
      socketPresent: true,
      daemon: { version: '1', pid: 4242, protocol: 1 },
      display: { width: 1728, height: 1117, scale: 2 },
      permissions: { screenCapture: true, accessibility: true },
      notes: [],
      detail: ['session account: computeruse (uid 502)', '  - account: exists'],
    };
  }

  async sessionScreenshot(input: SessionScreenshotInput): Promise<SessionScreenshotResult> {
    this.sessionCalls.push({ tool: 'screenshot', input });
    return { path: null, width: 1728, height: 1117, scale: 2, png: FAKE_PNG };
  }

  async sessionInput(input: { actions: unknown; user?: string }): Promise<SessionInputResult> {
    this.sessionCalls.push({ tool: 'input', input });
    const actions = input.actions as InputAction[];
    return { performed: actions.length, actions };
  }

  async sessionApps(input: { user?: string }): Promise<SessionApp[]> {
    this.sessionCalls.push({ tool: 'apps', input });
    return [{ pid: 5120, name: 'Safari', bundleId: 'com.apple.Safari', active: true, hidden: false }];
  }

  async sessionLaunch(input: {
    target: string;
    args?: string[];
    cwd?: string;
    fresh?: boolean;
    waitMs?: number;
    user?: string;
  }): Promise<SessionLaunchResult> {
    this.sessionCalls.push({ tool: 'launch', input });
    return {
      ok: true,
      target: input.target,
      app: { pid: 45272, name: 'GestureEngine', bundleId: 'dev.viraat.GestureEngine', active: true, hidden: false },
      waitedMs: 1200,
      diagnostics: [],
    };
  }

  async probe(input: ProbeInput): Promise<EntitlementsProbeReport> {
    return {
      target: input.path,
      targetKind: 'entitlements',
      verdict: 'adhoc-ok',
      confidence: 'high',
      triggers: [],
      adhocSatisfied: [],
      teamScoped: [],
      inert: [],
      unclassified: [],
      entitlements: {},
      sources: [],
      notes: [],
      summary: 'No signing-lane-only entitlements were found.',
    };
  }
}

async function connect(core = new FakeCore()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createOffstageMcpServer(core);
  const client = new Client({ name: 'offstage-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server, core };
}

describe('offstage MCP server', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.();
    }
  });

  it('lists the nine offstage tools with useful descriptions', async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'offstage_doctor',
      'offstage_probe',
      'offstage_route',
      'offstage_run',
      'offstage_session_apps',
      'offstage_session_input',
      'offstage_session_launch',
      'offstage_session_screenshot',
      'offstage_session_status',
    ]);
    expect(tools.tools.find((tool) => tool.name === 'offstage_session_launch')?.description).toContain(
      'NEVER launch apps outside offstage',
    );
    expect(tools.tools.find((tool) => tool.name === 'offstage_route')?.description).toContain('Call this first');
    expect(tools.tools.find((tool) => tool.name === 'offstage_run')?.description).toContain(
      'never falls back to the user real display',
    );
  });

  it('does not expose setup as a tool, because sudo has no terminal to prompt on', async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).not.toContain('offstage_session_setup');
    expect(names.find((name) => name.includes('setup'))).toBeUndefined();
  });

  it('tells the agent the three things that make session input safe to use', async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());
    const tools = (await client.listTools()).tools;
    const describe = (name: string): string =>
      tools.find((tool) => tool.name === name)?.description ?? '';

    // Coordinates are points, not pixels: the daemon's own space.
    expect(describe('offstage_session_input')).toContain('POINTS');
    // Screenshot before and after, because nothing else reports what input hit.
    expect(describe('offstage_session_input')).toMatch(/screenshot, then input, then screenshot/i);
    expect(describe('offstage_session_screenshot')).toMatch(/BEFORE .* AFTER/);
    // And never the user's own session.
    expect(describe('offstage_session_input')).toContain("never reach the user's keyboard");
    expect(describe('offstage_session_screenshot')).toContain("never the user's own");
    expect(describe('offstage_session_apps')).toContain('must never be driven');
    // doctor and run must name the lane, or an agent never learns it exists.
    expect(describe('offstage_doctor')).toContain('session');
    expect(describe('offstage_run')).toContain('offstage session share');
  });

  it('answers offstage_session_status through the core', async () => {
    const core = new FakeCore();
    const { client, server } = await connect(core);
    cleanup.push(() => client.close(), () => server.close());

    const parsed = CallToolResultSchema.parse(
      await client.callTool({ name: 'offstage_session_status', arguments: {} }, CallToolResultSchema),
    );
    expect(parsed.isError).not.toBe(true);
    const status = JSON.parse(parsed.content[0]?.type === 'text' ? parsed.content[0].text : '{}') as SessionStatus;
    expect(status.available).toBe(true);
    expect(status.display).toEqual({ width: 1728, height: 1117, scale: 2 });
    expect(core.sessionCalls[0]?.tool).toBe('status');
  });

  it('returns the session screenshot as an image block beside its geometry', async () => {
    const core = new FakeCore();
    const { client, server } = await connect(core);
    cleanup.push(() => client.close(), () => server.close());

    const parsed = CallToolResultSchema.parse(
      await client.callTool(
        { name: 'offstage_session_screenshot', arguments: { maxDimension: 1280 } },
        CallToolResultSchema,
      ),
    );
    expect(parsed.content.map((item) => item.type)).toEqual(['text', 'image']);
    expect(JSON.parse(parsed.content[0]?.type === 'text' ? parsed.content[0].text : '{}')).toEqual({
      width: 1728,
      height: 1117,
      scale: 2,
    });
    expect(parsed.content[1]?.type === 'image' ? parsed.content[1].data : '').toBe(
      FAKE_PNG.toString('base64'),
    );
    // An agent gets bytes; nothing is dropped into the user's repository.
    expect((core.sessionCalls[0]?.input as SessionScreenshotInput).out).toBeNull();
  });

  it('validates input actions against the daemon\'s own schema before opening a socket', async () => {
    const core = new FakeCore();
    const { client, server } = await connect(core);
    cleanup.push(() => client.close(), () => server.close());

    const bad = CallToolResultSchema.parse(
      await client.callTool(
        { name: 'offstage_session_input', arguments: { actions: [{ type: 'teleport', x: 1, y: 2 }] } },
        CallToolResultSchema,
      ),
    );
    expect(bad.isError).toBe(true);
    expect(core.sessionCalls).toHaveLength(0);

    const empty = CallToolResultSchema.parse(
      await client.callTool(
        { name: 'offstage_session_input', arguments: { actions: [] } },
        CallToolResultSchema,
      ),
    );
    expect(empty.isError).toBe(true);

    const good = CallToolResultSchema.parse(
      await client.callTool(
        {
          name: 'offstage_session_input',
          arguments: { actions: [{ type: 'click', x: 640, y: 400 }, { type: 'type', text: 'hi' }] },
        },
        CallToolResultSchema,
      ),
    );
    expect(good.isError).not.toBe(true);
    expect(JSON.parse(good.content[0]?.type === 'text' ? good.content[0].text : '{}').performed).toBe(2);
  });

  it('lists the helper session\'s apps', async () => {
    const core = new FakeCore();
    const { client, server } = await connect(core);
    cleanup.push(() => client.close(), () => server.close());

    const parsed = CallToolResultSchema.parse(
      await client.callTool({ name: 'offstage_session_apps', arguments: {} }, CallToolResultSchema),
    );
    const apps = JSON.parse(parsed.content[0]?.type === 'text' ? parsed.content[0].text : '[]') as SessionApp[];
    expect(apps).toHaveLength(1);
    expect(apps[0]?.bundleId).toBe('com.apple.Safari');
  });

  it('answers an offstage_route tools/call round trip without a container runtime', async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());

    const result = await client.callTool(
      {
        name: 'offstage_route',
        arguments: { cwd: process.cwd(), command: ['npx', 'playwright', 'test'] },
      },
      CallToolResultSchema,
    );
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).not.toBe(true);
    expect(parsed.content).toHaveLength(1);
    expect(parsed.content[0]?.type).toBe('text');
    const decision = JSON.parse(parsed.content[0]?.type === 'text' ? parsed.content[0].text : '{}') as RouteDecision;
    expect(decision).toEqual(routeDecision);
  });

  it('returns container screenshots as MCP image content alongside the JSON envelope', async () => {
    const core = new FakeCore();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-mcp-test-'));
    cleanup.push(() => fs.rm(tempDir, { recursive: true, force: true }));
    core.screenshotPath = path.join(tempDir, 'screen.png');
    await fs.writeFile(core.screenshotPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { client, server } = await connect(core);
    cleanup.push(() => client.close(), () => server.close());

    const result = await client.callTool(
      {
        name: 'offstage_run',
        arguments: { cwd: process.cwd(), command: ['npx', 'playwright', 'test', '--headed'], lane: 'container' },
      },
      CallToolResultSchema,
    );
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).not.toBe(true);
    expect(parsed.content.map((item) => item.type)).toEqual(['text', 'image']);
    expect(parsed.content[1]?.type === 'image' ? parsed.content[1].mimeType : '').toBe('image/png');
    expect(parsed.content[1]?.type === 'image' ? parsed.content[1].data : '').toBe('iVBORw==');
  });

  it('returns structured MCP tool errors for invalid input', async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());

    const result = await client.callTool(
      {
        name: 'offstage_run',
        arguments: { cwd: process.cwd(), command: [] },
      },
      CallToolResultSchema,
    );
    const parsed = CallToolResultSchema.parse(result);

    expect(parsed.isError).toBe(true);
    expect(parsed.content[0]?.type).toBe('text');
    expect(parsed.content[0]?.type === 'text' ? parsed.content[0].text : '').toContain('Input validation error');
  });

  it('rejects an unknown argument rather than silently ignoring it', async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());

    const result = await client.callTool(
      {
        name: 'offstage_run',
        arguments: { cwd: process.cwd(), command: ['npm', 'test'], force: true },
      },
      CallToolResultSchema,
    );
    expect(CallToolResultSchema.parse(result).isError).toBe(true);
  });
});

/**
 * The default core must be the CLI's api and nothing else. If lane dispatch
 * ever grows a second implementation here, an agent and a human get different
 * answers for the same command: including, eventually, different answers about
 * what is safe to run in place.
 */
describe('the default core is the CLI api', () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanup.length > 0) await cleanup.pop()?.();
  });

  it('routes through the same classifier the CLI uses', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-core-'));
    cleanup.push(() => fs.rm(cwd, { recursive: true, force: true }));

    // xcodebuild is macOS-native but changes nothing about the machine, so it
    // routes to the session lane.
    const decision = await createDefaultCore().route({ cwd, command: ['xcodebuild', 'test'] });
    expect(decision.lane).toBe('session');
    // hdiutil could change the machine itself, and offstage has no lane that
    // isolates that, so it is refused rather than routed anywhere.
    const installer = await createDefaultCore().route({ cwd, command: ['hdiutil', 'attach', 'App.dmg'] });
    expect(installer.refuse).toBeDefined();
  });

  it('enforces the CLI\'s refusal: forcing headless onto isolated work runs nothing', async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-core-'));
    cleanup.push(() => fs.rm(cwd, { recursive: true, force: true }));

    const outcome = await createDefaultCore().run({
      cwd,
      command: ['npx', 'playwright', 'test', '--headed'],
      lane: 'headless',
    });

    expect(outcome.result.status).toBe('errored');
    expect(outcome.result.diagnostics[0]).toContain('Refused: --lane headless');
  });
});
