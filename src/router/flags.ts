/**
 * offstage: reading one argv token.
 *
 * Whole tokens only. `--headed`, `--headless=false`, `-headed`, and the value
 * that follows a separated flag are all handled here; substring matching is
 * deliberately not, because `--no-headless` and `--headed-mode` mean different
 * things and a `includes('headed')` router would get both wrong.
 *
 * Everything in this file is pure and takes no I/O.
 */

/* -------------------------------------------------------------------------- */
/* Flag vocabulary                                                            */
/* -------------------------------------------------------------------------- */

export interface ParsedFlag {
  name: string;
  value?: string;
}

/**
 * Strip shell punctuation a tokenizer leaves stuck to a flag.
 *
 * `$(echo --headed)` splits into `$(echo` and `--headed)`, and `--headed)` is
 * not `--headed` to an exact-match lookup, so the one token that decides the
 * lane slips past every rule. The trailing characters here are shell syntax,
 * never part of a flag name.
 */
function unpunctuate(token: string): string {
  return token.replace(/[)`'";,]+$/, '').replace(/^[('`"]+/, '');
}

export function parseFlag(token: string): ParsedFlag {
  const cleaned = unpunctuate(token);
  const eq = cleaned.indexOf('=');
  if (eq === -1) return { name: cleaned };
  return { name: cleaned.slice(0, eq), value: cleaned.slice(eq + 1) };
}

const FALSEY = new Set(['false', '0', 'no', 'off', 'none']);
const TRUTHY = new Set(['true', '1', 'yes', 'on']);

export function isTrueish(value: string | undefined): boolean {
  return value === undefined || TRUTHY.has(value.toLowerCase());
}

export function isFalseish(value: string | undefined): boolean {
  return value !== undefined && FALSEY.has(value.toLowerCase());
}

/** Flags that ask for a visible browser window. */
export function isHeadedFlag(flag: ParsedFlag): boolean {
  if (flag.name === '--headed') return isTrueish(flag.value);
  if (flag.name === '--no-headless') return true;
  if (flag.name === '--headless' || flag.name === '--browser.headless') return isFalseish(flag.value);
  return false;
}

/** Flags that explicitly ask for no window. */
export function isHeadlessFlag(flag: ParsedFlag): boolean {
  if (flag.name === '--headless' || flag.name === '--browser.headless') return !isFalseish(flag.value);
  if (flag.name === '--headed') return isFalseish(flag.value);
  return false;
}

const GPU_FLAG_PATTERNS = [
  /^--use-gl$/,
  /^--use-angle$/,
  /^--use-vulkan$/,
  /^--enable-webgl.*$/,
  /^--enable-gpu(-rasterization|-compositing|-blocked-features)?$/,
  /^--ignore-gpu-block(list|admin)$/,
  /^--ignore-gpu-blacklist$/,
  /^--enable-unsafe-webgpu$/,
  /^--enable-accelerated-2d-canvas$/,
];

export function isGpuFlag(flag: ParsedFlag): boolean {
  if (flag.name === '--enable-features') {
    return /vulkan|webgpu|gpu/i.test(flag.value ?? '');
  }
  return GPU_FLAG_PATTERNS.some((pattern) => pattern.test(flag.name)) && !isFalseish(flag.value);
}

export function isNoGpuFlag(flag: ParsedFlag): boolean {
  return (
    flag.name === '--disable-gpu' ||
    flag.name === '--disable-gpu-compositing' ||
    flag.name === '--disable-software-rasterizer'
  );
}

export function isExtensionFlag(flag: ParsedFlag): boolean {
  return flag.name === '--load-extension' || flag.name === '--disable-extensions-except';
}

/**
 * Switches that capture *the screen* (a desktop, another application's window,
 * or another tab) through `getDisplayMedia` and `chrome.desktopCapture`. Those
 * APIs enumerate surfaces the window system is drawing; a browser with no
 * display attached has none to offer, so the picker comes back empty and the
 * capture fails or silently records nothing. This is the class of work that
 * genuinely needs a head.
 */
const SCREEN_CAPTURE_FLAG_NAMES = new Set([
  '--auto-select-desktop-capture-source',
  '--auto-select-tab-capture-source-by-title',
  '--auto-accept-this-tab-capture',
  '--enable-usermedia-screen-capturing',
  '--allow-http-screen-capture',
]);

/**
 * Flags that ask the *runner* to record the page it is already driving:
 * Playwright's `video`, and the `--record-video` spelling used by harnesses
 * built on top of it.
 *
 * These do **not** need a display, and that is not a guess. Playwright records
 * by asking the browser for its own frames, `Page.startScreencast` over CDP,
 * and muxing the `screencastFrame` stream with the ffmpeg it ships in the box.
 * The renderer produces those frames whether or not anything is presenting
 * them, so a headless run writes the same `.webm` a headed one would. Sending
 * these to the container lane would buy nothing and charge container startup
 * for it, which is exactly the trade offstage exists to refuse.
 *
 * `--video=off` (and the other falsey spellings) is not a recording request at
 * all, so it produces no signal.
 */
const RECORDED_VIDEO_FLAG_NAMES = new Set(['--video', '--record-video']);

export function isScreenCaptureFlag(flag: ParsedFlag): boolean {
  if (!SCREEN_CAPTURE_FLAG_NAMES.has(flag.name)) return false;
  return !isFalseish(flag.value);
}

export function isRecordedVideoFlag(flag: ParsedFlag): boolean {
  if (!RECORDED_VIDEO_FLAG_NAMES.has(flag.name)) return false;
  return !isFalseish(flag.value);
}

/** Read `--config x`, `--config=x` or `-c x` out of an argument list. */
export function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    const flag = parseFlag(token);
    if (!names.includes(flag.name)) continue;
    if (flag.value !== undefined) return flag.value;
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('-')) return next;
  }
  return undefined;
}

/** First argument that is not a flag and not a flag's value: the subcommand. */
export function subcommandOf(args: string[]): string | undefined {
  const first = args[0];
  if (first === undefined || first.startsWith('-')) return undefined;
  return first;
}