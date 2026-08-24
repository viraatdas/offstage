/**
 * Tests for the entitlements probe.
 *
 * Everything here runs with **no Xcode, no signed binary and no macOS tooling**:
 * the plist fixtures under `tests/fixtures/probe/` are checked in, and the two
 * paths that genuinely need `codesign` / `hdiutil` are driven through an
 * injected {@link CommandRunner}. That is deliberate: a probe whose own tests
 * need the thing it is probing for would be useless in CI.
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { CommandResult, CommandRunner } from '../src/probe/index.js';
import {
  ProbeError,
  EntitlementsProbeReportSchema,
  classifyEntitlements,
  entitlementsPathsFromPbxproj,
  extractEmbeddedPlist,
  isEntitlementActive,
  mergeEntitlements,
  mountPointFromHdiutilPlist,
  parseCodesignEntitlements,
  parseEntitlementsPlist,
  parseProvisioningProfile,
  probeEntitlements,
  projectPathsFromWorkspaceData,
  resolveProbeTarget,
  restrictedEntitlementCatalog,
  summarizeEntitlementValue,
  withMountedDiskImage,
} from '../src/probe/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/probe/', import.meta.url));
const fixture = (...segments: string[]): string => path.join(FIXTURES, ...segments);
const ent = (name: string): string => fixture('entitlements', name);

/** File-only probing: no codesign, no hdiutil, identical on every platform. */
const OFFLINE = { allowExternalTools: false } as const;

function ok(stdout: string | Buffer): CommandResult {
  return { exitCode: 0, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout, 'utf8'), stderr: '' };
}

function fail(stderr: string, exitCode: number | null = 1): CommandResult {
  return { exitCode, stdout: Buffer.alloc(0), stderr };
}

function entitlementsPlist(body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    body,
    '</dict>',
    '</plist>',
  ].join('\n');
}

/** Older `codesign` prefixes the plist with an 8-byte 0xfade7171 blob header. */
function codesignBlob(xml: string): Buffer {
  const payload = Buffer.from(xml, 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32BE(0xfade7171, 0);
  header.writeUInt32BE(payload.length + 8, 4);
  return Buffer.concat([header, payload]);
}

function hdiutilAttachPlist(mountPoint: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>system-entities</key>',
    '\t<array>',
    '\t\t<dict>',
    '\t\t\t<key>content-hint</key>',
    '\t\t\t<string>GUID_partition_scheme</string>',
    '\t\t\t<key>dev-entry</key>',
    '\t\t\t<string>/dev/disk9</string>',
    '\t\t</dict>',
    '\t\t<dict>',
    '\t\t\t<key>content-hint</key>',
    '\t\t\t<string>Apple_APFS</string>',
    '\t\t\t<key>dev-entry</key>',
    '\t\t\t<string>/dev/disk9s1</string>',
    `\t\t\t<key>mount-point</key>`,
    `\t\t\t<string>${mountPoint}</string>`,
    '\t\t</dict>',
    '\t</array>',
    '</dict>',
    '</plist>',
  ].join('\n');
}

/* ========================================================================== */
/* Verdicts from fixture plists: the headline requirement                    */
/* ========================================================================== */

describe('probeEntitlements: fixture plists', () => {
  it('returns adhoc-ok for a sandbox + hardened-runtime-only app', async () => {
    const report = await probeEntitlements(ent('sandbox-only.entitlements'), OFFLINE);

    expect(report.verdict).toBe('adhoc-ok');
    expect(report.triggers).toEqual([]);
    expect(report.confidence).toBe('high');
    expect(report.targetKind).toBe('entitlements');
    expect(report.adhocSatisfied).toContain('com.apple.security.app-sandbox');
    expect(report.adhocSatisfied).toContain('com.apple.security.cs.disable-library-validation');
    expect(report.adhocSatisfied).toHaveLength(7);
    expect(report.summary).toMatch(/^adhoc-ok/);
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.origin).toBe('entitlements-file');
    expect(report.sources[0]?.discovery).toBe('declared');
  });

  it('returns needs-signing-lane for Keychain Sharing, naming the exact key', async () => {
    const report = await probeEntitlements(ent('keychain-sharing.entitlements'), OFFLINE);

    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.confidence).toBe('high');
    expect(report.triggers).toHaveLength(1);

    const trigger = report.triggers[0]!;
    expect(trigger.key).toBe('keychain-access-groups');
    expect(trigger.capability).toBe('Keychain Sharing');
    expect(trigger.certainty).toBe('known');
    expect(trigger.explanation).toMatch(/Team ID/);
    expect(trigger.sources).toEqual([ent('keychain-sharing.entitlements')]);
    // The sandbox entitlement alongside it is still reported as satisfied.
    expect(report.adhocSatisfied).toEqual(['com.apple.security.app-sandbox']);
    expect(report.summary).toContain('keychain-access-groups');
    expect(report.summary).toContain('1 restricted entitlement requires');
  });

  it('names every triggering entitlement when several are present', async () => {
    const report = await probeEntitlements(ent('icloud-push-signin.entitlements'), OFFLINE);

    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.triggers.map((trigger) => trigger.key).sort()).toEqual([
      'com.apple.developer.applesignin',
      'com.apple.developer.aps-environment',
      'com.apple.developer.icloud-container-identifiers',
      'com.apple.developer.icloud-services',
    ]);
    expect(report.triggers.every((trigger) => trigger.certainty === 'known')).toBe(true);
    expect(report.triggers.map((trigger) => trigger.capability)).toContain('Sign in with Apple');

    // Team-scoped keys are re-signed by whatever identity signs the product, so
    // they are reported but never treated as blockers.
    expect(report.teamScoped.sort()).toEqual(['application-identifier', 'com.apple.developer.team-identifier']);
    expect(report.triggers.map((trigger) => trigger.key)).not.toContain('application-identifier');

    const push = report.triggers.find((trigger) => trigger.key === 'com.apple.developer.aps-environment')!;
    expect(push.valueSummary).toBe('"development"');
    expect(report.summary).toContain('4 restricted entitlements require');
  });

  it('does not demand a signing lane for restricted keys left empty', async () => {
    const report = await probeEntitlements(ent('inert-restricted.entitlements'), OFFLINE);

    expect(report.verdict).toBe('adhoc-ok');
    expect(report.triggers).toEqual([]);
    expect(report.inert.sort()).toEqual([
      'com.apple.developer.homekit',
      'com.apple.security.application-groups',
      'keychain-access-groups',
    ]);
  });

  it('flags an unknown com.apple.developer.* key as a heuristic trigger, not a fact', async () => {
    const report = await probeEntitlements(ent('future-capability.entitlements'), OFFLINE);

    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.triggers).toHaveLength(1);
    expect(report.triggers[0]?.key).toBe('com.apple.developer.some-capability-invented-after-this-was-written');
    expect(report.triggers[0]?.certainty).toBe('namespace-heuristic');
    expect(report.summary).toContain('namespace heuristic');
    // A third-party key outside Apple's namespaces changes nothing.
    expect(report.unclassified).toEqual(['com.example.vendor.private-flag']);
  });

  it('reads an empty entitlements file as adhoc-ok with the file still counted as evidence', async () => {
    const report = await probeEntitlements(ent('empty.entitlements'), OFFLINE);

    expect(report.verdict).toBe('adhoc-ok');
    expect(report.confidence).toBe('high');
    expect(report.entitlements).toEqual({});
    expect(report.summary).toContain('no entitlements found');
  });

  it('degrades to low confidence, not a crash, when the file is not a plist', async () => {
    const report = await probeEntitlements(ent('malformed.entitlements'), OFFLINE);

    expect(report.verdict).toBe('adhoc-ok');
    expect(report.confidence).toBe('low');
    expect(report.sources).toEqual([]);
    expect(report.notes.join('\n')).toMatch(/not a readable plist dictionary/);
    expect(report.notes.join('\n')).toMatch(/no evidence of a blocker/);
  });

  it('produces reports that satisfy the published schema', async () => {
    for (const name of ['sandbox-only.entitlements', 'icloud-push-signin.entitlements']) {
      const report = await probeEntitlements(ent(name), OFFLINE);
      expect(() => EntitlementsProbeReportSchema.parse(report)).not.toThrow();
    }
  });
});

/* ========================================================================== */
/* Xcode projects and workspaces                                             */
/* ========================================================================== */

describe('probeEntitlements: Xcode targets', () => {
  it('follows CODE_SIGN_ENTITLEMENTS out of project.pbxproj', async () => {
    const report = await probeEntitlements(fixture('DeclaredProject', 'SampleApp.xcodeproj'), OFFLINE);

    expect(report.targetKind).toBe('xcodeproj');
    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.confidence).toBe('high');
    expect(report.triggers.map((trigger) => trigger.key).sort()).toEqual([
      'com.apple.security.application-groups',
      'keychain-access-groups',
    ]);
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.path).toBe(fixture('DeclaredProject', 'SampleApp', 'SampleApp.entitlements'));
    expect(report.sources[0]?.discovery).toBe('declared');
  });

  it('resolves a workspace to the projects it references', async () => {
    const report = await probeEntitlements(fixture('DeclaredProject', 'SampleApp.xcworkspace'), OFFLINE);

    expect(report.targetKind).toBe('xcworkspace');
    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.sources[0]?.path).toBe(fixture('DeclaredProject', 'SampleApp', 'SampleApp.entitlements'));
  });

  it('resolves a plain directory to the workspace inside it', async () => {
    const report = await probeEntitlements(fixture('DeclaredProject'), OFFLINE);

    expect(report.targetKind).toBe('xcworkspace');
    expect(report.target).toBe(fixture('DeclaredProject', 'SampleApp.xcworkspace'));
    expect(report.notes.join('\n')).toMatch(/Resolved directory/);
  });

  it('falls back to scanning when no CODE_SIGN_ENTITLEMENTS is declared, and says so', async () => {
    const report = await probeEntitlements(fixture('ScannedProject', 'ScannedApp.xcodeproj'), OFFLINE);

    expect(report.verdict).toBe('adhoc-ok');
    expect(report.confidence).toBe('low');
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.discovery).toBe('scanned');
    expect(report.notes.join('\n')).toMatch(/declares no CODE_SIGN_ENTITLEMENTS/);
    expect(report.notes.join('\n')).toMatch(/found by scanning/);
  });

  it('reports an unresolvable build-variable path instead of guessing at it', async () => {
    const report = await probeEntitlements(fixture('UnresolvedProject', 'Unresolved.xcodeproj'), OFFLINE);

    expect(report.sources).toEqual([]);
    expect(report.confidence).toBe('low');
    expect(report.notes.join('\n')).toMatch(/interpolates a build variable offstage cannot resolve/);
  });

  it('throws a typed error for a missing or unprobeable target', async () => {
    await expect(probeEntitlements(fixture('does-not-exist.xcodeproj'))).rejects.toBeInstanceOf(ProbeError);
    await expect(probeEntitlements(fixture('does-not-exist.xcodeproj'))).rejects.toMatchObject({ code: 'not-found' });

    const unsupported = fixture('entitlements', 'unsupported-target.txt');
    await fs.writeFile(unsupported, 'nothing to see here\n');
    try {
      await expect(probeEntitlements(unsupported)).rejects.toMatchObject({ code: 'unsupported-target' });
    } finally {
      await fs.rm(unsupported, { force: true });
    }
  });
});

/* ========================================================================== */
/* Built products: .app and .dmg                                             */
/* ========================================================================== */

describe('probeEntitlements: built products', () => {
  it('reads an embedded provisioning profile when codesign is unavailable', async () => {
    const app = fixture('bundles', 'ProfiledApp.app');
    const report = await probeEntitlements(app, OFFLINE);

    expect(report.targetKind).toBe('app');
    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.triggers.map((trigger) => trigger.key)).toEqual(['keychain-access-groups']);
    expect(report.sources.map((source) => source.origin)).toEqual(['provisioning-profile']);
    // Without the signature itself this is indicative, not authoritative.
    expect(report.confidence).toBe('low');
    expect(report.notes.join('\n')).toMatch(/allowlist, which can be broader/);
    expect(report.notes.join('\n')).toMatch(/authoritative evidence is the code signature/);
  });

  it('reports no evidence, not a false all-clear, for an unsigned bundle', async () => {
    const report = await probeEntitlements(fixture('bundles', 'AdhocApp.app'), OFFLINE);

    expect(report.verdict).toBe('adhoc-ok');
    expect(report.confidence).toBe('low');
    expect(report.sources).toEqual([]);
    expect(report.notes.join('\n')).toMatch(/No entitlements evidence found/);
    expect(report.notes.join('\n')).toMatch(/not because one was ruled out/);
  });

  it('parses codesign output, including the legacy blob-wrapped form', async () => {
    const xml = entitlementsPlist(
      ['\t<key>com.apple.security.app-sandbox</key>', '\t<true/>', '\t<key>com.apple.developer.homekit</key>', '\t<true/>'].join('\n'),
    );
    const calls: string[][] = [];
    const runCommand: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      // Stand in for an older codesign that rejects --xml.
      if (args.includes('--xml')) return fail('unknown option --xml');
      return ok(codesignBlob(xml));
    };

    const report = await probeEntitlements(fixture('bundles', 'AdhocApp.app'), { runCommand });

    expect(calls[0]).toContain('--xml');
    expect(calls[1]).not.toContain('--xml');
    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.triggers.map((trigger) => trigger.key)).toEqual(['com.apple.developer.homekit']);
    expect(report.sources.map((source) => source.origin)).toEqual(['codesign']);
    // The signature is the authoritative evidence, so confidence is high.
    expect(report.confidence).toBe('high');
  });

  it('treats a signed bundle with no entitlements as adhoc-ok', async () => {
    const runCommand: CommandRunner = async () => ok('');
    const report = await probeEntitlements(fixture('bundles', 'AdhocApp.app'), { runCommand });

    expect(report.verdict).toBe('adhoc-ok');
    expect(report.notes.join('\n')).toMatch(/codesign reported no entitlements/);
  });

  it('mounts a .dmg read-only, inspects every .app inside, and always detaches', async () => {
    const mountPoint = fixture('bundles');
    const calls: string[][] = [];
    const runCommand: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      if (file === 'hdiutil' && args[0] === 'attach') return ok(hdiutilAttachPlist(mountPoint));
      if (file === 'hdiutil' && args[0] === 'detach') return ok('');
      return fail('code object is not signed at all');
    };

    const report = await probeEntitlements(fixture('FakeImage.dmg'), { runCommand });

    const attach = calls.find((call) => call[0] === 'hdiutil' && call[1] === 'attach')!;
    expect(attach).toContain('-nobrowse');
    expect(attach).toContain('-readonly');
    expect(calls.some((call) => call[0] === 'hdiutil' && call[1] === 'detach')).toBe(true);

    expect(report.targetKind).toBe('dmg');
    // ProfiledApp.app inside the image carries the profile with Keychain Sharing.
    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.triggers.map((trigger) => trigger.key)).toEqual(['keychain-access-groups']);
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.note).toBe(`mounted from ${fixture('FakeImage.dmg')}`);
    // Both bundles were visited: the one with no evidence says so by name.
    expect(report.notes.join('\n')).toMatch(/No entitlements evidence found in AdhocApp\.app/);
  });

  it('records a failed attach as a note rather than throwing', async () => {
    const runCommand: CommandRunner = async (file, args) =>
      file === 'hdiutil' && args[0] === 'attach' ? fail('no mountable file systems') : ok('');

    const report = await probeEntitlements(fixture('FakeImage.dmg'), { runCommand });

    expect(report.verdict).toBe('adhoc-ok');
    expect(report.confidence).toBe('low');
    expect(report.notes.join('\n')).toMatch(/no mountable file systems/);
  });
});

describe('withMountedDiskImage', () => {
  it('detaches even when the body throws, and re-throws the original error', async () => {
    const calls: string[][] = [];
    const runCommand: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      return args[0] === 'attach' ? ok(hdiutilAttachPlist('/Volumes/Offstage')) : ok('');
    };

    await expect(
      withMountedDiskImage('/tmp/whatever.dmg', runCommand, async () => {
        throw new Error('inspection blew up');
      }),
    ).rejects.toThrow('inspection blew up');

    const detach = calls.find((call) => call[1] === 'detach');
    expect(detach).toEqual(['hdiutil', 'detach', '/Volumes/Offstage', '-force']);
  });

  it('does not attempt a detach when the attach never succeeded', async () => {
    const calls: string[][] = [];
    const runCommand: CommandRunner = async (file, args) => {
      calls.push([file, ...args]);
      return fail('attach failed');
    };

    await expect(withMountedDiskImage('/tmp/whatever.dmg', runCommand, async () => 'unreachable')).rejects.toThrow(
      /hdiutil attach failed/,
    );
    expect(calls.filter((call) => call[1] === 'detach')).toEqual([]);
  });

  it('cleans up its private mount root', async () => {
    let mountRootParent = '';
    const runCommand: CommandRunner = async (file, args) => {
      if (args[0] === 'attach') {
        mountRootParent = String(args[args.indexOf('-mountrandom') + 1]);
        return ok(hdiutilAttachPlist('/Volumes/Offstage'));
      }
      return ok('');
    };

    await withMountedDiskImage('/tmp/whatever.dmg', runCommand, async () => 'done');

    expect(mountRootParent).not.toBe('');
    await expect(fs.stat(mountRootParent)).rejects.toThrow();
  });
});

/* ========================================================================== */
/* Classification unit tests                                                 */
/* ========================================================================== */

describe('classifyEntitlements', () => {
  it('is exhaustive: every key lands in exactly one bucket', () => {
    const entitlements = {
      'com.apple.security.app-sandbox': true,
      'keychain-access-groups': ['ABCDE12345.shared'],
      'application-identifier': 'ABCDE12345.com.example',
      'com.apple.security.application-groups': [],
      'com.example.vendor.flag': true,
    };
    const result = classifyEntitlements(entitlements);
    const bucketed = [
      ...result.triggers.map((trigger) => trigger.key),
      ...result.adhocSatisfied,
      ...result.teamScoped,
      ...result.inert,
      ...result.unclassified,
    ].sort();

    expect(bucketed).toEqual(Object.keys(entitlements).sort());
    expect(result.verdict).toBe('needs-signing-lane');
  });

  it('treats the debugger hardened-runtime exception as restricted but the rest as ad-hoc-ok', () => {
    const restricted = classifyEntitlements({ 'com.apple.security.cs.debugger': true });
    expect(restricted.verdict).toBe('needs-signing-lane');
    expect(restricted.triggers[0]?.capability).toBe('Hardened Runtime: Debugging Tool');

    const fine = classifyEntitlements({
      'com.apple.security.cs.allow-jit': true,
      'com.apple.security.cs.allow-unsigned-executable-memory': true,
      'com.apple.security.cs.disable-library-validation': true,
    });
    expect(fine.verdict).toBe('adhoc-ok');
    expect(fine.adhocSatisfied).toHaveLength(3);
  });

  it('covers every restricted capability the plan calls out', () => {
    const keys = [
      'keychain-access-groups',
      'com.apple.security.application-groups',
      'com.apple.developer.icloud-services',
      'com.apple.developer.aps-environment',
      'aps-environment',
      'com.apple.developer.applesignin',
      'com.apple.developer.networking.networkextension',
      'com.apple.developer.homekit',
      'com.apple.security.cs.debugger',
    ];
    for (const key of keys) {
      const result = classifyEntitlements({ [key]: ['value'] });
      expect(result.verdict, key).toBe('needs-signing-lane');
      expect(result.triggers[0]?.certainty, key).toBe('known');
      expect(result.triggers[0]?.explanation.length, key).toBeGreaterThan(20);
    }
  });

  it('matches DriverKit by prefix', () => {
    const result = classifyEntitlements({ 'com.apple.developer.driverkit.transport.usb': true });
    expect(result.triggers[0]?.capability).toBe('DriverKit');
    expect(result.triggers[0]?.certainty).toBe('known');
  });

  it('carries provenance through to each trigger', () => {
    const provenance = new Map([['keychain-access-groups', ['/a/App.entitlements', '/b/App.entitlements']]]);
    const result = classifyEntitlements({ 'keychain-access-groups': ['x'] }, provenance);
    expect(result.triggers[0]?.sources).toEqual(['/a/App.entitlements', '/b/App.entitlements']);
  });

  it('publishes its restricted catalog with a usable explanation for every rule', () => {
    const catalog = restrictedEntitlementCatalog();
    expect(catalog.length).toBeGreaterThan(15);
    for (const rule of catalog) {
      expect(rule.key.length).toBeGreaterThan(0);
      expect(rule.capability.length).toBeGreaterThan(0);
      expect(rule.explanation.length).toBeGreaterThan(20);
    }
  });
});

describe('isEntitlementActive', () => {
  it('separates a requested capability from a leftover key', () => {
    expect(isEntitlementActive(true)).toBe(true);
    expect(isEntitlementActive('development')).toBe(true);
    expect(isEntitlementActive(['group.a'])).toBe(true);
    expect(isEntitlementActive({ a: 1 })).toBe(true);
    expect(isEntitlementActive(new Date(0))).toBe(true);

    expect(isEntitlementActive(false)).toBe(false);
    expect(isEntitlementActive('')).toBe(false);
    expect(isEntitlementActive('   ')).toBe(false);
    expect(isEntitlementActive([])).toBe(false);
    expect(isEntitlementActive({})).toBe(false);
    expect(isEntitlementActive(null)).toBe(false);
    expect(isEntitlementActive(undefined)).toBe(false);
  });
});

describe('summarizeEntitlementValue', () => {
  it('renders each plist type in one short line', () => {
    expect(summarizeEntitlementValue(true)).toBe('true');
    expect(summarizeEntitlementValue('development')).toBe('"development"');
    expect(summarizeEntitlementValue([])).toBe('[] (empty)');
    expect(summarizeEntitlementValue(['a', 'b'])).toBe('[a, b]');
    expect(summarizeEntitlementValue(['a', 'b', 'c', 'd'])).toBe('[a, b, c, +1 more]');
    expect(summarizeEntitlementValue({})).toBe('{} (empty)');
    expect(summarizeEntitlementValue({ a: 1, b: 2 })).toBe('{a, b}');
    expect(summarizeEntitlementValue(Buffer.from([1, 2, 3]))).toBe('3 bytes');
  });
});

/* ========================================================================== */
/* Parsers                                                                   */
/* ========================================================================== */

describe('parsers', () => {
  it('parses a plist and refuses anything that is not a dictionary', () => {
    expect(parseEntitlementsPlist(entitlementsPlist('\t<key>a</key>\n\t<true/>'))).toEqual({ a: true });
    expect(parseEntitlementsPlist('')).toBeNull();
    expect(parseEntitlementsPlist('not xml')).toBeNull();
    expect(
      parseEntitlementsPlist('<?xml version="1.0"?><plist version="1.0"><array><string>x</string></array></plist>'),
    ).toBeNull();
  });

  it('extracts an embedded plist out of surrounding binary noise', () => {
    const xml = entitlementsPlist('\t<key>a</key>\n\t<true/>');
    const wrapped = Buffer.concat([Buffer.from([0x30, 0x82, 0xff, 0xfe]), Buffer.from(xml), Buffer.from([0x00, 0xff])]);

    expect(extractEmbeddedPlist(wrapped)).toBe(xml);
    expect(extractEmbeddedPlist(Buffer.from('no plist here'))).toBeNull();
    expect(extractEmbeddedPlist(Buffer.from('<?xml version="1.0"?><plist>'))).toBeNull();
  });

  it('parses codesign output with and without the blob header', () => {
    const xml = entitlementsPlist('\t<key>com.apple.security.app-sandbox</key>\n\t<true/>');

    expect(parseCodesignEntitlements(codesignBlob(xml))).toEqual({ 'com.apple.security.app-sandbox': true });
    expect(parseCodesignEntitlements(Buffer.from(xml))).toEqual({ 'com.apple.security.app-sandbox': true });
    expect(parseCodesignEntitlements(Buffer.alloc(0))).toBeNull();
    expect(parseCodesignEntitlements(Buffer.from('Executable=/bin/ls\n'))).toBeNull();
  });

  it('pulls the Entitlements dictionary out of a real-shaped provisioning profile', async () => {
    const raw = await fs.readFile(fixture('bundles', 'ProfiledApp.app', 'Contents', 'embedded.provisionprofile'));
    const entitlements = parseProvisioningProfile(raw)!;

    expect(entitlements['keychain-access-groups']).toEqual(['ABCDE12345.*']);
    expect(entitlements['com.apple.developer.team-identifier']).toBe('ABCDE12345');
    expect(parseProvisioningProfile(Buffer.from('garbage'))).toBeNull();
  });

  it('resolves CODE_SIGN_ENTITLEMENTS in both quoted and bare form', () => {
    const parsed = entitlementsPathsFromPbxproj(
      [
        'CODE_SIGN_ENTITLEMENTS = App/App.entitlements;',
        'CODE_SIGN_ENTITLEMENTS = "$(SRCROOT)/App/App.entitlements";',
        'CODE_SIGN_ENTITLEMENTS = "Other/Other.entitlements";',
        'CODE_SIGN_ENTITLEMENTS = "$(TARGET_NAME)/X.entitlements";',
      ].join('\n'),
      '/repo',
    );

    expect(parsed.resolved).toEqual(['/repo/App/App.entitlements', '/repo/Other/Other.entitlements']);
    expect(parsed.unresolved).toEqual(['$(TARGET_NAME)/X.entitlements']);
  });

  it('reads project references out of a workspace, including nested groups', () => {
    const contents = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Workspace version = "1.0">',
      '   <FileRef location = "self:"></FileRef>',
      '   <Group location = "container:" name = "Apps">',
      '      <FileRef location = "group:App/App.xcodeproj"></FileRef>',
      '      <FileRef location = "container:Helper.xcodeproj"></FileRef>',
      '      <FileRef location = "group:Package"></FileRef>',
      '   </Group>',
      '</Workspace>',
    ].join('\n');

    expect(projectPathsFromWorkspaceData(contents, '/repo')).toEqual([
      '/repo/App/App.xcodeproj',
      '/repo/Helper.xcodeproj',
    ]);
    expect(projectPathsFromWorkspaceData('not xml <<<', '/repo')).toEqual([]);
  });

  it('finds the mount point in hdiutil attach output', () => {
    expect(mountPointFromHdiutilPlist(Buffer.from(hdiutilAttachPlist('/Volumes/App')))).toBe('/Volumes/App');
    expect(mountPointFromHdiutilPlist(Buffer.from('<?xml version="1.0"?><plist><dict/></plist>'))).toBeNull();
    expect(mountPointFromHdiutilPlist(Buffer.alloc(0))).toBeNull();
  });
});

describe('mergeEntitlements', () => {
  it('lets later sources win while keeping every source in the provenance', () => {
    const { entitlements, provenance } = mergeEntitlements([
      { path: '/a', origin: 'entitlements-file', discovery: 'scanned', entitlements: { k: ['old'], only: true } },
      { path: '/b', origin: 'codesign', discovery: 'declared', entitlements: { k: ['new'] } },
    ]);

    expect(entitlements).toEqual({ k: ['new'], only: true });
    expect(provenance.get('k')).toEqual(['/a', '/b']);
    expect(provenance.get('only')).toEqual(['/a']);
  });
});

describe('resolveProbeTarget', () => {
  it('classifies each supported target kind', async () => {
    await expect(resolveProbeTarget(ent('sandbox-only.entitlements'))).resolves.toMatchObject({ kind: 'entitlements' });
    await expect(resolveProbeTarget(fixture('bundles', 'AdhocApp.app'))).resolves.toMatchObject({ kind: 'app' });
    await expect(resolveProbeTarget(fixture('FakeImage.dmg'))).resolves.toMatchObject({ kind: 'dmg' });
    await expect(
      resolveProbeTarget(fixture('DeclaredProject', 'SampleApp.xcodeproj')),
    ).resolves.toMatchObject({ kind: 'xcodeproj' });
    await expect(
      resolveProbeTarget(fixture('bundles', 'ProfiledApp.app', 'Contents', 'embedded.provisionprofile')),
    ).resolves.toMatchObject({ kind: 'provisioning-profile' });
  });

  it('returns an absolute path even for a relative argument', async () => {
    const relative = path.relative(process.cwd(), ent('sandbox-only.entitlements'));
    const resolved = await resolveProbeTarget(relative);
    expect(path.isAbsolute(resolved.path)).toBe(true);
    expect(resolved.path).toBe(ent('sandbox-only.entitlements'));
  });

  /**
   * The error for an unsupported target has always offered "or a directory
   * containing one of those", while the directory branch only ever looked for
   * `.xcworkspace` and `.xcodeproj`. Pointing at the folder holding a built
   * app (or at a SwiftPM repository root, where the app lands under `build/`
   * and there is no project file at all) failed with that same message.
   */
  async function tree(layout: Record<string, string>): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offstage-probe-'));
    for (const [relative, contents] of Object.entries(layout)) {
      const full = path.join(root, relative);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, contents);
    }
    return root;
  }

  it('resolves a directory to the app bundle sitting in it', async () => {
    const root = await tree({ 'Demo.app/Contents/Info.plist': '<plist/>' });

    const resolved = await resolveProbeTarget(root);
    expect(resolved.kind).toBe('app');
    expect(resolved.path).toBe(path.join(root, 'Demo.app'));
    expect(resolved.note).toContain('Demo.app');
  });

  it('finds the bundle one level down in a build directory, which is where SwiftPM leaves it', async () => {
    const root = await tree({ 'Package.swift': '// swift-tools-version:5.9', 'build/Demo.app/Contents/Info.plist': '<plist/>' });

    const resolved = await resolveProbeTarget(root);
    expect(resolved.kind).toBe('app');
    expect(resolved.path).toBe(path.join(root, 'build', 'Demo.app'));
  });

  it('still prefers the project file, which describes intent where a build output may be stale', async () => {
    const root = await tree({
      'SampleApp.xcodeproj/project.pbxproj': '// project',
      'build/Demo.app/Contents/Info.plist': '<plist/>',
    });

    await expect(resolveProbeTarget(root)).resolves.toMatchObject({ kind: 'xcodeproj' });
  });

  it('refuses rather than guessing when a directory holds more than one bundle', async () => {
    const root = await tree({
      'build/Alpha.app/Contents/Info.plist': '<plist/>',
      'build/Beta.app/Contents/Info.plist': '<plist/>',
    });

    // Silently picking one would report entitlements for a different binary
    // than the caller meant, with nothing in the output saying so.
    await expect(resolveProbeTarget(root)).rejects.toThrow(/2 app bundles/);
    await expect(resolveProbeTarget(root)).rejects.toThrow(/Alpha\.app/);
    await expect(resolveProbeTarget(root)).rejects.toThrow(/Beta\.app/);
  });

  it('does not go hunting outside the conventional output directories', async () => {
    const root = await tree({ 'vendor/Someone-Elses.app/Contents/Info.plist': '<plist/>' });

    await expect(resolveProbeTarget(root)).rejects.toThrow(/does not know how to probe/);
  });
});

describe('probeEntitlements: provisioning profile as the target', () => {
  it('classifies the profile Entitlements dictionary directly', async () => {
    const report = await probeEntitlements(
      fixture('bundles', 'ProfiledApp.app', 'Contents', 'embedded.provisionprofile'),
      OFFLINE,
    );

    expect(report.targetKind).toBe('provisioning-profile');
    expect(report.verdict).toBe('needs-signing-lane');
    expect(report.triggers.map((trigger) => trigger.key)).toEqual(['keychain-access-groups']);
    expect(report.confidence).toBe('high');
  });
});
