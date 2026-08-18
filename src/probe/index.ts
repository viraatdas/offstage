/**
 * offstage — the entitlements probe.
 *
 * One question, answered before anyone invests in the macOS lane: can a
 * disposable Tart VM test this app with ad-hoc signing (`adhoc-ok`), or does it
 * need a host-side signing lane built first (`needs-signing-lane`)?
 *
 * ```ts
 * import { probeEntitlements } from '../probe/index.js';
 *
 * const report = await probeEntitlements('MyApp.xcodeproj');
 * console.log(report.summary);
 * for (const trigger of report.triggers) {
 *   console.log(`${trigger.key} — ${trigger.capability}: ${trigger.explanation}`);
 * }
 * ```
 *
 * The narrative answer — what ad-hoc signing covers, why re-signing the current
 * output is not enough, and what a real signing lane has to do — lives in
 * `docs/signing-lane.md`.
 */

export {
  EntitlementsProbeReportSchema,
  EntitlementsSourceSchema,
  PROBE_TARGET_KINDS,
  ProbeError,
  ProbeTargetKindSchema,
  SOURCE_ORIGINS,
  entitlementsPathsFromPbxproj,
  extractEmbeddedPlist,
  mergeEntitlements,
  mountPointFromHdiutilPlist,
  parseCodesignEntitlements,
  parseEntitlementsPlist,
  parseProvisioningProfile,
  probeEntitlements,
  projectPathsFromWorkspaceData,
  resolveProbeTarget,
  withMountedDiskImage,
} from './entitlements.js';

export type {
  CommandResult,
  CommandRunner,
  EntitlementsProbeReport,
  EntitlementsSource,
  ProbeOptions,
  ProbeTargetKind,
  SourceOrigin,
} from './entitlements.js';

export {
  EntitlementTriggerSchema,
  EntitlementsVerdictSchema,
  VERDICTS,
  VerdictSchema,
  classifyEntitlements,
  isEntitlementActive,
  restrictedEntitlementCatalog,
  summarizeEntitlementValue,
} from './verdict.js';

export type { EntitlementTrigger, EntitlementsVerdict, Verdict } from './verdict.js';
