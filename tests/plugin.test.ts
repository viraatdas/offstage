/**
 * The agent-facing surface: the Claude Code plugin, the skill, and the MCP
 * registration both agents load.
 *
 * These files are configuration, so nothing about them fails at compile time
 * and a typo is invisible until an install silently does nothing. What is worth
 * asserting is the wiring: that the paths named here exist, that the version
 * the plugin advertises is the version the package is, and that the skill's
 * description actually mentions the work it is supposed to trigger on.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const readJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8')) as T;

const pkg = readJson<{ name: string; version: string; files: string[]; bin: Record<string, string> }>(
  'package.json',
);

describe('.claude-plugin/plugin.json', () => {
  const plugin = readJson<Record<string, unknown>>('.claude-plugin/plugin.json');

  it('carries the fields Claude Code requires to install it', () => {
    expect(plugin.name).toBe('offstage');
    expect(typeof plugin.description).toBe('string');
    expect((plugin.description as string).length).toBeGreaterThan(40);
    expect(plugin.author).toBeTypeOf('object');
  });

  it('advertises the version the package actually is', () => {
    // Two files claiming different versions is the classic plugin bug: users
    // install what they think is a new build and get the old behaviour.
    expect(plugin.version).toBe(pkg.version);
  });

  it('is listed by the marketplace manifest beside it', () => {
    const marketplace = readJson<{ plugins: Array<{ name: string; source: string }> }>(
      '.claude-plugin/marketplace.json',
    );
    const entry = marketplace.plugins.find((candidate) => candidate.name === 'offstage');
    expect(entry, 'the marketplace must list the plugin it ships').toBeDefined();
    expect(entry?.source).toBe('./');
  });
});

describe('.mcp.json', () => {
  const mcp = readJson<{
    mcpServers: Record<string, { type?: string; command: string; args: string[] }>;
  }>('.mcp.json');

  it('registers one stdio server called offstage', () => {
    expect(Object.keys(mcp.mcpServers)).toEqual(['offstage']);
    expect(mcp.mcpServers.offstage?.type).toBe('stdio');
  });

  it('runs the published package, which is the only form that survives a plugin install', () => {
    // A plugin install *clones* — it runs no npm install and no build — so a
    // server pointing at `dist/` is dead on arrival, and a path under
    // `${CLAUDE_PLUGIN_ROOT}` only names a file that was never built.
    // `npx <published package>` needs neither, and works at project scope too.
    const server = mcp.mcpServers.offstage;
    expect(server?.command).toBe('npx');
    expect(server?.args).toContain('-y');
    expect(server?.args.at(-1)).toBe('offstage-mcp');
  });

  it('names the package with --package=, which npx requires to pick a second bin', () => {
    // npx resolves a binary by PACKAGE name. `npx -y @viraatdas/offstage
    // offstage-mcp` therefore runs the `offstage` CLI with `offstage-mcp` as an
    // argument — it prints help and never speaks MCP, which looks like a broken
    // server rather than a wrong command. Verified against the published
    // package: the bare form returns no tools, the --package= form returns 4.
    const args = mcp.mcpServers.offstage?.args ?? [];
    const named = args.find((arg) => arg.startsWith('--package='));
    expect(named, '.mcp.json must pass --package=<name> so npx picks the right bin').toBeDefined();
    expect(named).toContain(pkg.name);
    expect(args.some((arg) => !arg.startsWith('--') && arg.startsWith(pkg.name))).toBe(false);
  });

  it('names a bin the package actually publishes', () => {
    expect(Object.keys(pkg.bin)).toContain(mcp.mcpServers.offstage?.args.at(-1));
  });

  it('resolves without any variable the host has to substitute', () => {
    // `${CLAUDE_PLUGIN_ROOT}` is substituted only for a plugin-provided server.
    // At project scope it is passed through literally and Claude Code reports a
    // missing environment variable, so the same file cannot use it and work in
    // both places.
    for (const arg of mcp.mcpServers.offstage?.args ?? []) {
      expect(arg).not.toContain('${');
    }
  });

  it('is published under a scope its owner controls', () => {
    // The unscoped name `offstage` belongs to an unrelated package on npm, so
    // publishing under it is impossible; the plugin depends on the published
    // package existing, which makes the name part of the wiring.
    expect(pkg.name).toBe('@viraatdas/offstage');
  });

  it('names a real source file, so the server exists before it is built', () => {
    // dist/ is a build output and may legitimately be absent on a clean clone;
    // the source behind it must not be.
    expect(existsSync(path.join(ROOT, 'src/mcp/index.ts'))).toBe(true);
  });
});

describe('skills/offstage/SKILL.md', () => {
  const raw = readFileSync(path.join(ROOT, 'skills/offstage/SKILL.md'), 'utf8');
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  const description = /^description:\s*(.+)$/m.exec(frontmatter?.[1] ?? '')?.[1] ?? '';

  it('opens with YAML frontmatter carrying a name and a description', () => {
    expect(frontmatter, 'SKILL.md must start with a --- frontmatter block').not.toBeNull();
    expect(/^name:\s*offstage$/m.test(frontmatter?.[1] ?? '')).toBe(true);
    expect(description.length).toBeGreaterThan(80);
    expect(description.length).toBeLessThanOrEqual(1024);
  });

  it('describes the work it must trigger on, in the words a user would use', () => {
    // A skill that does not name the tools is a skill that never loads.
    for (const trigger of ['Playwright', 'headed', 'xcodebuild', 'simulator', 'screen']) {
      expect(description.toLowerCase(), `description should mention ${trigger}`).toContain(
        trigger.toLowerCase(),
      );
    }
  });

  it('tells the agent what to do when a lane is unavailable', () => {
    // The dangerous failure mode is an agent that "helpfully" re-runs the
    // command directly when offstage skips it. Say so in the skill itself.
    expect(raw).toMatch(/skipped/i);
    expect(raw).toMatch(/--lane headless/);
    expect(raw).toContain('nothing ran anywhere');
  });

  it('does not tell the agent that failures[] works for every runner', () => {
    // Reporter coverage is Playwright/Vitest/Jest by design; an agent that
    // expects parsed failures from pytest will misreport an empty array.
    expect(raw).toMatch(/Playwright, Vitest and Jest only/);
  });
});

describe('what npm ships', () => {
  it('includes every directory the plugin and the skill live in', () => {
    for (const entry of ['dist', 'docker', 'docs', 'skills', '.claude-plugin', '.mcp.json']) {
      expect(pkg.files, `package.json files must include ${entry}`).toContain(entry);
    }
  });
});
