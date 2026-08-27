/**
 * The offstage wordmark, the gradient that colors it, and the welcome screen.
 *
 * Every other renderer in this package prints plain text on purpose: its
 * audience is an agent or a pipe, and ANSI codes would be noise. The welcome
 * screen is the one moment a human is the audience, so it is also the one
 * place the CLI allows itself color. Everything here is a pure function of
 * its arguments (color mode and terminal width are detected by the caller and
 * injected), which keeps the rendering testable without a real terminal.
 *
 * The wordmark is embedded as art rather than generated from a font because
 * it is a fixed asset: generating it at runtime would mean shipping a font
 * table that exists only to reproduce five static lines.
 */

/** How much color the output terminal can take. */
export type ColorMode = 'truecolor' | 'ansi256' | 'none';

/**
 * Decide how much color to use, following the conventions tools already
 * respect: `NO_COLOR` wins over everything, `CI` implies logs not screens,
 * and a pipe gets plain text no matter how colorful the source terminal was.
 */
export function detectColorMode(env: NodeJS.ProcessEnv, isTty: boolean): ColorMode {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none';
  if (env.CI !== undefined && env.CI !== '') return 'none';
  if (!isTty) return 'none';
  const colorterm = typeof env.COLORTERM === 'string' ? env.COLORTERM : '';
  if (colorterm.includes('truecolor') || colorterm.includes('24bit')) return 'truecolor';
  const term = typeof env.TERM === 'string' ? env.TERM : '';
  if (term.includes('256color')) return 'ansi256';
  return 'none';
}

/** The brand ramp: violet, fuchsia, amber, a spotlight sweeping a stage. */
const RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [0x7c, 0x3a, 0xed],
  [0xd9, 0x46, 0xef],
  [0xf5, 0x9e, 0x0b],
];

/** The color at `t` in [0, 1] along the ramp. */
function rampColor(t: number): [number, number, number] {
  const clamped = Math.min(Math.max(t, 0), 1);
  const scaled = clamped * (RAMP.length - 1);
  const index = Math.min(Math.floor(scaled), RAMP.length - 2);
  const from = RAMP[index];
  const to = RAMP[index + 1];
  const f = scaled - index;
  return [
    Math.round(from[0] + (to[0] - from[0]) * f),
    Math.round(from[1] + (to[1] - from[1]) * f),
    Math.round(from[2] + (to[2] - from[2]) * f),
  ];
}

/**
 * The nearest xterm-256 palette entry. The 256-color terminal cannot mix the
 * ramp exactly, so the wordmark gets quantized; the cube approximation is the
 * same one ansi-styles and tmux use, which keeps the result look familiar.
 */
function toAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const level = (v: number): number => (v < 48 ? 0 : v < 115 ? 1 : Math.round((v - 55) / 40));
  return 16 + 36 * level(r) + 6 * level(g) + level(b);
}

/**
 * Color line art with a diagonal gradient, bottom-left to top-right, the way
 * a spotlight would sweep it. Spaces stay plain so the art keeps its shape
 * when copied out of a terminal.
 */
export function gradientLines(lines: readonly string[], mode: ColorMode): string[] {
  if (mode === 'none') return [...lines];
  const height = lines.length;
  const width = Math.max(...lines.map((line) => line.length));
  return lines.map((line, y) => {
    let out = '';
    for (let x = 0; x < line.length; x += 1) {
      const char = line[x];
      if (char === ' ') {
        out += char;
        continue;
      }
      const t = (x / width + (height - 1 - y) / height) / 2;
      const [r, g, b] = rampColor(t);
      if (mode === 'truecolor') {
        out += `\x1b[38;2;${r};${g};${b}m${char}\x1b[0m`;
      } else {
        out += `\x1b[38;5;${toAnsi256(r, g, b)}m${char}\x1b[0m`;
      }
    }
    return out;
  });
}

/** The offstage wordmark, five rows of block art, 66 columns wide. */
export const WORDMARK: readonly string[] = [
  ' ████   ██████  ██████   █████  ███████   █████    █████  ███████',
  '██  ██  ██      ██      ██         ██    ██   ██  ██      ██',
  '██  ██  ████    ████     ████      ██    ███████  ██ ███  █████',
  '██  ██  ██      ██          ██     ██    ██   ██  ██  ██  ██',
  ' ████   ██      ██      █████      ██    ██   ██   █████   ███████',
];

/** What the welcome screen knows about the copy that is running. */
export interface WelcomeInfo {
  version: string;
  platform: string;
  arch: string;
}

/** A row of the "where to start" block: the thing to type, and what it does. */
const NEXT_STEPS: ReadonlyArray<readonly [string, string]> = [
  ['offstage doctor', 'which lanes work on this machine'],
  ['offstage route -- <command>', 'where it would go; nothing runs'],
  ['offstage run -- <command>', 'send it there'],
  ['offstage --help', 'everything else'],
];

const INTERIOR = 70;

/** Strip ANSI SGR sequences, for measuring what a terminal will actually show. */
function visibleLength(line: string): number {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*m/g, '').length;
}

/**
 * The welcome screen: wordmark, one-line pitch, the three lanes, and the
 * first commands to try. Boxed when the terminal is wide enough for the
 * wordmark, unboxed when it is not, rather than wrapping art mid-glyph.
 */
export function renderWelcome(info: WelcomeInfo, mode: ColorMode, width: number): string[] {
  const boxed = width >= INTERIOR + 2;
  const pad = (content: string): string => {
    const fill = Math.max(INTERIOR - visibleLength(content), 0);
    return `│${content}${' '.repeat(fill)}│`;
  };
  const rule = boxed ? [`╭${'─'.repeat(INTERIOR)}╮`, `╰${'─'.repeat(INTERIOR)}╯`] : ['', ''];

  const lines: string[] = [];
  if (boxed) lines.push(rule[0]);
  const open = boxed ? (content: string) => lines.push(pad(content)) : (content: string) => lines.push(content);

  open('');
  for (const line of gradientLines(WORDMARK, mode)) open(`  ${line}`);
  open('');
  open('  keep your screen yours');
  open(`  v${info.version} · ${info.platform} · ${info.arch}`);
  open('');
  open('  three lanes, one refusal:');
  open('  headless   runs in place, because it opens no window');
  open('  container  a Linux box with a virtual display');
  open('  session    a second macOS account, logged in in the background');
  open('');
  open('  where to start:');
  for (const [command, what] of NEXT_STEPS) open(`    ${command.padEnd(31)} ${what}`);
  open('');
  if (boxed) lines.push(rule[1]);
  return lines;
}
