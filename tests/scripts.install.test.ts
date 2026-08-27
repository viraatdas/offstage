/**
 * scripts/install.sh: the script curl pipes straight into sh. It is the first
 * thing a new user runs, so it gets the same syntax gate as every other shell
 * script the project ships, plus the two properties its header promises.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

describe('scripts/install.sh', () => {
  const file = path.resolve('scripts/install.sh');

  it('survives /bin/sh -n: a syntax error here is a piped no-op for every new user', async () => {
    // A syntax error exits non-zero and prints where it broke.
    await run('/bin/sh', ['-n', file]);
  });

  it('never invokes sudo itself; setup does, behind its own prompt', async () => {
    const script = await readFile(file, 'utf8');
    expect(script).not.toMatch(/^\s*sudo\b/m);
  });

  it('hands the last word to the welcome screen, with a plain fallback', async () => {
    const script = await readFile(file, 'utf8');
    expect(script).toContain('"$OFFSTAGE_BIN" welcome');
    expect(script).toContain('offstage is installed. Try:');
  });
});
