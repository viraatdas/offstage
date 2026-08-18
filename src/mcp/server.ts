import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { LaneSchema } from '../contract/index.js';
import type { LaneResult } from '../contract/index.js';
import type { OffstageCore } from './core.js';
import { createDefaultCore } from './core.js';

const EmptyArgsSchema = z.object({}).strict();
const RouteArgsSchema = z
  .object({
    cwd: z.string().min(1),
    command: z.array(z.string().min(1)).min(1),
  })
  .strict();
const RunArgsSchema = RouteArgsSchema.extend({
  lane: LaneSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
const ProbeArgsSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();

type ToolArgsSchema<T extends z.ZodTypeAny> = z.infer<T>;

const jsonText = (value: unknown): TextContent => ({
  type: 'text',
  text: JSON.stringify(value, null, 2),
});

const toolError = (message: string, details?: unknown): CallToolResult => ({
  isError: true,
  content: [jsonText(details === undefined ? { error: message } : { error: message, details })],
});

function parseArgs<T extends z.ZodTypeAny>(
  schema: T,
  args: unknown,
): { ok: true; value: ToolArgsSchema<T> } | { ok: false; result: CallToolResult } {
  const parsed = schema.safeParse(args ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    result: toolError('Invalid tool arguments', z.treeifyError(parsed.error)),
  };
}

async function callSafely<T>(
  schema: z.ZodType<T>,
  args: unknown,
  handler: (input: T) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const parsed = parseArgs(schema, args);
  if (!parsed.ok) return parsed.result;
  try {
    return await handler(parsed.value);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
}

function mimeTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/png';
  }
}

async function screenshotContent(result: LaneResult): Promise<ImageContent[]> {
  const screenshots = result.artifacts.filter((artifact) => artifact.kind === 'screenshot');
  const content: ImageContent[] = [];
  for (const artifact of screenshots) {
    try {
      const data = await fs.readFile(artifact.path);
      content.push({
        type: 'image',
        data: data.toString('base64'),
        mimeType: mimeTypeFor(artifact.path),
      });
    } catch {
      // The JSON envelope still names the missing artifact. Do not fail the run result.
    }
  }
  return content;
}

export function createOffstageMcpServer(core: OffstageCore = createDefaultCore()): McpServer {
  const server = new McpServer({
    name: 'offstage',
    version: '0.1.0',
  });

  server.registerTool(
    'offstage_doctor',
    {
      title: 'offstage doctor',
      description:
        'Report per-lane availability and concrete fixes. offstage keeps UI, browser, and macOS app work off the user screen; unavailable isolation is reported, never bypassed.',
      inputSchema: EmptyArgsSchema,
    },
    async (args) =>
      callSafely(EmptyArgsSchema, args, async () => ({
        content: [jsonText(await core.doctor())],
      })),
  );

  server.registerTool(
    'offstage_route',
    {
      title: 'offstage route',
      description:
        'Cheap, side-effect-free lane decision for a command. Call this first when unsure: it only inspects argv and small repo files and explains whether offstage will use headless, container, or vm.',
      inputSchema: RouteArgsSchema,
    },
    async (args) =>
      callSafely(RouteArgsSchema, args, async (input) => ({
        content: [jsonText(await core.route(input))],
      })),
  );

  server.registerTool(
    'offstage_run',
    {
      title: 'offstage run',
      description:
        'Run a command off the user screen through the selected offstage lane. Headed browser work uses a virtual display, macOS-native work uses a VM, and this never falls back to the user real display.',
      inputSchema: RunArgsSchema,
    },
    async (args) =>
      callSafely(RunArgsSchema, args, async (input) => {
        const result = await core.run(input);
        return {
          content: [jsonText(result), ...(await screenshotContent(result))],
        };
      }),
  );

  server.registerTool(
    'offstage_probe',
    {
      title: 'offstage probe',
      description:
        'Inspect a project, app, dmg, or entitlements file and report whether ad-hoc VM testing is enough or a signing lane is required.',
      inputSchema: ProbeArgsSchema,
    },
    async (args) =>
      callSafely(ProbeArgsSchema, args, async (input) => ({
        content: [jsonText(await core.probe(input))],
      })),
  );

  return server;
}
