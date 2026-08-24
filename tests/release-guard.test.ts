/**
 * The guard that keeps a release deliverable.
 *
 * The decision is a pure function so the interesting cases, the ones that
 * involve a git history you would otherwise have to fabricate, are testable
 * without a repository. The integration side (does it read this repo's tags)
 * is covered by CI running the script for real.
 */

import { describe, expect, it } from 'vitest';

// @ts-expect-error: plain ESM development script, deliberately outside tsconfig's src.
import { SHIPPED, isShipped, verdict } from '../scripts/release-guard.mjs';

const base = {
  tag: 'v0.2.2',
  previous: '0.2.2',
  current: '0.2.2',
  changed: [] as string[],
  pluginVersion: '0.2.2',
};

describe('what counts as shipped', () => {
  it('covers the files that change what an installed copy does', () => {
    expect(isShipped('.mcp.json')).toBe(true);
    expect(isShipped('skills/offstage/SKILL.md')).toBe(true);
    expect(isShipped('.claude-plugin/plugin.json')).toBe(true);
    expect(isShipped('src/cli/api.ts')).toBe(true);
    expect(isShipped('docker/Dockerfile')).toBe(true);
  });

  it('leaves out what ships but cannot change behaviour, so the guard stays worth obeying', () => {
    expect(isShipped('tests/e2e.test.ts')).toBe(false);
    expect(isShipped('README.md')).toBe(false);
    expect(isShipped('tests/plugin.test.ts')).toBe(false);
    expect(isShipped('.github/workflows/ci.yml')).toBe(false);
  });

  it('matches `.mcp.json` exactly rather than as a prefix', () => {
    expect(SHIPPED).toContain('.mcp.json');
    expect(isShipped('.mcp.json.bak')).toBe(false);
  });
});

describe('the verdict', () => {
  it('reproduces the bug it was written for: a shipped file changed, the version did not', () => {
    const result = verdict({ ...base, changed: ['.mcp.json'] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('.mcp.json');
    expect(result.message).toContain('still 0.2.2');
  });

  it('passes once the version moves with the change', () => {
    const result = verdict({ ...base, current: '0.2.3', pluginVersion: '0.2.3', changed: ['.mcp.json'] });
    expect(result.ok).toBe(true);
  });

  it('passes when only unshipped files changed', () => {
    const result = verdict({ ...base, changed: ['tests/e2e.test.ts', 'README.md'] });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no shipped file changed');
  });

  it('fails when the two manifests disagree, whatever else is true', () => {
    const result = verdict({ ...base, current: '0.2.3', pluginVersion: '0.2.2', changed: [] });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('0.2.3');
    expect(result.message).toContain('0.2.2');
  });

  it('is silent in a repository with no version tag rather than inventing one', () => {
    const result = verdict({ ...base, tag: null, previous: null, changed: ['src/cli/api.ts'] });
    expect(result.ok).toBe(true);
  });
});
