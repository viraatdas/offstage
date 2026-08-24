/**
 * Guards the rule that lets a helper module live in `tests/` without being
 * mistaken for a suite.
 *
 * `tests/` holds two kinds of TypeScript file:
 *
 *   *.test.ts       a suite. vitest collects it and runs it.
 *   *.fixtures.ts   shared setup the suites import. vitest never collects it;
 *   *.helpers.ts    `tsc` still typechecks it.
 *
 * The second kind exists because n1's four router suites all need the same
 * throwaway repositories on disk (playwright configs, a puppeteer script, an
 * .xcodeproj), and building them four times is worse than building them once in
 * `tests/router.fixtures.ts`. n1 flagged that file as a literal deviation from
 * its "create only tests/router.*.test.ts" brief. This suite is the
 * ratification, and the part that keeps the ratification honest.
 *
 * All of it rests on `vitest.config.ts` including exactly `tests/**\/*.test.ts`,
 * which is load-bearing in both directions:
 *
 *   Widen it to `tests/**\/*.ts` and every helper becomes a failing suite. A
 *   fixture builder declares no tests, so vitest reports "No test suite found
 *   in file tests/router.fixtures.ts" and the run goes red.
 *
 *   Narrow it, or add a `tests/*` entry to `exclude`, and a real suite stops
 *   being collected. `vitest run` stays green while its coverage quietly leaves
 *   the build: the worse of the two failures, because nothing complains.
 *
 * So the collection check below is a set equality, not a subset check, and it
 * asks vitest itself rather than reimplementing its glob semantics: the same
 * reason tests/tsconfig-include.test.ts asks the TypeScript compiler.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createVitest } from 'vitest/node';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsDir = path.join(repoRoot, 'tests');

/**
 * Extensions TypeScript treats as source. `.mts`/`.cts`/`.tsx` are swept so an
 * unsanctioned one is reported rather than skipped: neither vitest's include
 * nor tsconfig's `tests/**\/*.ts` matches them, so such a file would be
 * invisible to the runner and the typechecker at the same time.
 */
const TS_EXTENSIONS = ['.ts', '.mts', '.cts', '.tsx'];

const SUITE_SUFFIX = '.test.ts';
/** A helper names its lane the way the suites do: `router.fixtures.ts`, not `fixtures.ts`. */
const HELPER_SUFFIXES = ['.fixtures.ts', '.helpers.ts'];

type Kind = 'suite' | 'helper' | 'unsanctioned';

/** Each suffix check demands something before it, so a file called `.test.ts` or `.fixtures.ts` is not a lane. */
function classifyTestsFile(filePath: string): Kind {
  const base = path.basename(filePath);
  const longerThan = (suffix: string) => base.length > suffix.length && base.endsWith(suffix);

  if (longerThan(SUITE_SUFFIX)) return 'suite';
  if (HELPER_SUFFIXES.some(longerThan)) return 'helper';
  return 'unsanctioned';
}

/**
 * Every TypeScript file under `tests/`, minus `tests/fixtures/**`. That tree is
 * sample code for the lanes to execute (Playwright specs, Xcode projects) and
 * is deliberately outside both vitest collection and the tsconfig program.
 */
function walkTestsDir(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (absolute === path.join(testsDir, 'fixtures')) continue;
      found.push(...walkTestsDir(absolute));
    } else if (TS_EXTENSIONS.includes(path.extname(entry.name))) {
      found.push(path.relative(repoRoot, absolute));
    }
  }
  return found.sort();
}

const testsFiles = walkTestsDir(testsDir);
const suites = testsFiles.filter((file) => classifyTestsFile(file) === 'suite');
const helpers = testsFiles.filter((file) => classifyTestsFile(file) === 'helper');

/**
 * The repo-relative files one file imports. `preProcessFile` is the compiler's
 * own specifier scanner, so static, type-only, re-export and dynamic imports
 * all come back through it. NodeNext makes the suites write
 * `./router.fixtures.js` for a file on disk named `router.fixtures.ts`, hence
 * the extension rewrite.
 */
function localImportsOf(file: string): string[] {
  const absolute = path.join(repoRoot, file);
  const source = fs.readFileSync(absolute, 'utf8');
  const fromDir = path.dirname(absolute);
  const resolved: string[] = [];

  for (const reference of ts.preProcessFile(source, true, true).importedFiles) {
    if (!reference.fileName.startsWith('.')) continue;
    const target = path.resolve(fromDir, reference.fileName);
    const candidates = [
      target.replace(/\.js$/, '.ts'),
      target.replace(/\.mjs$/, '.mts'),
      target.replace(/\.cjs$/, '.cts'),
      target,
      `${target}.ts`,
    ];
    const hit = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (hit) resolved.push(path.relative(repoRoot, hit));
  }

  return resolved;
}

/** Files the suites reach through imports, transitively: a helper only another orphan imports is still dead. */
function reachableFromSuites(): Set<string> {
  const seen = new Set<string>();
  const queue = [...suites];

  while (queue.length > 0) {
    for (const dependency of localImportsOf(queue.shift()!)) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      queue.push(dependency);
    }
  }

  return seen;
}

/** What vitest would actually run, resolved by vitest against the real config. */
async function collectedByVitest(): Promise<string[]> {
  const vitest = await createVitest('test', { watch: false, run: true, root: repoRoot });
  try {
    const specifications = await vitest.globTestSpecifications();
    const files = specifications.map((specification) => path.relative(repoRoot, specification.moduleId));
    return [...new Set(files)].sort();
  } finally {
    await vitest.close();
  }
}

describe('the tests/ naming convention', () => {
  it('reads a suite, a fixture builder and a helpers module', () => {
    expect(classifyTestsFile('tests/router.classify.test.ts')).toBe('suite');
    expect(classifyTestsFile('tests/router.fixtures.ts')).toBe('helper');
    expect(classifyTestsFile('tests/lanes.container.helpers.ts')).toBe('helper');
  });

  it('rejects a name that does not say which of the two it is', () => {
    // `tests/util.ts` is what the rule exists to stop. It is not collected, but
    // nothing about the name says so, and the next author has no way to tell
    // whether the tests inside it run.
    expect(classifyTestsFile('tests/util.ts')).toBe('unsanctioned');
    // Suffix without a lane in front: which lane's fixtures?
    expect(classifyTestsFile('tests/fixtures.ts')).toBe('unsanctioned');
    expect(classifyTestsFile('tests/helpers.ts')).toBe('unsanctioned');
    // Right name, wrong extension: `tests/**\/*.ts` matches neither `.mts` nor
    // `.cts`, so this one would slip past vitest and tsc together.
    expect(classifyTestsFile('tests/router.fixtures.mts')).toBe('unsanctioned');
  });
});

describe('the tests/ directory obeys it', () => {
  it('names every TypeScript file as a suite or a lane-prefixed helper', () => {
    const unsanctioned = testsFiles.filter((file) => classifyTestsFile(file) === 'unsanctioned');
    // Rename it: `<lane>.<what>.test.ts` if it declares tests, or
    // `<lane>.fixtures.ts` / `<lane>.helpers.ts` if the suites import it.
    expect(unsanctioned).toEqual([]);
  });

  it('hands vitest exactly the suites, and every one of them', async () => {
    // Extra entries mean a helper is about to fail with "No test suite found".
    // Missing ones mean a suite left the build without turning anything red.
    expect(await collectedByVitest()).toEqual(suites);
  });

  it('imports every helper from a suite', () => {
    const reachable = reachableFromSuites();
    const orphans = helpers.filter((helper) => !reachable.has(helper));
    // An unimported helper is dead code that still typechecks, and should it
    // ever grow a describe() block, those tests would run nowhere at all.
    expect(orphans).toEqual([]);
  });
});
