/**
 * offstage — entitlements verdict.
 *
 * This module answers exactly one question, and it is the question that decides
 * whether macOS `.app`/`.dmg` testing is a weekend or a month:
 *
 * > Can a disposable Tart VM run this app's tests with **ad-hoc signing**, or
 * > does it first need a **host-side signing lane** backed by a real Developer
 * > ID identity and a provisioning profile?
 *
 * The split is not about "is the app signed". Ad-hoc signing (`codesign -s -`)
 * happily produces a runnable binary and can carry most entitlements. What
 * ad-hoc signing cannot do is *authorize* an entitlement: a handful of
 * entitlements are only honored when the code signature is backed by a
 * provisioning profile that allowlists them for a real Team ID. Request one of
 * those with an ad-hoc signature and the capability silently does not work —
 * or the app refuses to launch — no matter how the VM is configured.
 *
 * `novotnyllc/tart-xcode-runner` (the substrate offstage's `vm` lane delegates
 * to) states this plainly: "The current runner does not automate host signing.
 * […] The default VM path uses ad-hoc signing and needs no Apple credentials.
 * A test that exercises a restricted entitlement such as Keychain Sharing
 * instead needs a host-side Developer ID Application identity and a matching
 * Developer ID provisioning profile." That lane is described as future work.
 *
 * So: `adhoc-ok` means the VM lane works today. `needs-signing-lane` means the
 * signing lane *is* your project. See `docs/signing-lane.md`.
 *
 * The registries below are deliberately explicit rather than clever. An
 * entitlement offstage does not recognize is reported as unclassified rather
 * than quietly assumed safe — with one exception, the `com.apple.developer.*`
 * namespace, which Apple reserves for per-App-ID capability entitlements and
 * which therefore triggers on the namespace alone (flagged as a heuristic, so a
 * reader can tell a guess from a fact).
 */

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Verdict                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * - `adhoc-ok` — every entitlement this product requests is satisfied by
 *   ad-hoc signing. The Tart VM lane can build, sign and test it today, with no
 *   Apple credentials anywhere near the machine.
 * - `needs-signing-lane` — at least one entitlement requires a
 *   provisioning-profile-backed identity. Nothing runs honestly until a
 *   build-on-guest / sign-on-host / return-to-guest lane exists.
 */
export const VERDICTS = ['adhoc-ok', 'needs-signing-lane'] as const;

export type Verdict = (typeof VERDICTS)[number];

export const VerdictSchema = z.enum(VERDICTS);

/**
 * Why a particular entitlement forced `needs-signing-lane`.
 *
 * `certainty` separates the two very different claims this tool can make:
 * - `known` — this exact key is in offstage's restricted registry. Fact.
 * - `namespace-heuristic` — the key is unrecognized but lives under
 *   `com.apple.developer.*`, the namespace Apple allowlists per App ID. Very
 *   likely restricted, but verify before budgeting a month of work for it.
 */
export interface EntitlementTrigger {
  /** The exact entitlement key found, verbatim. */
  key: string;
  /** The user-facing capability name, as Xcode's Signing & Capabilities calls it. */
  capability: string;
  /** One line: why ad-hoc signing cannot satisfy this. */
  explanation: string;
  certainty: 'known' | 'namespace-heuristic';
  /** Short human rendering of the value (the raw value stays in the report). */
  valueSummary: string;
  /** Absolute paths of the sources that declared this key. */
  sources: string[];
}

export const EntitlementTriggerSchema: z.ZodType<EntitlementTrigger> = z.object({
  key: z.string().min(1),
  capability: z.string().min(1),
  explanation: z.string().min(1),
  certainty: z.enum(['known', 'namespace-heuristic']),
  valueSummary: z.string(),
  sources: z.array(z.string()),
});

/**
 * The classification of one merged entitlements dictionary.
 *
 * Every key that went in comes out in exactly one bucket, so a reader can audit
 * the verdict instead of trusting it.
 */
export interface EntitlementsVerdict {
  verdict: Verdict;
  /** Restricted entitlements that force `needs-signing-lane`. Empty ⟺ `adhoc-ok`. */
  triggers: EntitlementTrigger[];
  /** Keys ad-hoc signing satisfies: sandbox, hardened-runtime exceptions, etc. */
  adhocSatisfied: string[];
  /**
   * Keys that merely record the signing team (`application-identifier`,
   * `com.apple.developer.team-identifier`). They are rewritten by whatever
   * identity actually signs the product, so they do not force a signing lane —
   * but their presence tells you the product was last built with a real team.
   */
  teamScoped: string[];
  /**
   * Restricted keys present with an empty or `false` value — an App Groups
   * array with no groups, a `keychain-access-groups` left over from a removed
   * capability. The capability is not actually requested, so it does not
   * trigger. Listed because a human should confirm that is intentional.
   */
  inert: string[];
  /** Keys offstage does not classify either way. They never change the verdict. */
  unclassified: string[];
  /** One line, safe to print as-is. */
  summary: string;
}

export const EntitlementsVerdictSchema: z.ZodType<EntitlementsVerdict> = z.object({
  verdict: VerdictSchema,
  triggers: z.array(EntitlementTriggerSchema),
  adhocSatisfied: z.array(z.string()),
  teamScoped: z.array(z.string()),
  inert: z.array(z.string()),
  unclassified: z.array(z.string()),
  summary: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Registries                                                                 */
/* -------------------------------------------------------------------------- */

interface Rule {
  /** Exact key, or the prefix to match when `match` is `'prefix'`. */
  key: string;
  match: 'exact' | 'prefix';
  capability: string;
  explanation: string;
}

const NEEDS_PROFILE = 'ad-hoc signatures carry no Team ID, so this capability cannot be authorized';

/**
 * Entitlements that require a provisioning profile issued against a real Team
 * ID. These are the ones the prompt for this node calls out, plus a small set
 * of macOS capabilities that are restricted for the same reason.
 */
const RESTRICTED_RULES: Rule[] = [
  {
    key: 'keychain-access-groups',
    match: 'exact',
    capability: 'Keychain Sharing',
    explanation: `Keychain access groups are namespaced by the signing Team ID; ${NEEDS_PROFILE}, and keychain items land in a different (or no) group.`,
  },
  {
    key: 'com.apple.security.application-groups',
    match: 'exact',
    capability: 'App Groups',
    explanation: `App group containers are namespaced by the signing Team ID; ${NEEDS_PROFILE}, so the shared container never resolves.`,
  },
  {
    key: 'com.apple.developer.icloud-container-identifiers',
    match: 'exact',
    capability: 'iCloud (containers)',
    explanation: `iCloud containers are allowlisted per App ID in a provisioning profile; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.icloud-container-development-container-identifiers',
    match: 'exact',
    capability: 'iCloud (development containers)',
    explanation: `Development iCloud containers are allowlisted per App ID in a provisioning profile; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.icloud-container-environment',
    match: 'exact',
    capability: 'iCloud (container environment)',
    explanation: 'Selects the iCloud environment for a container that itself requires a provisioning profile.',
  },
  {
    key: 'com.apple.developer.icloud-services',
    match: 'exact',
    capability: 'iCloud / CloudKit',
    explanation: `CloudKit and iCloud Documents are allowlisted per App ID in a provisioning profile; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.ubiquity-container-identifiers',
    match: 'exact',
    capability: 'iCloud (ubiquity containers)',
    explanation: `Ubiquity containers are Team-ID-prefixed and profile-allowlisted; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.ubiquity-kvstore-identifier',
    match: 'exact',
    capability: 'iCloud key-value store',
    explanation: `The key-value store identifier is Team-ID-prefixed; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'aps-environment',
    match: 'exact',
    capability: 'Push Notifications',
    explanation: `APNs registration is validated against the profile's push entitlement; ${NEEDS_PROFILE}, so device-token registration fails.`,
  },
  {
    key: 'com.apple.developer.aps-environment',
    match: 'exact',
    capability: 'Push Notifications (macOS)',
    explanation: `APNs registration is validated against the profile's push entitlement; ${NEEDS_PROFILE}, so device-token registration fails.`,
  },
  {
    key: 'com.apple.developer.applesignin',
    match: 'exact',
    capability: 'Sign in with Apple',
    explanation: `The authorization flow is bound to a Team ID and its profile; ${NEEDS_PROFILE}, so authorization returns an error.`,
  },
  {
    key: 'com.apple.developer.networking.networkextension',
    match: 'exact',
    capability: 'Network Extensions',
    explanation: `Network Extension providers are only loaded for code signed with a profile granting this entitlement; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.networking.vpn.api',
    match: 'exact',
    capability: 'Personal VPN',
    explanation: `NEVPNManager refuses configurations from code without a profile-backed entitlement; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.networking.multipath',
    match: 'exact',
    capability: 'Multipath',
    explanation: `Multipath TCP is gated on a profile-backed entitlement; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.networking.HotspotConfiguration',
    match: 'exact',
    capability: 'Hotspot Configuration',
    explanation: `Hotspot configuration is gated on a profile-backed entitlement; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.networking.wifi-info',
    match: 'exact',
    capability: 'Access Wi-Fi Information',
    explanation: `Wi-Fi info is gated on a profile-backed entitlement; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.homekit',
    match: 'exact',
    capability: 'HomeKit',
    explanation: `The HomeKit database is only reachable from code signed with a profile granting this entitlement; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.security.cs.debugger',
    match: 'exact',
    capability: 'Hardened Runtime — Debugging Tool',
    explanation: 'This hardened-runtime exception is only honored when the signature carries a provisioning profile that grants it; ad-hoc signing does not.',
  },
  {
    key: 'com.apple.developer.endpoint-security.client',
    match: 'exact',
    capability: 'Endpoint Security',
    explanation: 'Requires an Apple-approved App ID plus a provisioning profile; ad-hoc signed clients are rejected by the Endpoint Security subsystem.',
  },
  {
    key: 'com.apple.developer.system-extension.install',
    match: 'exact',
    capability: 'System Extensions',
    explanation: `System extensions are only installable from Developer-ID-signed hosts with a profile granting this entitlement; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.driverkit',
    match: 'prefix',
    capability: 'DriverKit',
    explanation: `DriverKit entitlements are Apple-approved per App ID and profile-backed; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.developer.associated-domains',
    match: 'exact',
    capability: 'Associated Domains',
    explanation: `Domain association is verified against the signing Team ID; ${NEEDS_PROFILE}, so universal links do not resolve.`,
  },
  {
    key: 'com.apple.developer.family-controls',
    match: 'exact',
    capability: 'Family Controls',
    explanation: `Requires an Apple-approved App ID and a matching profile; ${NEEDS_PROFILE}.`,
  },
  {
    key: 'com.apple.security.hypervisor',
    match: 'exact',
    capability: 'Hypervisor',
    explanation: 'The Hypervisor framework refuses to initialize unless the signature is backed by a profile granting this entitlement.',
  },
  {
    key: 'com.apple.vm.hypervisor',
    match: 'exact',
    capability: 'Hypervisor (legacy key)',
    explanation: 'Legacy hypervisor entitlement; same restriction — the signature must be profile-backed.',
  },
  {
    key: 'com.apple.vm.networking',
    match: 'exact',
    capability: 'VM networking',
    explanation: 'Restricted virtualization networking entitlement; requires a profile-backed signature.',
  },
];

/**
 * Entitlements ad-hoc signing satisfies: the App Sandbox namespace and the
 * hardened-runtime exceptions that the kernel honors from any valid signature.
 * Everything here works today in a disposable Tart VM.
 */
const ADHOC_OK_RULES: Rule[] = [
  { key: 'com.apple.security.app-sandbox', match: 'exact', capability: 'App Sandbox', explanation: 'Enforced by the kernel from any valid signature.' },
  { key: 'com.apple.security.get-task-allow', match: 'exact', capability: 'Debuggable', explanation: 'Development-only; honored for ad-hoc signatures.' },
  { key: 'com.apple.security.inherit', match: 'exact', capability: 'Sandbox inheritance', explanation: 'Sandbox inheritance for child processes; no team required.' },
  { key: 'com.apple.security.print', match: 'exact', capability: 'Printing', explanation: 'Plain sandbox relaxation; no team required.' },
  { key: 'com.apple.security.scripting-targets', match: 'exact', capability: 'Scripting targets', explanation: 'Plain sandbox relaxation; no team required.' },
  { key: 'com.apple.security.network.', match: 'prefix', capability: 'Network (sandbox)', explanation: 'Plain sandbox relaxation; no team required.' },
  { key: 'com.apple.security.files.', match: 'prefix', capability: 'File access (sandbox)', explanation: 'Plain sandbox relaxation; no team required.' },
  { key: 'com.apple.security.device.', match: 'prefix', capability: 'Device access (sandbox)', explanation: 'Plain sandbox relaxation; no team required.' },
  { key: 'com.apple.security.personal-information.', match: 'prefix', capability: 'Personal information (sandbox)', explanation: 'Plain sandbox relaxation; no team required.' },
  { key: 'com.apple.security.assets.', match: 'prefix', capability: 'Media assets (sandbox)', explanation: 'Plain sandbox relaxation; no team required.' },
  { key: 'com.apple.security.automation.', match: 'prefix', capability: 'Apple Events automation', explanation: 'Plain sandbox relaxation; no team required.' },
  { key: 'com.apple.security.temporary-exception.', match: 'prefix', capability: 'Temporary exception (sandbox)', explanation: 'App Store review concern, not a signing concern; ad-hoc signing honors it.' },
  { key: 'com.apple.security.cs.allow-jit', match: 'exact', capability: 'Hardened Runtime — JIT', explanation: 'Hardened-runtime exception honored from any valid signature.' },
  { key: 'com.apple.security.cs.allow-unsigned-executable-memory', match: 'exact', capability: 'Hardened Runtime — unsigned executable memory', explanation: 'Hardened-runtime exception honored from any valid signature.' },
  { key: 'com.apple.security.cs.allow-dyld-environment-variables', match: 'exact', capability: 'Hardened Runtime — dyld environment variables', explanation: 'Hardened-runtime exception honored from any valid signature.' },
  { key: 'com.apple.security.cs.disable-library-validation', match: 'exact', capability: 'Hardened Runtime — disable library validation', explanation: 'Hardened-runtime exception honored from any valid signature (and often what makes ad-hoc test injection work at all).' },
  { key: 'com.apple.security.cs.disable-executable-page-protection', match: 'exact', capability: 'Hardened Runtime — disable executable page protection', explanation: 'Hardened-runtime exception honored from any valid signature.' },
  { key: 'com.apple.security.cs.allow-relative-library-loads', match: 'exact', capability: 'Hardened Runtime — relative library loads', explanation: 'Hardened-runtime exception honored from any valid signature.' },
];

/**
 * Keys that only record *which team* signed the product. Re-signing rewrites
 * them, so they never force a signing lane on their own.
 */
const TEAM_SCOPED_KEYS = new Set([
  'application-identifier',
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
]);

/** Apple's per-App-ID capability namespace — see `certainty: 'namespace-heuristic'`. */
const DEVELOPER_NAMESPACE = 'com.apple.developer.';

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

function findRule(rules: Rule[], key: string): Rule | undefined {
  for (const rule of rules) {
    if (rule.match === 'exact' && rule.key === key) return rule;
  }
  // Longest prefix wins, so a specific family beats a broad one.
  let best: Rule | undefined;
  for (const rule of rules) {
    if (rule.match !== 'prefix' || !key.startsWith(rule.key)) continue;
    if (!best || rule.key.length > best.key.length) best = rule;
  }
  return best;
}

/**
 * Is this entitlement actually *requesting* its capability?
 *
 * `com.apple.security.application-groups = []` is a leftover from a removed
 * capability, not a reason to build a signing lane. `false`, `""`, `[]` and
 * `{}` all mean "not requested"; everything else means it is.
 */
export function isEntitlementActive(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return true;
  if (value instanceof Uint8Array) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as object).length > 0;
  return true;
}

/** Short, printable rendering of an entitlement value. */
export function summarizeEntitlementValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return `${value.length} bytes`;
  if (Array.isArray(value)) {
    const shown = value.slice(0, 3).map((entry) => (typeof entry === 'string' ? entry : typeof entry));
    const suffix = value.length > shown.length ? `, +${value.length - shown.length} more` : '';
    return value.length === 0 ? '[] (empty)' : `[${shown.join(', ')}${suffix}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as object);
    return keys.length === 0 ? '{} (empty)' : `{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
  }
  return String(value);
}

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Classify a merged entitlements dictionary.
 *
 * @param entitlements the effective entitlements for one product.
 * @param provenance   optional key → source paths, so each trigger can say
 *                     which file it came from. Missing entries are fine.
 */
export function classifyEntitlements(
  entitlements: Record<string, unknown>,
  provenance: ReadonlyMap<string, string[]> = new Map(),
): EntitlementsVerdict {
  const triggers: EntitlementTrigger[] = [];
  const adhocSatisfied: string[] = [];
  const teamScoped: string[] = [];
  const inert: string[] = [];
  const unclassified: string[] = [];

  for (const key of Object.keys(entitlements).sort()) {
    const value = entitlements[key];
    const restricted = findRule(RESTRICTED_RULES, key);

    if (restricted) {
      if (!isEntitlementActive(value)) {
        inert.push(key);
        continue;
      }
      triggers.push({
        key,
        capability: restricted.capability,
        explanation: restricted.explanation,
        certainty: 'known',
        valueSummary: summarizeEntitlementValue(value),
        sources: provenance.get(key) ?? [],
      });
      continue;
    }

    if (findRule(ADHOC_OK_RULES, key)) {
      adhocSatisfied.push(key);
      continue;
    }

    if (TEAM_SCOPED_KEYS.has(key)) {
      teamScoped.push(key);
      continue;
    }

    if (key.startsWith(DEVELOPER_NAMESPACE)) {
      if (!isEntitlementActive(value)) {
        inert.push(key);
        continue;
      }
      triggers.push({
        key,
        capability: 'Unrecognized Apple capability',
        explanation:
          'offstage does not know this key, but Apple reserves com.apple.developer.* for capabilities allowlisted per App ID, which almost always means a provisioning profile. Verify this one before treating it as a hard blocker.',
        certainty: 'namespace-heuristic',
        valueSummary: summarizeEntitlementValue(value),
        sources: provenance.get(key) ?? [],
      });
      continue;
    }

    unclassified.push(key);
  }

  const verdict: Verdict = triggers.length > 0 ? 'needs-signing-lane' : 'adhoc-ok';
  return {
    verdict,
    triggers,
    adhocSatisfied,
    teamScoped,
    inert,
    unclassified,
    summary: summarize(verdict, triggers, Object.keys(entitlements).length),
  };
}

function summarize(verdict: Verdict, triggers: EntitlementTrigger[], total: number): string {
  if (verdict === 'adhoc-ok') {
    return total === 0
      ? 'adhoc-ok — no entitlements found. Nothing here needs a signing identity; the Tart VM lane can run this today.'
      : `adhoc-ok — all ${total} entitlement${total === 1 ? '' : 's'} are satisfied by ad-hoc signing. The Tart VM lane can run this today.`;
  }
  const names = triggers.map((t) => t.key).join(', ');
  const guessed = triggers.filter((t) => t.certainty === 'namespace-heuristic').length;
  const caveat = guessed > 0 ? ` (${guessed} matched by namespace heuristic, not by an exact rule — verify ${guessed === 1 ? 'it' : 'them'})` : '';
  return `needs-signing-lane — ${triggers.length} restricted entitlement${triggers.length === 1 ? ' requires' : 's require'} a provisioning-profile-backed identity: ${names}${caveat}. tart-xcode-runner does not automate host signing, so building that lane is the project. See docs/signing-lane.md.`;
}

/** The restricted registry, for docs and `offstage probe --explain`. */
export function restrictedEntitlementCatalog(): ReadonlyArray<{
  key: string;
  match: 'exact' | 'prefix';
  capability: string;
  explanation: string;
}> {
  return RESTRICTED_RULES.map((rule) => ({ ...rule }));
}
