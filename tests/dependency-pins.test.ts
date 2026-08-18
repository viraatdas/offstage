import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

/**
 * offstage declares `engines.node: ">=20"`, and two of its runtime deps have
 * already shipped a major that drops Node 20:
 *
 *   commander@15 -> engines.node ">=22.12.0"
 *   execa@10     -> engines.node ">=22"
 *
 * npm does not fail an install on an unsatisfied `engines` field by default, so
 * taking `latest` on either one would leave the package installable but broken
 * for the Node floor we advertise. These pins are the guard; this file is what
 * keeps them from quietly drifting back.
 */
const PINS = [
  { name: 'commander', major: 14, firstNode22Major: 15 },
  { name: 'execa', major: 9, firstNode22Major: 10 },
] as const;

const NODE_FLOOR_MAJOR = 20;

interface Manifest {
  engines?: { node?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface Lockfile {
  packages?: Record<string, { version?: string; engines?: { node?: string } }>;
}

const read = <T,>(relative: string): T =>
  JSON.parse(fs.readFileSync(new URL(relative, import.meta.url), 'utf8')) as T;

const manifest = read<Manifest>('../package.json');
const lockfile = read<Lockfile>('../package-lock.json');

const locked = (name: string) => {
  const entry = lockfile.packages?.[`node_modules/${name}`];
  expect(entry, `${name} is missing from package-lock.json`).toBeDefined();
  return entry!;
};

/**
 * Smallest Node major an `engines.node` range can accept. Deliberately narrow:
 * it understands the `>=x`, `^x` and `x || y` shapes npm packages actually use
 * and throws on anything else, so an unrecognised range fails the test loudly
 * instead of silently passing.
 */
const minNodeMajor = (range: string): number => {
  const majors = range.split('||').map((clause) => {
    const match = clause.trim().match(/^(?:\^|>=|>)?\s*(\d+)(?:\.\d+)*$/);
    if (!match) throw new Error(`unrecognised engines.node clause: "${clause.trim()}"`);
    return Number(match[1]);
  });
  return Math.min(...majors);
};

describe('runtime dependency pins', () => {
  it.each(PINS)('pins $name to ^$major rather than latest', ({ name, major }) => {
    const range = manifest.dependencies?.[name];

    expect(range, `${name} should be a runtime dependency`).toBeDefined();
    // `^14.x` and never `latest`/`*`/`>=14`, all of which would float onto the
    // next major the moment it is published.
    expect(range).toMatch(new RegExp(`^\\^${major}\\.\\d+\\.\\d+$`));
  });

  it.each(PINS)('resolves $name to major $major in the lockfile', ({ name, major }) => {
    expect(locked(name).version).toMatch(new RegExp(`^${major}\\.`));
  });

  // Deliberately asserts "does not need Node 22", not "runs on every 20.x":
  // execa@9 declares `^18.19.0 || >=20.5.0`, so Node 20.0-20.4 satisfies the
  // floor this package advertises but not execa's own. Raising `engines.node`
  // to ">=20.5.0" would close that seam; it is package.json's owner to make.
  it.each(PINS)('keeps the locked $name off a Node 22 floor', ({ name }) => {
    const engines = locked(name).engines?.node;

    expect(engines, `${name} should declare engines.node`).toBeDefined();
    expect(minNodeMajor(engines!)).toBeLessThanOrEqual(NODE_FLOOR_MAJOR);
  });

  it.each(PINS)('stays below $name@$firstNode22Major, which requires Node 22', ({ name, firstNode22Major }) => {
    expect(Number(locked(name).version!.split('.')[0])).toBeLessThan(firstNode22Major);
  });

  it('advertises a Node floor of 20', () => {
    expect(minNodeMajor(manifest.engines?.node ?? '')).toBe(NODE_FLOOR_MAJOR);
  });

  it('takes no dependency on a floating tag', () => {
    const all = { ...manifest.dependencies, ...manifest.devDependencies };
    const floating = Object.entries(all).filter(([, range]) =>
      ['latest', 'next', '*', ''].includes(range.trim()),
    );

    expect(floating).toEqual([]);
  });
});
