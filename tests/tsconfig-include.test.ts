/**
 * Guards that the `include` globs in our tsconfigs describe the repository as
 * it actually is.
 *
 * Two failure modes, both silent under plain `tsc`:
 *
 *  1. An `include` pattern that matches nothing. TypeScript only raises
 *     TS18003 ("No inputs were found") when the *whole* include list is empty,
 *     so a single dead glob — `scripts/**\/*.ts` for a `scripts/` directory
 *     that was never created — sits in the config forever, advertising
 *     coverage the program does not have.
 *
 *  2. A `.ts` file that no pattern matches. `npm run typecheck` stays green
 *     because the file is simply not in the program. If someone later adds
 *     `scripts/build-docker.ts`, this suite fails and tells them to put the
 *     glob back rather than letting the file go unchecked.
 *
 * Both assertions use TypeScript's own config parser, so the glob semantics
 * here are the compiler's, not a reimplementation of them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface RawTsconfig {
  compilerOptions?: unknown;
  include?: string[];
  exclude?: string[];
}

/** Reads a tsconfig as raw JSONC. `extends` is deliberately left unresolved: only include/exclude matter here, and both are owned by the file itself. */
function readRaw(configName: string): RawTsconfig {
  const configPath = path.join(repoRoot, configName);
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(error, `${configName} is not parseable`).toBeUndefined();
  return config as RawTsconfig;
}

/** Expands one include pattern through the compiler's own globber, honoring the config's real `exclude`. */
function filesMatching(raw: RawTsconfig, include: string[]): string[] {
  const parsed = ts.parseJsonConfigFileContent(
    { compilerOptions: raw.compilerOptions, include, exclude: raw.exclude },
    ts.sys,
    repoRoot,
  );
  return parsed.fileNames.map((file) => path.relative(repoRoot, file));
}

const CONFIGS = ['tsconfig.json', 'tsconfig.build.json'] as const;

describe.each(CONFIGS)('%s include patterns', (configName) => {
  const raw = readRaw(configName);
  const patterns = raw.include ?? [];

  it('declares at least one include pattern', () => {
    expect(patterns.length).toBeGreaterThan(0);
  });

  it.each(patterns)('%s matches at least one file on disk', (pattern) => {
    // A pattern matching nothing is dead config: it either points at a
    // directory that does not exist yet, or at one that has been removed.
    // Delete it, or create the files it promises.
    expect(filesMatching(raw, [pattern])).not.toEqual([]);
  });
});

describe('tsconfig.json program coverage', () => {
  it('typechecks every .ts file the excludes do not deliberately drop', () => {
    const raw = readRaw('tsconfig.json');
    // `**/*.ts` under this config's own `exclude`: everything TypeScript would
    // consider ours. Dot-directories (.jj, .offstage) and node_modules are
    // skipped by the compiler's wildcard matcher.
    const everything = filesMatching(raw, ['**/*.ts']);
    const inProgram = new Set(filesMatching(raw, raw.include ?? []));
    const unchecked = everything.filter((file) => !inProgram.has(file));

    // If this fails, the file is invisible to `npm run typecheck`. Add a glob
    // covering it to tsconfig.json's `include`, or add it to `exclude` with a
    // comment saying why it is not our code to check.
    expect(unchecked).toEqual([]);
  });
});
