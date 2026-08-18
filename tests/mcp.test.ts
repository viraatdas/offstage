import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { LaneResult, RouteDecision } from '../src/contract/index.js';
import { createLaneResult } from '../src/contract/index.js';
import type { DoctorReport, OffstageCore, ProbeInput, RouteInput, RunInput } from '../src/mcp/core.js';
import { createOffstageMcpServer } from '../src/mcp/server.js';
import type { EntitlementsProbeReport } from '../src/probe/index.js';

const routeDecision: RouteDecision = {
  lane: 'headless',
  confidence: 'high',
  reason: 'Playwright defaults to headless, so offstage can run this in place without opening a window.',
  signals: ['argv: playwright test defaults to headless'],
};

class FakeCore implements OffstageCore {
  screenshotPath: string | null = null;

  async doctor(): Promise<DoctorReport> {
    return {
      lanes: {
        headless: { available: true },
        container: { available: false, reason: 'no container runtime', fix: 'install Docker or start Colima' },
        vm: { available: false, reason: 'tart is not installed', fix: 'brew install openai/tools/tart' },
      },
    };
  }

  async route(input: RouteInput): Promise<RouteDecision> {
    expect(input.command.length).toBeGreaterThan(0);
    return routeDecision;
  }

  async run(input: RunInput): Promise<LaneResult> {
    const artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-mcp-artifacts-'));
    const result = createLaneResult({
      lane: input.lane ?? 'container',
      status: 'passed',
      exitCode: 0,
      artifactsDir,
      diagnostics: ['fake run completed off-screen'],
    });
    if (this.screenshotPath !== null) {
      result.artifacts.push({ kind: 'screenshot', path: this.screenshotPath });
    }
    return result;
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

  it('lists the four offstage tools with useful descriptions', async () => {
    const { client, server } = await connect();
    cleanup.push(() => client.close(), () => server.close());

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'offstage_doctor',
      'offstage_probe',
      'offstage_route',
      'offstage_run',
    ]);
    expect(tools.tools.find((tool) => tool.name === 'offstage_route')?.description).toContain('Call this first');
    expect(tools.tools.find((tool) => tool.name === 'offstage_run')?.description).toContain(
      'never falls back to the user real display',
    );
  });

  it('answers an offstage_route tools/call round trip without container or tart', async () => {
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
});
