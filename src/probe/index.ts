/**
 * offstage: the entitlements probe.
 *
 * One question, answered before anyone invests in macOS app testing
 * infrastructure: can this app be built and tested with ad-hoc signing
 * (`adhoc-ok`), or does it declare entitlements that only a real Developer ID
 * and a provisioning profile can authorize (`needs-signing-lane`)?
 *
 * This is a fact about the app's entitlements, not about any particular way of
 * running its tests, so the answer holds wherever you run them. offstage has no
 * signing lane of its own; the probe exists so nobody promises a date before
 * finding out which of the two jobs they signed up for.
 *
 * ```ts
 * import { probeEntitlements } from '../probe/index.js';
 *
 * const report = await probeEntitlements('MyApp.xcodeproj');
 * console.log(report.summary);
 * for (const trigger of report.triggers) {
 *   console.log(`${trigger.key}: ${trigger.capability}: ${trigger.explanation}`);
 * }
 * ```
 *
 * The narrative answer (what ad-hoc signing covers, why re-signing the current
 * output is not enough, and what a real signing lane has to do) lives in
 * the README's probe section.
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
