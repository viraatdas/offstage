/**
 * offstage: what is actually about to run.
 *
 * One command can be several commands. `npm test` is a package script that is
 * itself a command line; `sh -c "npx playwright test --headed"` hides one
 * inside a string. A {@link CommandView} is one thing worth inspecting, and
 * `buildViews` expands a command into every view it can reach by *reading*:
 * package scripts are followed, never executed.
 *
 * `argv[0]` is resolved on disk here too, through `PATH`, a symlink, a rename
 * or a byte-for-byte copy, because the refusal rules key on which program a
 * command names and a filename is the easiest thing in the world to change.
 */

import type { Inspector } from './inspect.js';
import type { Invocation } from './tokenize.js';
import { basenameOf, normalizeInvocation, parseScriptInvocation, tokenizeShellish } from './tokenize.js';

/* -------------------------------------------------------------------------- */
/* Command views                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One command the router is reasoning about.
 *
 * `offstage run npm test` produces two views: the argv itself, and the command
 * `package.json` says `test` expands to. Both are inspected, because the flags
 * that matter are just as likely to live in a script as on the command line.
 */
export interface CommandView {
  invocation: Invocation;
  /** Human label used as the signal origin: `argv`, `package.json scripts.e2e`. */
  label: string;
  /** How many script expansions deep this view is. */
  depth: number;
  /**
   * False when this view is only a wrapper whose script was resolved: `npm` in
   * `npm test` should not be reported as "a plain test runner"; its script is.
   */
  binIsMeaningful: boolean;
  /**
   * Basename of what `invocation.binPath` resolves to on disk, when it named a
   * path (`./tool`, `/tmp/x/tool`, `../bin/tool`). A symlink or a rename does
   * not change what a binary does, so a signal keyed on a name (`installer`,
   * `hdiutil`) has to see this too, not just the literal token that was typed.
   * `undefined` for a bare name, a target that does not exist, or anything
   * else `Inspector.resolveBinary` could not resolve.
   */
  resolvedBin?: string;
  /**
   * SHA-256 of the same target, when it could be hashed. A *copied* system
   * tool has no filesystem link back to its origin, so name resolution sees
   * nothing, but identical bytes do identical things, and this digest is what
   * {@link KNOWN_MACHINE_TOOLS} is matched against.
   */
  resolvedDigest?: string;
  /**
   * A machine-changing tool this argv[0] was matched to **by content**: the
   * bytes are identical to a known system binary even though every name for it
   * is innocuous. Set only when neither the typed name nor the resolved
   * basename already gave the game away.
   */
  contentMatchedBin?: string;
}

/** How far `npm run a` → `npm run b` → … is followed before giving up. */
const MAX_SCRIPT_DEPTH = 3;

/**
 * System binaries whose bytes mean "this changes the machine", wherever a copy
 * of them is found. Name resolution catches symlinks and renames; this table
 * catches `cp /usr/sbin/installer ./nice-name`, which leaves no link back to
 * the original and an innocent basename: only the content is honest. The
 * paths are hashed through the same read-only inspector as everything else,
 * at most once per classify() call, and hashing is skipped entirely unless
 * argv[0] was path-shaped in the first place.
 */
const KNOWN_MACHINE_TOOLS: Readonly<Record<string, string>> = {
  installer: '/usr/sbin/installer',
  hdiutil: '/usr/bin/hdiutil',
};

/**
 * Match one view's resolved binary against {@link KNOWN_MACHINE_TOOLS} by
 * content, when its names alone did not already identify it.
 */
async function matchKnownTool(view: CommandView, inspector: Inspector): Promise<void> {
  if (view.resolvedBin !== undefined && view.resolvedBin in KNOWN_MACHINE_TOOLS) return;
  if (view.invocation.bin in KNOWN_MACHINE_TOOLS) return;

  /* Size first, bytes second. Every argv[0] now resolves, including bare names
     found on PATH, so without this gate the router would read and hash the
     binary behind every command it ever classifies. Identical content has
     identical length, so a size mismatch is a complete answer and costs one
     stat. */
  const candidateSize = await inspector.binarySize(view.invocation.binPath);
  if (candidateSize === undefined) return;

  for (const [tool, absolute] of Object.entries(KNOWN_MACHINE_TOOLS)) {
    const knownSize = await inspector.binarySize(absolute);
    if (knownSize === undefined || knownSize !== candidateSize) continue;
    const known = await inspector.binaryDigest(absolute);
    if (known === undefined) continue;
    const digest = await inspector.binaryDigest(view.invocation.binPath);
    if (digest !== undefined && digest === known) {
      view.resolvedDigest = digest;
      view.contentMatchedBin = tool;
      return;
    }
  }
}

/**
 * Expand a command into every view worth inspecting, following package scripts
 * (but never running them).
 */
export async function buildViews(command: string[], inspector: Inspector): Promise<CommandView[]> {
  const views: CommandView[] = [];
  const seenScripts = new Set<string>();

  const walk = async (tokens: string[], label: string, depth: number): Promise<void> => {
    const invocation = normalizeInvocation(tokens);
    if (invocation.bin === '') return;

    const view: CommandView = { invocation, label, depth, binIsMeaningful: true };
    /* argv[0] is resolved on disk so a symlink or a rename cannot hide a
       machine-changing binary behind an innocuous name. Bare names are resolved
       through PATH as well, because that is what actually gets executed: a
       symlink to the installer sitting on PATH under a friendly name was
       otherwise invisible to every check at once. */
    const resolvedTarget = await inspector.resolveBinary(invocation.binPath);
    if (resolvedTarget !== undefined) {
      view.resolvedBin = basenameOf(resolvedTarget);
      /* And its bytes are compared, so a *copy* (no symlink, no shared
         basename, nothing but identical content) is recognized too. */
      await matchKnownTool(view, inspector);
    }
    views.push(view);

    if (depth >= MAX_SCRIPT_DEPTH) return;

    // `sh -c 'npx playwright test --headed'` hides the whole command inside one
    // argv token. Reading only the outer tokens sees a shell and no browser,
    // which is exactly backwards: the flag that decides the lane is in there.
    // Tokenizing the string is reading, not executing: the same thing the
    // router does to a package script.
    const shellScript = shellDashC(invocation);
    if (shellScript !== null) {
      view.binIsMeaningful = false;
      for (const segment of tokenizeShellish(shellScript)) {
        await walk(segment, `${invocation.bin} -c`, depth + 1);
      }
      return;
    }

    const script = parseScriptInvocation(invocation);
    if (script === null) return;

    const pkg = await inspector.packageJson();
    const body = pkg?.scripts[script.script];
    if (pkg === undefined || body === undefined || seenScripts.has(script.script)) return;
    seenScripts.add(script.script);

    // The package manager is now just a launcher; its script is the real command.
    view.binIsMeaningful = false;

    // npm runs `pre<name>` before and `post<name>` after, and they are part of
    // what `npm run <name>` does. A repository that keeps `playwright test
    // --headed` in `pree2e` opens a window from a command whose own script
    // body is innocent.
    for (const affix of ['pre', 'post'] as const) {
      const hook = `${affix}${script.script}`;
      const hookBody = pkg.scripts[hook];
      if (hookBody === undefined || seenScripts.has(hook)) continue;
      seenScripts.add(hook);
      for (const segment of tokenizeShellish(hookBody)) {
        await walk(segment, `package.json scripts.${hook}`, depth + 1);
      }
    }

    const segments = tokenizeShellish(body);
    // Sequential on purpose: a script that runs `npm run other` has to share the
    // visited-set with its parent, or a cycle would expand forever.
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string[];
      const isLast = index === segments.length - 1;
      const tail = isLast ? [...segment, ...script.extraArgs] : segment;
      await walk(tail, `package.json scripts.${script.script}`, depth + 1);
    }
  };

  await walk(command, 'argv', 0);
  return views;
}

/** Shells whose `-c` argument is a command string worth reading. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/**
 * The command string behind `sh -c '<string>'`, or `null` when this is not a
 * shell invocation. Combined short flags (`sh -lc '<string>'`) count.
 */
export function shellDashC(invocation: Invocation): string | null {
  if (!SHELLS.has(invocation.bin)) return null;
  for (let index = 0; index < invocation.args.length; index += 1) {
    const token = invocation.args[index] as string;
    if (!token.startsWith('-') || token.startsWith('--')) continue;
    if (!token.includes('c')) continue;

    // `sh -c -- '<script>'` and `sh -c - '<script>'` are both real: POSIX lets
    // `--` or a bare `-` sit between the flag and the command string. Taking
    // args[index + 1] blindly hands back "--" as the script, which tokenizes
    // to nothing and hides the command completely.
    for (let next = index + 1; next < invocation.args.length; next += 1) {
      const candidate = invocation.args[next] as string;
      if (candidate === '--' || candidate === '-') continue;
      return candidate.trim() === '' ? null : candidate;
    }
    return null;
  }
  return null;
}
