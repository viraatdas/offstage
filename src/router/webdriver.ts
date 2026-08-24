/**
 * offstage: WebDriver, which has to be read rather than guessed.
 *
 * `wdio` has no headless default. Whether a window opens is written in the
 * capabilities, as a browser switch inside a nested blob rather than as a flag
 * the argv parser can see. So this module opens the config the command names
 * and looks for what actually settles it: a `--headless` switch in the
 * capabilities, a `headless` key, or a hosted grid that runs the browser on
 * someone else's machine.
 *
 * When there is nothing to read it falls back to the container lane and says so
 * at low confidence, because being wrong toward more isolation is the cheap
 * direction to be wrong in.
 */

import { configSignals, readHeadlessEvidence } from './configs.js';
import { flagValue, isHeadlessFlag, parseFlag } from './flags.js';
import type { Inspector } from './inspect.js';
import type { Signal } from './signal.js';
import { signal } from './signal.js';
import type { CommandView } from './views.js';

/* -------------------------------- WebDriver ------------------------------- */

/**
 * A `--headless` switch, wherever it is written.
 *
 * WebDriver spells headlessness as a browser switch inside a capability blob
 * (`'goog:chromeOptions': { args: ['--headless=new'] }` in a config, or
 * `-c "goog:chromeOptions.args=[--headless]"` on a command line) so the flag
 * parser, which only looks at whole tokens, cannot see it. `--no-headless` and
 * `--headless=false` are deliberately not matches.
 */
const HEADLESS_SWITCH = /(^|[^\w-])--?headless\b(?!\s*[:=]\s*(?:false|0|no|off))/i;

/** The same switch quoted inside a config, which is where it is worth quoting back. */
const QUOTED_HEADLESS_SWITCH = /['"`](--?headless(?:=[\w-]+)?)['"`]/i;

/** `hostname: 'hub.browserstack.com'`: the machine the browser actually runs on. */
const CAPABILITY_HOSTNAME = /\bhostname\s*:\s*['"`]([^'"`]+)['"`]/i;

/** Hostnames that mean "this machine after all", so nothing has moved off it. */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

/**
 * A wdio service that hands the session to a hosted grid: `services: ['sauce']`,
 * `services: ['@wdio/browserstack-service']`. The browser then runs on their
 * hardware, so nothing opens here whatever the capabilities say.
 */
const CLOUD_GRID_SERVICE =
  /services\s*:\s*\[[^\]]*['"`](?:@wdio\/)?(?:sauce|browserstack|lambdatest|testingbot)[\w-]*['"`]/i;

/** `wdio.conf.ts`, `wdio.conf.local.js`, `config/wdio.shared.conf.mts`. */
const WEBDRIVER_CONFIG_REFERENCE = /(?:^|\/)[\w.-]*wdio[\w.-]*\.(?:c|m)?[jt]s$/i;

function hasHeadlessSwitch(text: string): boolean {
  return HEADLESS_SWITCH.test(text);
}

/** The config `wdio run <path>` or `--config <path>` names, if it names one. */
function webdriverConfigPath(args: string[]): string | undefined {
  const explicit = flagValue(args, ['--config', '-c']);
  if (explicit !== undefined) return explicit;
  return args.find((token) => !token.startsWith('-') && WEBDRIVER_CONFIG_REFERENCE.test(token));
}

/**
 * Headlessness settled by the command line itself, including a switch buried in
 * a capability string. `[]` means "argv settled it and `flagSignals` already
 * reported the flag"; `undefined` means argv says nothing either way.
 */
export function commandLineHeadless(view: CommandView): Signal[] | undefined {
  const { bin, args } = view.invocation;
  const at = (text: string): string => `${view.label}: ${text}`;

  if (args.some((token) => token.startsWith('-') && isHeadlessFlag(parseFlag(token)))) return [];

  const embedded = args.find((token) => hasHeadlessSwitch(token));
  if (embedded === undefined) return undefined;

  return [
    signal({
      kind: 'headless-flag',
      argues: 'headless',
      origin: view.label,
      detail: at(embedded),
      clause: `The capabilities on this command line launch the browser headless (${embedded}), so ${bin} opens no window and there is nothing for a container to protect.`,
      priority: 38,
      inferred: false,
      confidence: 'high',
    }),
  ];
}

/** What a WebDriver config says about where and how the browser is launched. */
interface CapabilityEvidence {
  signals: Signal[];
  /** True when the browser runs on a grid that is not this machine at all. */
  remote: boolean;
}

function webdriverCapabilities(file: string, text: string): CapabilityEvidence {
  const signals: Signal[] = [];

  const host = text.match(CAPABILITY_HOSTNAME);
  const remoteHost =
    host !== null && !LOCAL_HOSTNAMES.has((host[1] as string).toLowerCase()) ? (host[1] as string) : undefined;
  const remote = remoteHost !== undefined || CLOUD_GRID_SERVICE.test(text);

  if (remote) {
    signals.push(
      signal({
        kind: 'config-headless',
        argues: 'headless',
        origin: file,
        detail: `${file}: browser runs on ${remoteHost ?? 'a hosted grid'}`,
        clause: `${file} points the WebDriver session at ${
          remoteHost ?? 'a hosted grid'
        }, so the browser opens on that machine and never on yours; offstage just runs the client here.`,
        priority: 36,
        inferred: true,
        confidence: 'high',
      }),
    );
    return { signals, remote };
  }

  const quoted = text.match(QUOTED_HEADLESS_SWITCH);
  // `headless: false` next to a `--headless` arg is a contradiction the config
  // owner has to settle; offstage reports the headed reading, because a window
  // on your real screen is the worse way to be wrong. `conditional` counts as a
  // literal false: it is the shape a file takes when it spells out both.
  const spelledHeadless = readHeadlessEvidence(text).shape;
  const spelledFalse = spelledHeadless === 'literal-false' || spelledHeadless === 'conditional';
  if (quoted !== null && !spelledFalse) {
    const switchText = quoted[1] as string;
    signals.push(
      signal({
        kind: 'config-headless',
        argues: 'headless',
        origin: file,
        detail: `${file}: capabilities pass ${switchText}`,
        clause: `${file} launches the browser with ${switchText}, so the WebDriver session opens no window and running it in place is already safe.`,
        priority: 37,
        inferred: true,
        confidence: 'high',
      }),
    );
  }

  return { signals, remote };
}

/**
 * The honest answer when nothing settles it: container, and say why.
 *
 * A WebDriver tool with no readable capabilities is the one case offstage
 * cannot reason its way out of, so it picks the lane where being wrong is
 * harmless and reports low confidence rather than a confident guess.
 */
export function driverGuess(view: CommandView, bin: string, shape: 'runner' | 'server'): Signal {
  const what =
    shape === 'server'
      ? `${bin} opens no window itself, but it launches a real browser as soon as a client asks it for a session, and the capabilities that decide whether that browser is headless are not here`
      : `${bin} drives a real browser through WebDriver, which has no headless default, and no config this router can read says otherwise`;

  return signal({
    kind: 'headed-driver',
    argues: 'container',
    origin: view.label,
    detail: `${view.label}: ${bin} (no headless capability found)`,
    clause: `${what}; offstage routes it to the container lane, where a window is harmless, and reports low confidence because it is a default rather than an observation. Pass --headless, or put the headless switch in the capabilities, and it runs in place.`,
    priority: 32,
    inferred: false,
    confidence: 'low',
  });
}

/**
 * WebdriverIO: read the capabilities instead of guessing from the tool name.
 *
 * `wdio` is the one browser runner whose headedness is written neither in its
 * argv nor in a default, but in the config it is pointed at. So the router
 * opens that file (the one the command names, or the usual one at the root)
 * and looks for the thing that actually settles it: a `--headless` switch in
 * the browser options, a `headless` key, or a grid that puts the browser on
 * someone else's machine entirely.
 */
export async function webdriverSignals(view: CommandView, inspector: Inspector): Promise<Signal[]> {
  const found: Signal[] = [];
  const at = (text: string): string => `${view.label}: ${text}`;

  // An explicit headless request on the command line settles the lane, but the
  // config is still worth reading: a `headless: false` in it is real evidence,
  // and reporting it as overridden explains more than hiding it would.
  const settledByArgv = commandLineHeadless(view);
  if (settledByArgv !== undefined) found.push(...settledByArgv);

  const configPath = webdriverConfigPath(view.invocation.args);
  const config = await inspector.webdriverConfig(configPath);

  if (config === undefined && configPath !== undefined) {
    found.push(
      signal({
        kind: 'unreadable-config',
        argues: null,
        origin: view.label,
        detail: at(`${configPath} could not be read`),
        clause: 'The named WebdriverIO config could not be read.',
        priority: 80,
        inferred: true,
        confidence: 'low',
      }),
    );
  }

  if (config !== undefined) {
    const capabilities = webdriverCapabilities(config.file, config.text);
    // A remote grid moves the browser off this machine, which makes the local
    // launch options in the same file irrelevant to your screen.
    /* wdio has no headless default, so a value offstage could not read must not
       fall back to one. See configSignals' `defaultsHeadless`. */
    if (!capabilities.remote) found.push(...configSignals(config.file, config.text, false));
    found.push(...capabilities.signals);
  }

  const decided = settledByArgv !== undefined || found.some((item) => item.argues !== null);
  if (!decided) found.push(driverGuess(view, 'wdio', 'runner'));
  return found;
}
