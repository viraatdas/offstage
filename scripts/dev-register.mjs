#!/usr/bin/env node
/**
 * Register *this* checkout as `offstage-dev`, with the absolute path filled in.
 *
 * The name matters more than the convenience. Registering a local build under
 * `offstage` silently displaces the published server that `.mcp.json` and the
 * plugin both declare, and the displacement is invisible: same tool names, same
 * version field, different code. That is how five long-lived MCP processes ended
 * up serving a stale `dist/` to sessions that believed they were on the
 * published package. `offstage-dev` sits beside the real one instead.
 *
 *   npm run dev:register          # build, then register with Claude Code
 *   npm run dev:register -- --print   # print the commands, change nothing
 */

import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = path.join(ROOT, 'dist', 'mcp', 'index.js');
const NAME = 'offstage-dev';
const printOnly = process.argv.includes('--print');

const codexBlock = `[mcp_servers.${NAME}]\ncommand = "node"\nargs = ["${SERVER}"]`;
const claudeCommand = `claude mcp add ${NAME} -- node ${SERVER}`;

if (printOnly) {
  console.log(`# Claude Code\n${claudeCommand}\n\n# Codex: append to ~/.codex/config.toml\n${codexBlock}`);
  process.exit(0);
}

console.log('building, so the server you register is the code you just wrote…');
execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });

const claude = spawnSync('claude', ['mcp', 'add', NAME, '--', 'node', SERVER], { cwd: ROOT, stdio: 'inherit' });
if (claude.error) {
  console.log(`\nNo \`claude\` on PATH. Register it yourself:\n  ${claudeCommand}`);
} else if (claude.status !== 0) {
  console.log(`\n\`claude mcp add\` exited ${claude.status}. If ${NAME} already exists, remove it first:\n  claude mcp remove ${NAME}`);
} else {
  console.log(`\nRegistered ${NAME} → ${SERVER}`);
}

console.log(
  `\nCodex uses the same build. Append to ~/.codex/config.toml (it does not expand ~ or relative paths):\n\n${codexBlock}\n` +
    `\nEither way, restart the agent: an MCP server is spawned once per session and keeps the build it launched with.`,
);
