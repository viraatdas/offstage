/**
 * Guards the two-tsconfig split.
 *
 * The project deliberately ships two configs, and they are not interchangeable:
 *
 *   tsconfig.json        noEmit typecheck + editor config. Covers src AND tests,
 *                        so a type error in a test fails `npm run typecheck`.
 *   tsconfig.build.json  the emitting config. rootDir src -> outDir dist, so the
 *                        published tree is dist/contract/index.js, NOT
 *                        dist/src/contract/index.js.
 *
 * One config cannot do both jobs: tsc rejects `rootDir: src` the moment tests/
 * enters the program (TS6059), and relaxing rootDir to "." silently republishes
 * everything one directory deeper, breaking every `bin`/`exports`/`types` path in
 * package.json. These assertions exist so a future "simplification" back to a
 * single config fails loudly here instead of shipping a broken dist layout.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Parse a tsconfig the way tsc itself does: JSONC, with `extends` resolved. */
function effectiveConfig(name: string): ts.ParsedCommandLine {
  const configPath = path.join(ROOT, name);
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  expect(error, `${name} is not readable as JSONC`).toBeUndefined();
  return ts.parseJsonConfigFileContent(config, ts.sys, ROOT, undefined, configPath);
}

const under = (dir: string, file: string): boolean =>
  !path.relative(dir, file).startsWith('..');

describe('tsconfig.json (typecheck config)', () => {
  const parsed = effectiveConfig('tsconfig.json');

  it('parses with no configuration errors', () => {
    expect(parsed.errors).toEqual([]);
  });

  it('never emits', () => {
    expect(parsed.options.noEmit).toBe(true);
  });

  it('covers src/', () => {
    const src = path.join(ROOT, 'src');
    expect(parsed.fileNames.some((f) => under(src, f))).toBe(true);
  });

  it('covers tests/, so a type error in a test fails typecheck', () => {
    const tests = path.join(ROOT, 'tests');
    expect(parsed.fileNames.some((f) => under(tests, f))).toBe(true);
  });

  it('excludes tests/fixtures, which is sample code for the lanes to execute', () => {
    const fixtures = path.join(ROOT, 'tests', 'fixtures');
    expect(parsed.fileNames.filter((f) => under(fixtures, f))).toEqual([]);
  });
});

describe('tsconfig.build.json (emitting config)', () => {
  const parsed = effectiveConfig('tsconfig.build.json');

  it('parses with no configuration errors', () => {
    expect(parsed.errors).toEqual([]);
  });

  it('extends the typecheck config so both agree on language settings', () => {
    const raw = ts.readConfigFile(path.join(ROOT, 'tsconfig.build.json'), ts.sys.readFile)
      .config as { extends?: string };
    expect(raw.extends).toBe('./tsconfig.json');
  });

  it('emits from rootDir src into outDir dist', () => {
    expect(parsed.options.noEmit).toBe(false);
    expect(parsed.options.rootDir).toBe(path.join(ROOT, 'src'));
    expect(parsed.options.outDir).toBe(path.join(ROOT, 'dist'));
  });

  it('emits declarations, so package.json "types" resolves', () => {
    expect(parsed.options.declaration).toBe(true);
  });

  it('compiles only src/, never tests/', () => {
    const src = path.join(ROOT, 'src');
    const tests = path.join(ROOT, 'tests');
    expect(parsed.fileNames.length).toBeGreaterThan(0);
    expect(parsed.fileNames.every((f) => under(src, f))).toBe(true);
    expect(parsed.fileNames.some((f) => under(tests, f))).toBe(false);
  });

  it('compiles no *.test.ts, including any colocated under src/', () => {
    expect(parsed.fileNames.filter((f) => f.endsWith('.test.ts'))).toEqual([]);
  });
});

describe('why the split is required', () => {
  it('tests/ lives outside the build rootDir, so one config cannot serve both', () => {
    // This is the TS6059 condition: with rootDir=src, any tests/ file in the
    // program is "not under rootDir" and tsc refuses to emit at all.
    const rootDir = effectiveConfig('tsconfig.build.json').options.rootDir!;
    expect(path.relative(rootDir, path.join(ROOT, 'tests')).startsWith('..')).toBe(true);
  });

  it('every published path is dist/<path under src>, never dist/src/<...>', () => {
    // Relaxing rootDir to "." to fit tests/ into one config would emit
    // dist/src/**, invalidating each of these. Guard the published surface.
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      exports?: Record<string, string>;
      types?: string;
    };
    const published = [
      ...Object.values(pkg.bin ?? {}),
      ...Object.values(pkg.exports ?? {}),
      ...(pkg.types ? [pkg.types] : []),
    ].filter((p) => p.includes('dist'));

    expect(published.length).toBeGreaterThan(0);
    for (const p of published) {
      expect(p, `${p} must be under dist/`).toMatch(/^\.?\/?dist\//);
      expect(p, `${p} leaks the rootDir into the published path`).not.toMatch(/dist\/src\//);
    }
  });
});
