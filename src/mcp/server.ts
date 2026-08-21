import fs from 'node:fs/promises';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ImageContent, TextContent } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { offstageInstall } from '../cli/api.js';
import { LaneSchema } from '../contract/index.js';
import type { LaneResult } from '../contract/index.js';
import { InputActionSchema } from '../session/index.js';
import type { OffstageCore } from './core.js';
import { createDefaultCore } from './core.js';

const EmptyArgsSchema = z.object({}).strict();
const RouteArgsSchema = z
  .object({
    cwd: z.string().min(1),
    command: z.array(z.string().min(1)).min(1),
    headed: z.boolean().optional(),
  })
  .strict();
const RunArgsSchema = RouteArgsSchema.extend({
  lane: LaneSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
const ProbeArgsSchema = z
  .object({
    path: z.string().min(1),
    allowExternalTools: z.boolean().optional(),
  })
  .strict();

/* The session tools all take the same optional account override, because a
   machine may have more than one helper account and the agent should never
   have to guess which one a previous call used. */
const SessionStatusArgsSchema = z.object({ user: z.string().min(1).optional() }).strict();
const SessionScreenshotArgsSchema = z
  .object({
    maxDimension: z.number().int().positive().optional(),
    user: z.string().min(1).optional(),
  })
  .strict();
/* The action schema is the daemon client's own, so an agent cannot send this
   server a shape the daemon would reject — the validation error arrives before
   the socket is opened, naming the offending action. */
const SessionInputArgsSchema = z
  .object({
    actions: z.array(InputActionSchema).min(1),
    user: z.string().min(1).optional(),
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
  const install = offstageInstall();
  const server = new McpServer({
    name: 'offstage',
    version: install.version,
    // `version` alone cannot distinguish the published package from a local
    // build, and a client sees `serverInfo` before it can call any tool. Say
    // where this process came from at the point of introduction.
    title: install.root ? `offstage ${install.version} (${install.root})` : `offstage ${install.version}`,
  });

  server.registerTool(
    'offstage_doctor',
    {
      title: 'offstage doctor',
      description:
        'Report per-lane availability and concrete fixes for all three lanes: headless, session (a second logged-in macOS account whose display and input are its own), and container. offstage keeps UI, browser, and macOS app work off the user screen; unavailable isolation is reported, never bypassed.',
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
        'Cheap, side-effect-free lane decision for a command. Call this first when unsure: it only inspects argv and small repo files and explains whether offstage will use headless, session, or container, or refuse the command outright because it could change the machine.',
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
        'Run a command off the user screen through the selected offstage lane, and return the normalized result plus where it was written. Headed browser work uses a Linux container with a virtual display; macOS-native work (xcodebuild, xcrun, open -a, osascript) uses lane "session" — a second, logged-in macOS account with its own display and its own input stream, so the window never reaches the user screen. This never falls back to the user real display: forcing lane "headless" on work that needs isolation is refused, not honoured, and anything that could change the machine itself (installers, .dmg/.pkg, hdiutil) is refused outright on every lane, because offstage has no substrate that isolates a change to the machine. The session lane needs the helper account to be able to READ the working directory: a spawn failure there is fixed by the user running `offstage session share <dir>`, not by running the command outside offstage.',
      inputSchema: RunArgsSchema,
    },
    async (args) =>
      callSafely(RunArgsSchema, args, async (input) => {
        const outcome = await core.run(input);
        return {
          content: [jsonText(outcome), ...(await screenshotContent(outcome.result))],
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

  server.registerTool(
    'offstage_session_status',
    {
      title: 'offstage session status',
      description:
        'Report whether the macOS session lane can run right now: the helper account, whether it has a background GUI session, whether the offstage-sessiond daemon answers, the display size in points, and whether Screen Recording and Accessibility are granted to the daemon inside that session. Call this before offstage_session_screenshot or offstage_session_input. When it reports unavailable, relay its `fix` to the user — setup runs `sudo` and needs a terminal, so `offstage session setup` is something the human types, not something you can call.',
      inputSchema: SessionStatusArgsSchema,
    },
    async (args) =>
      callSafely(SessionStatusArgsSchema, args, async (input) => ({
        content: [jsonText(await core.sessionStatus(input))],
      })),
  );

  server.registerTool(
    'offstage_session_screenshot',
    {
      title: 'offstage session screenshot',
      description:
        "Capture the helper session's screen and return it as an image plus its pixel size and backing scale. This is the OTHER account's display, never the user's own — it is safe to call while the user is working, and it is the only way to see what a session-lane run did. Take one BEFORE deciding on any input and one AFTER performing it: input is fire-and-forget and nothing else reports what it hit. Divide pixel coordinates from this image by `scale` to get the points that offstage_session_input takes.",
      inputSchema: SessionScreenshotArgsSchema,
    },
    async (args) =>
      callSafely(SessionScreenshotArgsSchema, args, async (input) => {
        // `out: null` on purpose: an agent wants the bytes, not a PNG dropped
        // into the user's repository on every look.
        const shot = await core.sessionScreenshot({ ...input, out: null });
        return {
          content: [
            jsonText({ width: shot.width, height: shot.height, scale: shot.scale }),
            {
              type: 'image',
              data: shot.png.toString('base64'),
              mimeType: 'image/png',
            } satisfies ImageContent,
          ],
        };
      }),
  );

  server.registerTool(
    'offstage_session_input',
    {
      title: 'offstage session input',
      description:
        'Inject keyboard and mouse events into the helper macOS session — move, click, drag, scroll, type, key, wait. Coordinates are POINTS in that session\'s global display space, origin at the top-left of its main display (a screenshot\'s pixels divided by its `scale`), never pixels and never coordinates from the user\'s own screen. These events are posted to that session\'s own event tap, so the window server routes them inside the helper session only; they never reach the user\'s keyboard, mouse or focus, and there is no mode in which they could. `drag` and `scroll` are implemented but not yet verified in the session lane; `click`, `key` and `type` are. Always screenshot, then input, then screenshot again. Requires Accessibility to be granted to offstage-sessiond inside that session — offstage_session_status says whether it is.',
      inputSchema: SessionInputArgsSchema,
    },
    async (args) =>
      callSafely(SessionInputArgsSchema, args, async (input) => ({
        content: [jsonText(await core.sessionInput(input))],
      })),
  );

  server.registerTool(
    'offstage_session_apps',
    {
      title: 'offstage session apps',
      description:
        'List the apps running in the helper macOS session, with pid, name, bundle id and whether each is frontmost. Use it to confirm that a session-lane run actually launched what it was supposed to, without taking a screenshot. It reports the OTHER account\'s apps; the user\'s own running apps are not visible here and must never be driven.',
      inputSchema: SessionStatusArgsSchema,
    },
    async (args) =>
      callSafely(SessionStatusArgsSchema, args, async (input) => ({
        content: [jsonText(await core.sessionApps(input))],
      })),
  );

  return server;
}
