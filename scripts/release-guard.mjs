#!/usr/bin/env node
/**
 * Refuse a release that cannot reach anyone.
 *
 * `claude plugin update` compares the version declared in
 * `.claude-plugin/plugin.json` — not the git SHA. So a commit that edits a
 * shipped file without bumping the version is invisible to everyone already
 * installed: the marketplace clone moves, the cache does not, and only an
 * uninstall/install cycle picks it up.
 *
 * That is not hypothetical. v0.2.2 shipped, then commit 240108a changed
 * `.mcp.json` — the file telling people to register a local checkout under a
 * name that would not collide with the plugin's own — and could never be
 * delivered to a single existing install.
 *
 * This guard fails when a file that ships has changed since the last version
 * tag while the version stayed put. Docs are deliberately outside the set:
 * they ship in the tarball but change nothing about installed behaviour, and
 * a guard that fires on typo fixes gets switched off.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Prefixes whose contents change what an installed copy of offstage does. */
export const SHIPPED = ['src/', 'skills/', 'docker/', '.claude-plugin/', '.mcp.json', 'package.json'];

export function isShipped(file) {
  return SHIPPED.some((prefix) => (prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix));
}

/**
 * The verdict, as a pure function of facts a caller can fake in a test.
 * `previous` is the version at the last tag; `current` is the version now.
 */
export function verdict({ tag, previous, current, changed, pluginVersion }) {
  if (pluginVersion !== current) {
    return {
      ok: false,
      message:
        `package.json says ${current} but .claude-plugin/plugin.json says ${pluginVersion}. ` +
        `Claude Code installs on the plugin's number, npm publishes on the package's; ` +
        `when they disagree one of the two is wrong for every user.`,
    };
  }

  if (tag === null) return { ok: true, message: 'no version tag yet — nothing to compare against.' };

  const shipped = changed.filter(isShipped);
  if (shipped.length === 0) {
    return { ok: true, message: `no shipped file changed since ${tag}.` };
  }
  if (previous !== current) {
    return { ok: true, message: `${shipped.length} shipped file(s) changed since ${tag}, and the version moved ${previous} → ${current}.` };
  }
  return {
    ok: false,
    message:
      `these files ship, changed since ${tag}, and the version is still ${current}:\n` +
      shipped.map((file) => `  ${file}`).join('\n') +
      `\n\nAnyone already on ${current} will never receive them: \`claude plugin update\` ` +
      `compares the declared version, not the commit. Bump package.json and ` +
      `.claude-plugin/plugin.json together, or move these files out of the shipped set.`,
  };
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const readJson = (relative) => JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));

function lastVersionTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*');
  } catch {
    return null; // No tags reachable — a fresh clone with fetch-depth 1, or a repo before its first release.
  }
}

function versionAt(tag) {
  try {
    return JSON.parse(git('show', `${tag}:package.json`)).version;
  } catch {
    return null;
  }
}

function main() {
  const current = readJson('package.json').version;
  const pluginVersion = readJson('.claude-plugin/plugin.json').version;
  const tag = lastVersionTag();
  const changed = tag ? git('diff', '--name-only', `${tag}..HEAD`).split('\n').filter(Boolean) : [];
  const result = verdict({ tag, previous: tag ? versionAt(tag) : null, current, changed, pluginVersion });

  console.log(result.ok ? `release-guard: ok — ${result.message}` : `release-guard: FAILED\n\n${result.message}`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
