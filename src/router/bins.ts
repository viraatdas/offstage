/**
 * offstage: the binaries the router recognizes, by name.
 *
 * These are lookup tables and nothing else, so every module that reasons about
 * a tool agrees on what that tool is called. Kept in one leaf module on
 * purpose: a second copy of "which names mean Playwright" is how a router
 * starts disagreeing with itself.
 */

/* -------------------------------------------------------------------------- */
/* Tool families                                                              */
/* -------------------------------------------------------------------------- */

export const PLAYWRIGHT_BINS = new Set(['playwright', 'playwright-core', 'pwt']);
export const VITEST_BINS = new Set(['vitest']);
export const CYPRESS_BINS = new Set(['cypress']);
export const PUPPETEER_BINS = new Set(['puppeteer']);

/** Browser executables invoked directly. These open a window unless told not to. */
export const BROWSER_BINS = new Set([
  'chrome',
  'google-chrome',
  'google-chrome-stable',
  'google-chrome-beta',
  'chromium',
  'chromium-browser',
  'msedge',
  'microsoft-edge',
  'firefox',
  'brave',
  'brave-browser',
]);

/**
 * WebDriver endpoints that open nothing by themselves. A driver server launches
 * a browser only when a client asks it for a session, and whether that browser
 * is headless lives in the client's capabilities, which are not on this command
 * line and not in any file this repository is guaranteed to have.
 */
export const WEBDRIVER_SERVER_BINS = new Set([
  'chromedriver',
  'geckodriver',
  'msedgedriver',
  'selenium-standalone',
  'selenium-side-runner',
]);

/** Tools that never touch a display, so there is nothing to isolate. */
export const NON_DISPLAY_BINS = new Set([
  'ava',
  'bazel',
  'biome',
  'c8',
  'cargo',
  'cmake',
  'composer',
  'ctest',
  'deno',
  'dotnet',
  'eslint',
  'go',
  'gradle',
  'gradlew',
  'jasmine',
  'jest',
  'just',
  'make',
  'mocha',
  'mvn',
  'node',
  'nyc',
  'phpunit',
  'prettier',
  'pytest',
  'python',
  'python3',
  'rake',
  'rspec',
  'ruby',
  'rustc',
  'swift',
  'tap',
  'tape',
  'task',
  'ts-node',
  'tsc',
  'tsx',
  'uvu',
  'vite-node',
  'bun',
  'npm',
  'pnpm',
  'yarn',
]);

/** macOS-only binaries that mean "this work has to happen on a Mac". */
export const MACOS_GUI_BINS = new Set(['osascript', 'instruments', 'simctl', 'hdiutil']);

/** Extensions worth opening when a command names a local file. */
export const SCRIPT_REFERENCE = /\.(c|m)?[jt]sx?$/;

/** Library mentions that make a `headless:` key in a file about a browser. */
export const BROWSER_LIBRARY = /puppeteer|playwright|chromium|webdriver|selenium|@browserbasehq|chrome-launcher/i;
