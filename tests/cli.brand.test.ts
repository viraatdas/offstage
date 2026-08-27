/**
 * The welcome screen: color-mode detection, gradient rendering, and the box
 * layout. Pure rendering is asserted directly; the CLI wiring (`offstage
 * welcome`, and bare `offstage`) is driven in-process through `main()` with
 * captured streams, the same way cli.program.test.ts drives the command tree.
 */

import { describe, expect, it } from 'vitest';

import { main } from '../src/cli/index.js';
import type { CliIo } from '../src/cli/index.js';
import { offstageVersion } from '../src/cli/api.js';
import {
  WORDMARK,
  detectColorMode,
  gradientLines,
  renderWelcome,
} from '../src/cli/brand.js';

describe('detectColorMode', () => {
  it('NO_COLOR wins over everything, even on a color terminal', () => {
    expect(detectColorMode({ NO_COLOR: '1', COLORTERM: 'truecolor' }, true)).toBe('none');
  });

  it('an empty NO_COLOR is unset, per the spec', () => {
    expect(detectColorMode({ NO_COLOR: '', COLORTERM: 'truecolor' }, true)).toBe('truecolor');
  });

  it('CI implies logs, not screens', () => {
    expect(detectColorMode({ CI: '1', COLORTERM: 'truecolor' }, true)).toBe('none');
  });

  it('a pipe gets plain text no matter what the terminal declared', () => {
    expect(detectColorMode({ COLORTERM: 'truecolor' }, false)).toBe('none');
  });

  it('COLORTERM truecolor/24bit selects truecolor', () => {
    expect(detectColorMode({ COLORTERM: 'truecolor' }, true)).toBe('truecolor');
    expect(detectColorMode({ COLORTERM: '24bit' }, true)).toBe('truecolor');
  });

  it('a 256-color TERM is quantized, not treated as truecolor', () => {
    expect(detectColorMode({ TERM: 'xterm-256color' }, true)).toBe('ansi256');
  });

  it('a terminal that declares nothing gets no color', () => {
    expect(detectColorMode({ TERM: 'xterm' }, true)).toBe('none');
    expect(detectColorMode({}, true)).toBe('none');
  });
});

describe('gradientLines', () => {
  const art = ['██ █', ' ███'];

  it('passes the art through untouched when color is off', () => {
    expect(gradientLines(art, 'none')).toEqual(art);
  });

  it('wraps every block in a truecolor escape and leaves spaces bare', () => {
    const [top] = gradientLines(art, 'truecolor');
    expect(top).toContain('\x1b[38;2;');
    // 3 blocks on the top row, so 3 color resets.
    expect(top.match(/\x1b\[0m/g)).toHaveLength(3);
    expect(top).toContain(' ');
  });

  it('quantizes to palette codes within the xterm cube and grayscale', () => {
    const [top] = gradientLines(art, 'ansi256');
    const codes = [...top.matchAll(/\x1b\[38;5;(\d+)m/g)].map((m) => Number(m[1]));
    expect(codes).toHaveLength(3);
    for (const code of codes) {
      expect(code).toBeGreaterThanOrEqual(16);
      expect(code).toBeLessThanOrEqual(255);
    }
  });

  it('colors the top-left darker than the bottom-right along the ramp', () => {
    const lines = gradientLines(WORDMARK, 'truecolor');
    const first = lines[0].match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    const last = lines[WORDMARK.length - 1].match(/.*\x1b\[38;2;(\d+);(\d+);(\d+)m/);
    expect(first).not.toBeNull();
    expect(last).not.toBeNull();
    // The ramp runs violet -> fuchsia -> amber: the red channel rises along it.
    expect(Number(last![1])).toBeGreaterThan(Number(first![1]));
  });
});

describe('renderWelcome', () => {
  const info = { version: '0.3.12', platform: 'darwin', arch: 'arm64' };

  it('shows the wordmark, the pitch, the version and the first commands', () => {
    const lines = renderWelcome(info, 'none', 80);
    const text = lines.join('\n');
    expect(text).toContain('████');
    expect(text).toContain('keep your screen yours');
    expect(text).toContain('v0.3.12 · darwin · arm64');
    expect(text).toContain('offstage doctor');
    expect(text).toContain('offstage --help');
  });

  it('boxes the content when the terminal is wide enough, and every row lines up', () => {
    const lines = renderWelcome(info, 'none', 80);
    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines[lines.length - 1]).toMatch(/^╰─+╯$/);
    const inner = lines.slice(1, -1);
    for (const line of inner) expect(line).toMatch(/^│.*│$/);
    expect(inner.every((line) => line.length === inner[0].length)).toBe(true);
  });

  it('drops the box instead of wrapping art when the terminal is narrow', () => {
    const lines = renderWelcome(info, 'none', 40);
    expect(lines.join('\n')).toContain('████');
    expect(lines.join('')).not.toContain('│');
  });

  it('keeps the box aligned when the wordmark carries ANSI color', () => {
    const lines = renderWelcome(info, 'truecolor', 80);
    const inner = lines.slice(1, -1);
    for (const line of inner) expect(line).toMatch(/^│.*│$/);
    // Visible width: strip the escapes, then the box borders must still agree.
    // eslint-disable-next-line no-control-regex
    const visible = inner.map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').length);
    expect(visible.every((w) => w === visible[0])).toBe(true);
  });
});

describe('the welcome command wiring', () => {
  // The harness env is empty and outTty is absent, so the welcome screen
  // renders with no color and a default width: deterministic for assertions.
  async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const io: CliIo = {
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      cwd: () => process.cwd(),
      env: {},
    };
    const code = await main(argv, io);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('offstage welcome prints the screen and exits 0', async () => {
    const result = await cli(['welcome']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('keep your screen yours');
    expect(result.out).toContain(`v${offstageVersion()}`);
    expect(result.out).not.toContain('\x1b[');
  });

  it('bare offstage shows the welcome screen, not the subcommand wall', async () => {
    const result = await cli([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain('keep your screen yours');
    expect(result.out).not.toContain('Usage:');
  });
});
