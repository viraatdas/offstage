# The signing lane: weekend or month?

Testing a macOS app in a disposable [Tart](https://tart.run) VM through
[`novotnyllc/tart-xcode-runner`](https://github.com/novotnyllc/tart-xcode-runner)
works today, with no Apple credentials anywhere near the machine, for most
apps. offstage does not run that VM itself (its own `vm` lane was removed;
see `docs/verified.md`), but this probe answers the question independently of
who runs it: pair the verdict with the `tart-xcode-runner` skill or your own
Tart setup. For some apps it cannot work at all until a piece of
infrastructure that does not exist yet gets built.

This document says exactly which app you have, and what the second case costs.

**Run the probe first. Do not guess.**

```ts
import { probeEntitlements } from './src/probe/index.js';

const report = await probeEntitlements('MyApp.xcodeproj');
console.log(report.summary);
for (const trigger of report.triggers) {
  console.log(`${trigger.key} — ${trigger.capability}: ${trigger.explanation}`);
}
```

(The `offstage probe` command and the package-level export are wired up with the
CLI; the function above is the interface today.)

It accepts an `.xcodeproj`, an `.xcworkspace`, a bare `.entitlements` file, a
built `.app`, a `.dmg`, or a directory containing any of those, and returns one
of two verdicts.

---

## The decision table

| Verdict | What it means | What you do |
| --- | --- | --- |
| `adhoc-ok` | Every entitlement the product requests is satisfied by ad-hoc signing. | **You are done today.** Run your tests in a disposable Tart VM (the `tart-xcode-runner` skill, or your own setup). No Developer ID, no profile, no signing host, no Apple Account in the VM. |
| `needs-signing-lane` | At least one entitlement requires a signature backed by a provisioning profile issued against a real Team ID. | **That lane is your project.** The runner does not automate host signing; the section below is the work item. Budget weeks, not an afternoon — and read the "what it actually costs" section before you start. |

The report also carries a `confidence` field. `low` means the verdict rests on
weak evidence — nothing was found, or only files discovered by scanning, or a
built product was inspected without `codesign`. A `low` `adhoc-ok` means *"found
no blocker"*, not *"proved there is none"*. Re-run the probe against the target's
declared `.entitlements` file or a built `.app` to get a `high`-confidence answer
before you rely on it.

---

## What ad-hoc signing covers

Ad-hoc signing (`codesign -s -`) produces a real, valid signature with no
identity behind it. The signature has no Team ID, no certificate chain, and no
provisioning profile. The kernel still honors it, which is why the default VM
path works with no Apple credentials at all.

Ad-hoc signing is enough for:

- **The App Sandbox**, in full — `com.apple.security.app-sandbox` and every
  relaxation under it: file access, network client/server, camera, microphone,
  USB, printing, Apple Events automation, personal-information access, and the
  `temporary-exception.*` family. These are enforced by the kernel from *any*
  valid signature; none of them ask who signed it.
- **Hardened Runtime exceptions** that are not profile-gated:
  `allow-jit`, `allow-unsigned-executable-memory`,
  `allow-dyld-environment-variables`, `disable-library-validation`,
  `disable-executable-page-protection`, `allow-relative-library-loads`.
- **`get-task-allow`**, so the test runner can attach to the app.
- Launching the app, driving it with XCUITest, and every XCTest that does not
  touch a restricted capability.

That covers the large majority of apps, and it is why `adhoc-ok` is the common
answer.

## What ad-hoc signing cannot cover

A handful of entitlements are not *permissions the kernel grants* — they are
*claims Apple authorizes*. The system honors them only when the signature is
backed by a provisioning profile that allowlists that entitlement for that App
ID under a real Team ID. An ad-hoc signature has no Team ID to check, so the
capability silently does not work, or the app refuses to launch.

The probe flags these, and names the exact key it found:

| Capability | Entitlement key |
| --- | --- |
| Keychain Sharing | `keychain-access-groups` |
| App Groups | `com.apple.security.application-groups` |
| iCloud / CloudKit | `com.apple.developer.icloud-services`, `com.apple.developer.icloud-container-identifiers`, `com.apple.developer.ubiquity-*` |
| Push Notifications | `aps-environment`, `com.apple.developer.aps-environment` |
| Sign in with Apple | `com.apple.developer.applesignin` |
| Network Extension / Personal VPN | `com.apple.developer.networking.networkextension`, `com.apple.developer.networking.vpn.api` |
| HomeKit | `com.apple.developer.homekit` |
| Hardened Runtime — Debugging Tool | `com.apple.security.cs.debugger` |
| Endpoint Security, System Extensions, DriverKit, Associated Domains, Family Controls, Hypervisor | see `restrictedEntitlementCatalog()` |

Two design notes on how the probe reads these:

- **An empty value is not a request.** `com.apple.security.application-groups = []`
  is a leftover from a capability someone removed in Xcode, not a reason to build
  a signing lane. Those keys are reported under `inert` and do not change the
  verdict.
- **Unknown `com.apple.developer.*` keys trigger, but say they are guessing.**
  Apple reserves that namespace for per-App-ID capabilities, so an unrecognized
  key there is very likely restricted — but the trigger is marked
  `certainty: 'namespace-heuristic'` rather than `'known'`. Verify those before
  you budget a month for them.

---

## The gap in tart-xcode-runner

The runner's README is explicit about this, and it is the whole reason this
probe exists:

> The current runner does not automate host signing. Do not create or export a
> Developer ID identity solely for this runner until the build/sign/return lane
> below has been implemented and proven for the project.

So the runner ships the ad-hoc path and documents the signed path as future
work. There is no partial version of this you can lean on.

### Why re-signing the current output is not enough

The obvious shortcut — take whatever the guest just built, drop a provisioning
profile into it, re-sign with a Developer ID identity — does not work, and the
reason is specific:

> The existing guest helper clears `CODE_SIGN_ENTITLEMENTS`, so simply embedding
> a profile and re-signing the current output is insufficient. The future lane
> must preserve or reconstruct the expanded entitlements and pass them
> explicitly when signing.

Unpacked: the guest builds with `CODE_SIGN_ENTITLEMENTS` cleared, so the product
sitting in the guest's build directory **has no entitlements baked into it**.
`codesign` does not read entitlements from a bundle — it applies whatever you
pass on the command line, or nothing. Re-signing that output therefore produces a
correctly-signed app with an empty entitlements set: it launches, it passes
`codesign --verify`, and every restricted capability is still missing. The test
fails in a way that looks like an app bug rather than a lane bug, which is worse
than not running at all.

The entitlements also have to be the **expanded** ones. Xcode substitutes build
variables into the `.entitlements` file at build time — `$(AppIdentifierPrefix)`
becomes the Team ID, `$(CFBundleIdentifier)` becomes the bundle ID. The literal
file in the repo is a template. Signing with the template is signing with the
wrong values.

### What a real host-signing lane has to do

Per the runner's own description, the lane to implement and prove is:

1. **Build in the guest.** Run `xcodebuild build-for-testing` in a disposable
   clone, *while preserving enough build metadata to reconstruct each product's
   fully expanded entitlements.* This is the part the current helper destroys,
   and it is the hard part — it means capturing resolved build settings
   (`xcodebuild -showBuildSettings`) or the pre-clear entitlements plist per
   product, and carrying them out alongside the binaries.
2. **Sign on the host.** Move the build products to the host — the host, because
   the private key must never enter a VM, a golden image, a guest share, or a
   test artifact. For every product that needs one, embed the matching profile at
   `<bundle>/Contents/embedded.provisionprofile`, then sign **all nested code
   inside-out** (frameworks, XPC services, helpers, then the app) with the
   Developer ID Application identity and *each product's own explicit
   entitlements*. **Never use `codesign --deep` to sign** — it applies one
   entitlements set to everything and gets nested identifiers wrong.
3. **Return to the guest.** Copy the signed products back into the *same* guest
   clone and run `xcodebuild test-without-building`. Same clone, because a fresh
   clone would not have the build artifacts the test action expects.
4. **Verify before believing it.** `codesign --verify --deep --strict` on every
   product, and `spctl -a -t exec -vv` for the Gatekeeper assessment. Note the
   asymmetry with step 2: `--deep` is wrong for *signing* and correct for
   *verifying* — verification should walk the whole nested tree, signing should
   not. Then compare `codesign -d --entitlements :-` against the embedded
   profile, confirm the profile's `ProvisionsAllDevices` flag, and exercise the
   protected operation through an actual app relaunch. An entitlement that is
   present in the signature but not honored at runtime is the exact failure this
   whole lane exists to prevent, and only a relaunch catches it.

### What it actually costs

Beyond the code, the lane drags in an operational burden that a probe cannot
make go away:

- A **Developer ID Application certificate** and a Developer ID provisioning
  profile per entitlement-bearing bundle ID. A team gets five certificate slots.
- A designated **signing host** with the private key in its Keychain, and a
  custody story for that key — plus a second one if more than one machine builds.
- **Keychain authorization prompts** on that host, which means the lane cannot be
  fully unattended the first time and needs a real PTY when an agent drives it.

The upside, and it is real: Developer ID profiles use `ProvisionsAllDevices`, so
the VM needs neither an Apple Account nor device registration, and burns none of
the team's 100 development device slots. One identity signs build products from
many apps and many VM runs.

---

## Gatekeeper does not block the ad-hoc path

A reasonable worry about the `adhoc-ok` verdict: an ad-hoc-signed app is not
notarized and not Developer-ID-signed, so wouldn't macOS refuse to launch it in
the VM?

No — because Gatekeeper's first-launch assessment is triggered by the
`com.apple.quarantine` extended attribute, and that attribute is set by the
application that *downloads* a file (a browser, a mail client), not by the
filesystem. The runner mounts your checkout read-only into the guest and copies
it to guest APFS; a build produced inside the VM, or a bundle copied in over the
share mount, never acquires the attribute. With no quarantine flag, `spctl` is
not consulted and the app launches on its ad-hoc signature.

Two consequences worth being precise about:

- **For testing, this is fine and it is not a trick.** The app runs under the
  same code-signing enforcement a locally-built app gets on your own Mac.
- **It proves nothing about distribution.** `spctl -a -t exec` on that same
  ad-hoc build would reject it. If you want to know whether real users can open
  your `.dmg`, that is the Developer ID + notarization question, and it is a
  different question from the one this probe answers. The probe tells you whether
  your *tests* can run; it does not tell you whether your *release* is shippable.

---

## Summary

- Run `probeEntitlements()` against your target before investing in either path.
- `adhoc-ok` → a disposable Tart VM works today, with no Apple credentials. Ship it.
- `needs-signing-lane` → the report names the exact entitlements that force it.
  tart-xcode-runner does not automate host signing, the guest helper actively
  clears `CODE_SIGN_ENTITLEMENTS` so the shortcut does not work, and the four
  steps above are the real scope. Decide whether that capability is worth it
  *before* creating a Developer ID identity — the runner's own README asks you
  not to create one until the lane exists.
