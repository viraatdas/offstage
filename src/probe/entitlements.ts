/**
 * offstage: entitlements collection.
 *
 * Given something the user actually has on disk (an `.xcodeproj`, an
 * `.xcworkspace`, a bare `.entitlements` file, a built `.app`, or a `.dmg`)
 * this module collects the entitlements that product effectively requests, then
 * hands them to {@link classifyEntitlements} for the verdict that decides
 * whether ad-hoc signing is enough to build and test it (`adhoc-ok`) or a real
 * Developer ID identity has to be wired in first (`needs-signing-lane`).
 *
 * ## Evidence, ranked
 *
 * Different targets yield evidence of different strength, and the report says
 * which it used rather than flattening them together:
 *
 * | Target             | Evidence                                                        | Strength |
 * | ------------------ | --------------------------------------------------------------- | -------- |
 * | `.entitlements`    | the file itself                                                   | exact    |
 * | `.xcodeproj`       | `CODE_SIGN_ENTITLEMENTS` in `project.pbxproj` → the named file(s)  | exact    |
 * | `.xcworkspace`     | every `.xcodeproj` it references, recursively                      | exact    |
 * | `.app`             | `codesign -d --entitlements :-` on the bundle                      | exact    |
 * | `.app` (no codesign) | `Contents/embedded.provisionprofile` → its `Entitlements` dict    | indicative |
 * | `.dmg`             | mount read-only, then every `.app` inside                          | as above |
 *
 * Anything weaker than "we read the signature or the declared entitlements
 * file" comes back as `confidence: 'low'` with a note saying why. A probe that
 * found nothing reports `adhoc-ok` at low confidence, which means "no evidence
 * of a blocker", not "proven fine".
 *
 * ## External tools
 *
 * `codesign` and `hdiutil` are macOS-only. Every call to them is guarded: on a
 * non-Darwin host, or when the tool is missing or fails, the probe records a
 * note and keeps going with whatever file-based evidence it has. The probe
 * never requires Xcode, and its tests run with no Xcode project present.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { XMLParser } from 'fast-xml-parser';
import plist from 'plist';
import { z } from 'zod';
import type { EntitlementTrigger, Verdict } from './verdict.js';
import { EntitlementTriggerSchema, VerdictSchema, classifyEntitlements } from './verdict.js';

/* -------------------------------------------------------------------------- */
/* Target kinds                                                               */
/* -------------------------------------------------------------------------- */

export const PROBE_TARGET_KINDS = [
  'xcodeproj',
  'xcworkspace',
  'entitlements',
  'app',
  'dmg',
  'provisioning-profile',
] as const;

export type ProbeTargetKind = (typeof PROBE_TARGET_KINDS)[number];

export const ProbeTargetKindSchema = z.enum(PROBE_TARGET_KINDS);

/** Where one dictionary of entitlements came from. */
export const SOURCE_ORIGINS = ['entitlements-file', 'codesign', 'provisioning-profile'] as const;

export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

export interface EntitlementsSource {
  /** Absolute host path of the file (or bundle) the entitlements were read from. */
  path: string;
  origin: SourceOrigin;
  /**
   * `declared` (the project, the signature, or the user named this file.
   * `scanned`) offstage found it by looking around, so it may belong to a
   * target you never build. Scanned-only evidence caps confidence at `low`.
   */
  discovery: 'declared' | 'scanned';
  /** Free-text provenance, e.g. "mounted from /path/App.dmg". */
  note?: string;
  entitlements: Record<string, unknown>;
}

export const EntitlementsSourceSchema: z.ZodType<EntitlementsSource> = z.object({
  path: z.string().min(1),
  origin: z.enum(SOURCE_ORIGINS),
  discovery: z.enum(['declared', 'scanned']),
  note: z.string().optional(),
  entitlements: z.record(z.string(), z.unknown()),
});

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The answer. `verdict` is the decision; everything else exists so a human can
 * check the decision instead of trusting it.
 */
export interface EntitlementsProbeReport {
  /** Absolute path actually inspected (a directory argument resolves to the project inside it). */
  target: string;
  targetKind: ProbeTargetKind;
  verdict: Verdict;
  /**
   * `high`: offstage read declared entitlements or a real code signature.
   * `low`: the verdict rests on weaker evidence (nothing found, only files
   * discovered by scanning, or a built product inspected without `codesign`).
   * A `low` `adhoc-ok` means "found no blocker", not "proved there is none".
   */
  confidence: 'high' | 'low';
  triggers: EntitlementTrigger[];
  adhocSatisfied: string[];
  teamScoped: string[];
  inert: string[];
  unclassified: string[];
  /** The merged effective entitlements, for the reader who wants the raw values. */
  entitlements: Record<string, unknown>;
  sources: EntitlementsSource[];
  /** Everything offstage could not do, and every assumption it made. */
  notes: string[];
  summary: string;
}

export const EntitlementsProbeReportSchema: z.ZodType<EntitlementsProbeReport> = z.object({
  target: z.string().min(1),
  targetKind: ProbeTargetKindSchema,
  verdict: VerdictSchema,
  confidence: z.enum(['high', 'low']),
  triggers: z.array(EntitlementTriggerSchema),
  adhocSatisfied: z.array(z.string()),
  teamScoped: z.array(z.string()),
  inert: z.array(z.string()),
  unclassified: z.array(z.string()),
  entitlements: z.record(z.string(), z.unknown()),
  sources: z.array(EntitlementsSourceSchema),
  notes: z.array(z.string()),
  summary: z.string().min(1),
});

/** Thrown only for "offstage cannot even start": a missing or unsupported target. */
export class ProbeError extends Error {
  readonly code: 'not-found' | 'unsupported-target';
  constructor(code: 'not-found' | 'unsupported-target', message: string) {
    super(message);
    this.name = 'ProbeError';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Command running (injectable, so tests never need Xcode)                    */
/* -------------------------------------------------------------------------- */

export interface CommandResult {
  /** `null` when the process never produced one (spawn failure, signal, timeout). */
  exitCode: number | null;
  stdout: Buffer;
  stderr: string;
}

export type CommandRunner = (file: string, args: readonly string[]) => Promise<CommandResult>;

export interface ProbeOptions {
  /**
   * Injected process runner. Defaults to an `execa`-backed runner that never
   * throws: a missing binary comes back as `exitCode: null` with the spawn
   * error in `stderr`.
   */
  runCommand?: CommandRunner;
  /**
   * Set `false` to keep the probe purely file-based, no `codesign`, no
   * `hdiutil`. Defaults to `true`, but external tools are attempted only on
   * Darwin unless a `runCommand` is injected.
   */
  allowExternalTools?: boolean;
  /** How deep to look for `*.entitlements` when a project declares none. Default 4. */
  maxScanDepth?: number;
  /** Timeout for `codesign` / `hdiutil`, in ms. Default 120_000. */
  toolTimeoutMs?: number;
}

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.alloc(0);
}

function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  return toBuffer(value).toString('utf8');
}

function defaultRunner(timeoutMs: number): CommandRunner {
  return async (file, args) => {
    try {
      const result = await execa(file, [...args], {
        encoding: 'buffer',
        reject: false,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      const record = result as unknown as { exitCode?: number | null; stdout?: unknown; stderr?: unknown };
      return {
        exitCode: typeof record.exitCode === 'number' ? record.exitCode : null,
        stdout: toBuffer(record.stdout),
        stderr: toText(record.stderr),
      };
    } catch (error) {
      // execa still throws for a few pre-spawn failures even with reject:false.
      return { exitCode: null, stdout: Buffer.alloc(0), stderr: describeError(error) };
    }
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/* -------------------------------------------------------------------------- */
/* Pure parsers (exported: they are the parts worth unit-testing directly)     */
/* -------------------------------------------------------------------------- */

/**
 * Parse an XML or OpenStep plist into a dictionary.
 *
 * Returns `null` rather than throwing when the payload is not a plist dict, so
 * one malformed file never fails the whole probe.
 */
export function parseEntitlementsPlist(input: string | Buffer): Record<string, unknown> | null {
  const text = typeof input === 'string' ? input : input.toString('utf8');
  if (text.trim().length === 0) return null;
  // Cheap shape check before handing it to the XML parser. `plist` writes its
  // own fatalError to stderr on malformed input, and a probe that prints parser
  // noise while telling you your app is fine is a probe nobody trusts.
  if (!text.includes('<plist') && !text.includes('<dict')) return null;
  let parsed: unknown;
  try {
    parsed = plist.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Pull the one XML plist out of a container that wraps it in binary noise.
 *
 * Two callers need this and both are load-bearing:
 * - `codesign -d --entitlements :-` on older macOS prefixes the XML with an
 *   8-byte `0xfade7171` blob header, so a naive parse fails.
 * - a `.provisionprofile` / `.mobileprovision` is CMS-signed DER with the plist
 *   embedded in the middle.
 */
export function extractEmbeddedPlist(buffer: Buffer): string | null {
  const start = buffer.indexOf('<?xml');
  const declStart = start >= 0 ? start : buffer.indexOf('<plist');
  if (declStart < 0) return null;
  const closing = '</plist>';
  const end = buffer.lastIndexOf(closing);
  if (end < declStart) return null;
  return buffer.subarray(declStart, end + closing.length).toString('utf8');
}

/**
 * Parse `codesign -d --entitlements :-` output, with or without the leading
 * blob header. Returns `null` when the binary is unsigned or carries no
 * entitlements, which is a legitimate answer, not an error.
 */
export function parseCodesignEntitlements(stdout: Buffer): Record<string, unknown> | null {
  if (stdout.length === 0) return null;
  const xml = extractEmbeddedPlist(stdout);
  if (!xml) return null;
  return parseEntitlementsPlist(xml);
}

/**
 * Parse a `.provisionprofile` / `.mobileprovision` and return its `Entitlements`
 * dictionary: the set of capabilities Apple allowlisted for that App ID.
 */
export function parseProvisioningProfile(buffer: Buffer): Record<string, unknown> | null {
  const xml = extractEmbeddedPlist(buffer);
  if (!xml) return null;
  const profile = parseEntitlementsPlist(xml);
  if (!profile) return null;
  const entitlements = profile['Entitlements'];
  if (!entitlements || typeof entitlements !== 'object' || Array.isArray(entitlements)) return null;
  return entitlements as Record<string, unknown>;
}

/**
 * Extract every `CODE_SIGN_ENTITLEMENTS` build setting from a `project.pbxproj`
 * and resolve it against the project's source root.
 *
 * A real pbxproj parser is not worth it here: the setting is a flat
 * `KEY = value;` line in every Xcode-generated project, and the alternative,
 * shelling out to `xcodebuild -showBuildSettings`, needs Xcode installed and a
 * scheme, which is exactly what this probe must work without.
 *
 * Settings that interpolate variables offstage cannot resolve (`$(TARGET_NAME)`)
 * come back in `unresolved` so the caller can say so out loud.
 */
export function entitlementsPathsFromPbxproj(
  pbxproj: string,
  srcRoot: string,
): { resolved: string[]; unresolved: string[] } {
  const pattern = /CODE_SIGN_ENTITLEMENTS\s*=\s*(?:"([^"]*)"|([^;\n]+))\s*;/g;
  const resolved = new Set<string>();
  const unresolved = new Set<string>();
  for (const match of pbxproj.matchAll(pattern)) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (raw.length === 0) continue;
    const substituted = raw
      .replaceAll('$(SRCROOT)', srcRoot)
      .replaceAll('${SRCROOT}', srcRoot)
      .replaceAll('$(PROJECT_DIR)', srcRoot)
      .replaceAll('${PROJECT_DIR}', srcRoot);
    if (substituted.includes('$(') || substituted.includes('${')) {
      unresolved.add(raw);
      continue;
    }
    resolved.add(path.resolve(srcRoot, substituted));
  }
  return { resolved: [...resolved].sort(), unresolved: [...unresolved].sort() };
}

/**
 * Resolve the `.xcodeproj` paths an `.xcworkspace` references.
 *
 * Locations look like `group:App/App.xcodeproj` or `container:App.xcodeproj`,
 * are relative to the directory holding the `.xcworkspace`, and may be nested
 * inside `<Group>` elements: hence the recursive walk.
 */
export function projectPathsFromWorkspaceData(contents: string, workspaceDir: string): string[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  let tree: unknown;
  try {
    tree = parser.parse(contents);
  } catch {
    return [];
  }
  const locations: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const location = record['@_location'];
    if (typeof location === 'string') locations.push(location);
    for (const [key, value] of Object.entries(record)) {
      if (key.startsWith('@_')) continue;
      walk(value);
    }
  };
  walk(tree);

  const projects = new Set<string>();
  for (const location of locations) {
    const separator = location.indexOf(':');
    const scheme = separator < 0 ? '' : location.slice(0, separator);
    const value = separator < 0 ? location : location.slice(separator + 1);
    if (value.length === 0) continue; // `self:`: the workspace itself.
    if (scheme === 'developer') continue;
    const resolved = scheme === 'absolute' ? value : path.resolve(workspaceDir, value);
    if (resolved.endsWith('.xcodeproj')) projects.add(resolved);
  }
  return [...projects].sort();
}

/* -------------------------------------------------------------------------- */
/* Filesystem helpers                                                         */
/* -------------------------------------------------------------------------- */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.jj',
  '.build',
  '.offstage',
  'build',
  'dist',
  'Pods',
  'Carthage',
  '.swiftpm',
]);

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Find files whose name matches `predicate`, breadth-limited and noise-skipping. */
async function findFiles(
  root: string,
  predicate: (name: string) => boolean,
  maxDepth: number,
  depth = 0,
): Promise<string[]> {
  if (depth > maxDepth) return [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('DerivedData')) continue;
      // Never descend into bundles while scanning a source tree.
      if (entry.name.endsWith('.xcodeproj') || entry.name.endsWith('.xcworkspace') || entry.name.endsWith('.app')) continue;
      found.push(...(await findFiles(full, predicate, maxDepth, depth + 1)));
    } else if (entry.isFile() && predicate(entry.name)) {
      found.push(full);
    }
  }
  return found.sort();
}

/* -------------------------------------------------------------------------- */
/* Collection                                                                 */
/* -------------------------------------------------------------------------- */

interface Collector {
  sources: EntitlementsSource[];
  notes: string[];
  usedCodesign: boolean;
}

async function addEntitlementsFile(
  collector: Collector,
  file: string,
  discovery: 'declared' | 'scanned',
  note?: string,
): Promise<void> {
  let raw: Buffer;
  try {
    raw = await fs.readFile(file);
  } catch (error) {
    collector.notes.push(`Could not read entitlements file ${file}: ${describeError(error)}`);
    return;
  }
  const entitlements = parseEntitlementsPlist(raw);
  if (!entitlements) {
    collector.notes.push(`${file} is not a readable plist dictionary; ignored.`);
    return;
  }
  collector.sources.push({ path: file, origin: 'entitlements-file', discovery, ...(note ? { note } : {}), entitlements });
}

async function collectFromXcodeProject(
  collector: Collector,
  projectPath: string,
  options: Required<Pick<ProbeOptions, 'maxScanDepth'>>,
): Promise<void> {
  const srcRoot = path.dirname(projectPath);
  const pbxprojPath = path.join(projectPath, 'project.pbxproj');
  let pbxproj: string | null = null;
  try {
    pbxproj = await fs.readFile(pbxprojPath, 'utf8');
  } catch (error) {
    collector.notes.push(`Could not read ${pbxprojPath}: ${describeError(error)}`);
  }

  let declaredAny = false;
  if (pbxproj) {
    const { resolved, unresolved } = entitlementsPathsFromPbxproj(pbxproj, srcRoot);
    for (const unresolvedValue of unresolved) {
      collector.notes.push(
        `${path.basename(projectPath)} sets CODE_SIGN_ENTITLEMENTS = ${unresolvedValue}, which interpolates a build variable offstage cannot resolve without Xcode. That target was not inspected.`,
      );
    }
    for (const file of resolved) {
      if (!(await pathExists(file))) {
        collector.notes.push(`${path.basename(projectPath)} declares CODE_SIGN_ENTITLEMENTS ${file}, but that file does not exist.`);
        continue;
      }
      declaredAny = true;
      await addEntitlementsFile(collector, file, 'declared', `declared by ${path.basename(projectPath)}`);
    }
  }

  if (declaredAny) return;

  const scanned = await findFiles(srcRoot, (name) => name.endsWith('.entitlements'), options.maxScanDepth);
  if (scanned.length === 0) {
    collector.notes.push(
      `No CODE_SIGN_ENTITLEMENTS build setting and no *.entitlements file under ${srcRoot}. Either this project requests no entitlements, or they live in an .xcconfig offstage did not read.`,
    );
    return;
  }
  collector.notes.push(
    `${path.basename(projectPath)} declares no CODE_SIGN_ENTITLEMENTS; falling back to ${scanned.length} *.entitlements file(s) found by scanning ${srcRoot}. These may belong to targets you never build: confidence is capped at low.`,
  );
  for (const file of scanned) {
    await addEntitlementsFile(collector, file, 'scanned', `found by scanning ${srcRoot}`);
  }
}

async function collectFromWorkspace(
  collector: Collector,
  workspacePath: string,
  options: Required<Pick<ProbeOptions, 'maxScanDepth'>>,
): Promise<void> {
  const dataPath = path.join(workspacePath, 'contents.xcworkspacedata');
  let contents: string;
  try {
    contents = await fs.readFile(dataPath, 'utf8');
  } catch (error) {
    collector.notes.push(`Could not read ${dataPath}: ${describeError(error)}`);
    return;
  }
  const projects = projectPathsFromWorkspaceData(contents, path.dirname(workspacePath));
  if (projects.length === 0) {
    collector.notes.push(`${path.basename(workspacePath)} references no .xcodeproj that offstage could resolve.`);
    return;
  }
  for (const project of projects) {
    if (!(await pathExists(project))) {
      collector.notes.push(`${path.basename(workspacePath)} references ${project}, which does not exist.`);
      continue;
    }
    await collectFromXcodeProject(collector, project, options);
  }
}

async function collectFromAppBundle(
  collector: Collector,
  appPath: string,
  runCommand: CommandRunner | null,
  note?: string,
): Promise<void> {
  // Counted per bundle, not globally: a .dmg holding two apps must still be
  // able to say "this one had nothing" after the other one yielded evidence.
  const sourcesBefore = collector.sources.length;

  if (runCommand) {
    const entitlements = await readCodesignEntitlements(collector, appPath, runCommand);
    if (entitlements) {
      collector.usedCodesign = true;
      collector.sources.push({
        path: appPath,
        origin: 'codesign',
        discovery: 'declared',
        ...(note ? { note } : {}),
        entitlements,
      });
    }
  } else {
    collector.notes.push(
      `codesign was not run for ${path.basename(appPath)} (external tools disabled or host is not macOS), so the binary's actual signed entitlements were not read.`,
    );
  }

  for (const relative of ['Contents/embedded.provisionprofile', 'embedded.mobileprovision']) {
    const profilePath = path.join(appPath, relative);
    if (!(await pathExists(profilePath))) continue;
    let raw: Buffer;
    try {
      raw = await fs.readFile(profilePath);
    } catch (error) {
      collector.notes.push(`Could not read ${profilePath}: ${describeError(error)}`);
      continue;
    }
    const entitlements = parseProvisioningProfile(raw);
    if (!entitlements) {
      collector.notes.push(`${profilePath} exists but no Entitlements dictionary could be extracted from it.`);
      continue;
    }
    collector.notes.push(
      `${path.basename(appPath)} embeds a provisioning profile. Its Entitlements dictionary is the App ID's allowlist, which can be broader than what the binary actually requests, but a product that ships one was built against a real Team ID.`,
    );
    collector.sources.push({
      path: profilePath,
      origin: 'provisioning-profile',
      discovery: 'declared',
      ...(note ? { note } : {}),
      entitlements,
    });
  }

  if (collector.sources.length === sourcesBefore) {
    collector.notes.push(
      `No entitlements evidence found in ${path.basename(appPath)}: no readable signature and no embedded provisioning profile.`,
    );
  }
}

async function readCodesignEntitlements(
  collector: Collector,
  bundlePath: string,
  runCommand: CommandRunner,
): Promise<Record<string, unknown> | null> {
  // `--xml` exists on macOS 11+ and yields a bare plist; without it, older
  // codesign wraps the plist in a blob header. Try the modern form, fall back.
  for (const args of [
    ['-d', '--entitlements', ':-', '--xml', bundlePath],
    ['-d', '--entitlements', ':-', bundlePath],
  ]) {
    const result = await runCommand('codesign', args);
    if (result.exitCode === 0) {
      const entitlements = parseCodesignEntitlements(result.stdout);
      if (entitlements) return entitlements;
      collector.notes.push(
        `codesign reported no entitlements for ${path.basename(bundlePath)}. A signed binary with no entitlements needs no signing lane.`,
      );
      return null;
    }
  }
  collector.notes.push(
    `codesign could not read entitlements from ${path.basename(bundlePath)} (unsigned, ad-hoc with no entitlements, or codesign unavailable). Falling back to file-based evidence.`,
  );
  return null;
}

/* -------------------------------------------------------------------------- */
/* Disk images                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Attach a `.dmg` read-only, run `body` against the mount point, and **always**
 * detach: including when `body` throws.
 *
 * A leaked mount is not a cosmetic problem: it pins the image file, shows up in
 * Finder, and survives the process that created it. Hence `-nobrowse`,
 * `-readonly`, a private mount root, and an unconditional `finally`. Exported
 * because that guarantee is worth testing directly.
 */
export async function withMountedDiskImage<T>(
  dmgPath: string,
  runCommand: CommandRunner,
  body: (mountPoint: string) => Promise<T>,
): Promise<T> {
  const mountRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-dmg-'));
  let mountPoint: string | null = null;
  try {
    const attach = await runCommand('hdiutil', [
      'attach',
      dmgPath,
      '-nobrowse',
      '-readonly',
      '-noverify',
      '-plist',
      '-mountrandom',
      mountRoot,
    ]);
    if (attach.exitCode !== 0) {
      throw new Error(`hdiutil attach failed for ${dmgPath}: ${attach.stderr.trim() || `exit ${String(attach.exitCode)}`}`);
    }
    mountPoint = mountPointFromHdiutilPlist(attach.stdout);
    if (!mountPoint) {
      throw new Error(`hdiutil attach reported no mount point for ${dmgPath}.`);
    }
    return await body(mountPoint);
  } finally {
    if (mountPoint) {
      const detach = await runCommand('hdiutil', ['detach', mountPoint, '-force']);
      if (detach.exitCode !== 0) {
        // Surfaced rather than thrown: the probe's answer is still valid, and
        // masking the caller's real error with a cleanup failure helps nobody.
        process.emitWarning(
          `offstage could not detach ${mountPoint}: ${detach.stderr.trim() || `exit ${String(detach.exitCode)}`}`,
        );
      }
    }
    await fs.rm(mountRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/** Pull the first mount point out of `hdiutil attach -plist` output. */
export function mountPointFromHdiutilPlist(stdout: Buffer): string | null {
  const xml = extractEmbeddedPlist(stdout) ?? stdout.toString('utf8');
  const parsed = parseEntitlementsPlist(xml);
  const entities = parsed?.['system-entities'];
  if (!Array.isArray(entities)) return null;
  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') continue;
    const mountPoint = (entity as Record<string, unknown>)['mount-point'];
    if (typeof mountPoint === 'string' && mountPoint.length > 0) return mountPoint;
  }
  return null;
}

async function collectFromDiskImage(
  collector: Collector,
  dmgPath: string,
  runCommand: CommandRunner | null,
): Promise<void> {
  if (!runCommand) {
    collector.notes.push(
      `${path.basename(dmgPath)} was not mounted: hdiutil is macOS-only and external tools are disabled here. No entitlements could be read from the image.`,
    );
    return;
  }
  try {
    await withMountedDiskImage(dmgPath, runCommand, async (mountPoint) => {
      const apps = await findAppBundles(mountPoint);
      if (apps.length === 0) {
        collector.notes.push(`${path.basename(dmgPath)} mounted, but contains no .app bundle.`);
        return;
      }
      for (const app of apps) {
        await collectFromAppBundle(collector, app, runCommand, `mounted from ${dmgPath}`);
      }
    });
  } catch (error) {
    collector.notes.push(`Could not inspect ${dmgPath}: ${describeError(error)}`);
  }
}

/** `.app` bundles at the top of a mounted image, or one level down. */
async function findAppBundles(root: string, depth = 0): Promise<string[]> {
  if (depth > 1) return [];
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const apps: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    const full = path.join(root, entry.name);
    if (entry.name.endsWith('.app')) {
      apps.push(full);
      continue;
    }
    apps.push(...(await findAppBundles(full, depth + 1)));
  }
  return apps.sort();
}

/* -------------------------------------------------------------------------- */
/* Target resolution                                                          */
/* -------------------------------------------------------------------------- */

interface ResolvedTarget {
  path: string;
  kind: ProbeTargetKind;
  note?: string;
}

/**
 * Turn whatever the user pointed at into a supported target.
 *
 * A plain directory is resolved to the `.xcworkspace` (preferred, since that is
 * what Xcode opens) or `.xcodeproj` inside it, so `offstage probe .` does the
 * obvious thing.
 */
/**
 * Where a build leaves its `.app` relative to a repository root. Deliberately
 * short: this is a convenience for `offstage probe .`, not a filesystem search.
 */
const BUILD_OUTPUT_DIRS = ['build', '.build', 'DerivedData'] as const;

/**
 * Resolve to a single bundle, or refuse.
 *
 * Picking one of several silently is the wrong failure for an entitlements
 * probe: the answer would be about a different binary than the caller meant,
 * and nothing in the output would say so.
 */
function oneBundle(from: string, candidates: string[], base: string): ResolvedTarget {
  if (candidates.length > 1) {
    throw new ProbeError(
      'unsupported-target',
      `${from} contains ${candidates.length} app bundles, so offstage cannot tell which one you mean. ` +
        `Name one:\n${candidates.map((candidate) => `  ${path.relative(base, candidate) || candidate}`).join('\n')}`,
    );
  }
  const only = candidates[0]!;
  return {
    path: only,
    kind: 'app',
    note: `Resolved directory ${from} to the bundle ${path.relative(from, only)} inside it.`,
  };
}

export async function resolveProbeTarget(target: string): Promise<ResolvedTarget> {
  const absolute = path.resolve(target);
  if (!(await pathExists(absolute))) {
    throw new ProbeError('not-found', `No such file or directory: ${absolute}`);
  }
  const lower = absolute.toLowerCase();
  if (lower.endsWith('.xcodeproj')) return { path: absolute, kind: 'xcodeproj' };
  if (lower.endsWith('.xcworkspace')) return { path: absolute, kind: 'xcworkspace' };
  if (lower.endsWith('.app')) return { path: absolute, kind: 'app' };
  if (lower.endsWith('.dmg')) return { path: absolute, kind: 'dmg' };
  if (lower.endsWith('.entitlements') || lower.endsWith('.plist')) return { path: absolute, kind: 'entitlements' };
  if (lower.endsWith('.provisionprofile') || lower.endsWith('.mobileprovision')) {
    return { path: absolute, kind: 'provisioning-profile' };
  }

  if (await isDirectory(absolute)) {
    const entries = (await fs.readdir(absolute)).sort();
    const workspace = entries.find((name) => name.endsWith('.xcworkspace'));
    if (workspace) {
      return {
        path: path.join(absolute, workspace),
        kind: 'xcworkspace',
        note: `Resolved directory ${absolute} to the workspace ${workspace} inside it.`,
      };
    }
    const project = entries.find((name) => name.endsWith('.xcodeproj'));
    if (project) {
      return {
        path: path.join(absolute, project),
        kind: 'xcodeproj',
        note: `Resolved directory ${absolute} to the project ${project} inside it.`,
      };
    }

    // A built bundle, which the error below has always promised a directory
    // could be resolved to and which this branch nevertheless used to ignore.
    // It ranks under the project files on purpose: those describe intent,
    // while a `.app` is one output that may be stale.
    const bundles = entries.filter((name) => name.toLowerCase().endsWith('.app'));
    if (bundles.length > 0) {
      return oneBundle(absolute, bundles.map((name) => path.join(absolute, name)), absolute);
    }

    // SwiftPM and Xcode leave the bundle one level down, so a repository root
    // has no `.app` in it at all, which is the shape `offstage probe .` meets
    // in practice. Look in the conventional output directories only: an
    // unbounded search would be slow and would happily find someone else's app.
    const nested: string[] = [];
    for (const dir of BUILD_OUTPUT_DIRS) {
      if (!entries.includes(dir)) continue;
      const inside = path.join(absolute, dir);
      if (!(await isDirectory(inside))) continue;
      for (const name of (await fs.readdir(inside)).sort()) {
        if (name.toLowerCase().endsWith('.app')) nested.push(path.join(inside, name));
      }
    }
    if (nested.length > 0) return oneBundle(absolute, nested, absolute);
  }

  throw new ProbeError(
    'unsupported-target',
    `offstage does not know how to probe ${absolute}. Point it at an .xcodeproj, .xcworkspace, .entitlements file, built .app, .dmg, or a directory containing one of those.`,
  );
}

/* -------------------------------------------------------------------------- */
/* The probe                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Merge entitlement dictionaries, recording which sources declared each key.
 *
 * Later sources win on conflict: collection order runs weakest evidence first,
 * so the strongest reading of a key is the one that survives. Provenance keeps
 * every source that mentioned the key, so nothing is hidden.
 */
export function mergeEntitlements(sources: readonly EntitlementsSource[]): {
  entitlements: Record<string, unknown>;
  provenance: Map<string, string[]>;
} {
  const entitlements: Record<string, unknown> = {};
  const provenance = new Map<string, string[]>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source.entitlements)) {
      entitlements[key] = value;
      const paths = provenance.get(key) ?? [];
      if (!paths.includes(source.path)) paths.push(source.path);
      provenance.set(key, paths);
    }
  }
  return { entitlements, provenance };
}

/**
 * Probe a target and return the verdict that decides whether macOS app testing
 * is a weekend (`adhoc-ok`) or a month (`needs-signing-lane`).
 *
 * Never throws for anything it merely could not inspect: a missing `codesign`,
 * an unmountable image and an unparseable plist all become notes. It throws
 * {@link ProbeError} only when the target does not exist or is a kind offstage
 * cannot probe at all.
 */
export async function probeEntitlements(
  target: string,
  options: ProbeOptions = {},
): Promise<EntitlementsProbeReport> {
  const maxScanDepth = options.maxScanDepth ?? 4;
  const toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const allowExternalTools = options.allowExternalTools ?? true;

  // An injected runner is always honored: that is how tests exercise the
  // codesign and hdiutil paths on any platform. The real tools are only
  // attempted on macOS, where they exist.
  const runCommand: CommandRunner | null = !allowExternalTools
    ? null
    : (options.runCommand ?? (process.platform === 'darwin' ? defaultRunner(toolTimeoutMs) : null));

  const resolved = await resolveProbeTarget(target);
  const collector: Collector = { sources: [], notes: [], usedCodesign: false };
  if (resolved.note) collector.notes.push(resolved.note);
  if (!runCommand && (resolved.kind === 'app' || resolved.kind === 'dmg')) {
    collector.notes.push(
      allowExternalTools
        ? `codesign and hdiutil are macOS-only and this host is ${process.platform}; the probe used file-based evidence only.`
        : 'External tools were disabled for this probe; the probe used file-based evidence only.',
    );
  }

  switch (resolved.kind) {
    case 'entitlements':
      await addEntitlementsFile(collector, resolved.path, 'declared', 'named directly on the command line');
      break;
    case 'provisioning-profile': {
      const raw = await fs.readFile(resolved.path);
      const entitlements = parseProvisioningProfile(raw);
      if (entitlements) {
        collector.sources.push({
          path: resolved.path,
          origin: 'provisioning-profile',
          discovery: 'declared',
          entitlements,
        });
      } else {
        collector.notes.push(`No Entitlements dictionary could be extracted from ${resolved.path}.`);
      }
      break;
    }
    case 'xcodeproj':
      await collectFromXcodeProject(collector, resolved.path, { maxScanDepth });
      break;
    case 'xcworkspace':
      await collectFromWorkspace(collector, resolved.path, { maxScanDepth });
      break;
    case 'app':
      await collectFromAppBundle(collector, resolved.path, runCommand);
      break;
    case 'dmg':
      await collectFromDiskImage(collector, resolved.path, runCommand);
      break;
  }

  const { entitlements, provenance } = mergeEntitlements(collector.sources);
  const verdict = classifyEntitlements(entitlements, provenance);

  const notes = [...collector.notes];
  let confidence: 'high' | 'low' = 'high';
  if (collector.sources.length === 0) {
    confidence = 'low';
    notes.push(
      'No entitlements were found at all. This reads as adhoc-ok because there is no evidence of a blocker, not because one was ruled out. Point the probe at the target\'s .entitlements file or a built .app to raise confidence.',
    );
  } else if (collector.sources.every((source) => source.discovery === 'scanned')) {
    confidence = 'low';
    notes.push('Every entitlements file used was found by scanning rather than declared by the project, so it may not describe the target you actually build.');
  } else if ((resolved.kind === 'app' || resolved.kind === 'dmg') && !collector.usedCodesign) {
    confidence = 'low';
    notes.push('For a built product the authoritative evidence is the code signature itself, and codesign did not supply it here.');
  }

  return {
    target: resolved.path,
    targetKind: resolved.kind,
    verdict: verdict.verdict,
    confidence,
    triggers: verdict.triggers,
    adhocSatisfied: verdict.adhocSatisfied,
    teamScoped: verdict.teamScoped,
    inert: verdict.inert,
    unclassified: verdict.unclassified,
    entitlements,
    sources: collector.sources,
    notes,
    summary: verdict.summary,
  };
}
