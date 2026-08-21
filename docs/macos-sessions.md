# Driving macOS without taking the user's screen

> **2026-08-21, the `vm` lane described below was later removed** (see
> `docs/roadmap.md`); it never drove a real macOS guest. This document is left
> as it was written, because it is the historical record of the investigation
> that led to the session lane, and the vm lane's cost is what motivated that
> investigation in the first place.

offstage's vm lane answered "run this where it cannot touch my display" with a
whole macOS guest. That is correct but expensive: the pinned Tart image was a
**68.8 GB** download. This document records what else macOS offers, why the
obvious cheap answers do not work, and exactly where the one promising native
mechanism stops being reachable.

Everything here was measured on macOS 26.3 (build 25D125), Apple silicon.

## There is no Xvfb for macOS, and there cannot be

Xvfb works because X11 is a documented wire protocol over a socket: anyone may
implement a server, any client may connect to any server, and `$DISPLAY` names
which one. macOS has none of those four properties.

1. **No protocol.** The window server is `SkyLight.framework`, whose export
   surface is **2,388 symbols** (`_SLSAddTrackingRegion`,
   `_SLSAccessWindowBackingStore`, …). AppKit calls those in-process and they
   marshal over a Mach port. Undocumented, and unstable across releases.

2. **No `$DISPLAY`.** A process finds the window server through the Mach
   bootstrap namespace of its launchd session, not an address. `launchctl
   managername` returns `Aqua` in a GUI session; a `Background` session cannot
   obtain a window server connection at all — the familiar "not connected to a
   window server" failure. The lookup is namespace-based, so there is nothing
   to redirect.

3. **Nothing to replace.** SkyLight is not a file on disk; it lives in the dyld
   shared cache. SIP, library validation and the hardened runtime block
   injecting into signed system processes, so there is no `LD_PRELOAD` seam.

4. **TCC is session-keyed regardless.** Screen capture and event injection are
   gated per session, enforced outside the calling process.

Corroboration from an unexpected direction: OpenAI's Codex Computer Use ships a
macOS agent that does *not* isolate anything. It links ScreenCaptureKit
(`SCStream`, `SCShareableContent`) and drives the accessibility tree
(`AXUIElement*`) in the **user's own session** — its UI string is literally
"Codex is Using Your Mac". The `CGSSession*` symbols it references
(`kCGSSessionOnConsoleKey`, `CGSSessionScreenIsLocked`,
`kCGSSessionSecureInputPID`) are queries about the session it is already in, and
it ships a lock-screen guardian plus a login authorization plugin precisely
because it needs the real session alive. A well-resourced team building exactly
this did not find a headless path either.

**What macOS offers instead is a headless _session_, not a headless _server_:**
a real window server rendering to a virtual framebuffer that nobody is watching.
That is what a CI Mac with no monitor is. Every workable option below is a
different way to obtain one.

## The three ways to get an unwatched GUI session

| | disk | isolates input | clean state | notes |
|---|---|---|---|---|
| VM (Tart) | 27–69 GB | yes | yes, snapshots | what the vm lane uses today |
| remote Mac | 0 local | yes | depends | EC2 Mac hosts bill a **24-hour minimum** |
| second local account | ~3 GB | yes | no | needs a display — see below |

The third is the interesting one and the rest of this document is about it.

## Screen Sharing's virtual display

`screensharingd` can build, per connection, three things bound together:

- **a virtual framebuffer** — `VirtualFrameBuffer()`, `SSAgentInfo_VirtualFrameBuffer`
- **a login session** — `create login window session if necessary`
- **synthetic keyboard and mouse** — `VirtualDisplayHIDFilter.c`,
  `VirtualDisplayHIDFilterStart`

The HID filter is the load-bearing part: input arriving on the connection enters
*that session's* event stream, never the console's. Two sessions, two input
streams, no contention. Counts are tracked (`set virtual display count to %d`,
`max virtual display change from %d to %d`) and capped by `RFBMaxVirtualDisplays`,
and the server can refuse (`viewer deny request virtual session error`).

The choice is the client's. `ScreenSharing.framework` exports four selectors,
whose CFString values are:

    kSSSessionSelect_ConnectToConsole            = "ConnectToConsole"
    kSSSessionSelect_RequestConsole              = "RequestConsole"
    kSSSessionSelect_ConnectToVirtualDisplay     = "ConnectToVirtualDisplay"
    kSSSessionSelect_DontConnectToVirtualDisplay = "DontConnectToVirtualDisplay"

Those strings do **not** appear in `screensharingd`, so they are client-side
state; the wire encoding of the choice is separate and still unidentified.

## Authentication: which type does what

`screensharingd` on 127.0.0.1:5900 announces `RFB 003.889` and offers security
types **30, 33, 36, 35**.

### Type 30 — legacy ARD auth. Works, and takes the console.

Diffie-Hellman (generator 2, 1024-bit modulus supplied by the server), the
shared secret MD5'd into an AES-128 key, and a 128-byte credential block
(username at offset 0, password at offset 64, both NUL-terminated, remainder
random) encrypted ECB. Implemented and **verified working** against this
machine.

It is also the wrong tool. Type 30 predates the session selectors, so the server
has nothing to read and falls back to switching the console to the
authenticating user. Observed directly: `/dev/console` owner changed from
`viraat` to `computeruse`, a second `loginwindow` appeared, and the session
**persisted after disconnect**. The framebuffer reported was `3456x2234` — the
physical display — confirming it attached to the real screen rather than making
a new one.

### Types 33 / 35 / 36 — SASL SRP. Not yet implemented.

The daemon's strings identify the mechanism unambiguously: `srp.m`,
`HandleAuthTypeMessage`, `HandleSRPAuthenticationMessage`,
`srp_server_mech_step`, `ccsrp_server_generate_public_key`,
`ccsrp_server_compute_session`, and the SASL SRP option set — *MDA*,
*Replay Detection*, *Confidentiality+Integrity*, *KDF*, *Maxbuffersize*. Buffer
primitives appear as `SRP MPI`, `SRP os`, `SRP UTF8`, `SRP uint`,
`SRP uint64_t`, `SRP char`.

The local account record names the parameters:

    SRP-RFC5054-4096-SHA512-PBKDF2

so: RFC 5054 4096-bit group, SHA-512, password stretched through PBKDF2.

For these types the **client speaks first** — selecting 33 or 35 yields no
server bytes until the client sends an auth-type message, whose malformed-input
log is `bad packet: version:%d, authtype:%s` (note authtype is a *string*).

## Where this stops

Reaching a virtual display requires both an SRP implementation and the
still-unknown wire encoding of `ConnectToVirtualDisplay`. Both are private and
may change in any macOS release. Before paying that cost, the cheaper question
should be settled:

**Can a non-console session be driven at all?** If a background session retains
a usable framebuffer, offstage needs no protocol work — `launchctl asuser <uid>`
reaches it, and the virtual display is unnecessary. If it does not, the virtual
display is mandatory and the SRP work is the only native route.

That experiment needs root once, and is the correct next step.

## Facts worth keeping

- Screen Sharing access is gated by the group `com.apple.access_screensharing`,
  which nests the `admin` group. A standard user must be added explicitly —
  this is what a rejected auth looks like before any password is checked.
- Apple's own client refuses same-host connections ("You cannot control your own
  screen"), including via the LAN address. That is client policy; the daemon
  accepts loopback connections happily.
- A user created with `sysadminctl -addUser` but no `-password` gets **no**
  `AuthenticationAuthority` and **no** SecureToken. Under FileVault that account
  cannot authenticate. Setting the password through System Settings repairs both.

## Outcome

This document ends at "that experiment needs root once, and is the correct next
step". The experiment was run, and it settled the question in the cheap
direction: **a backgrounded session can be driven**, so none of the Screen
Sharing protocol work above is needed. What was built instead is the session
lane — a helper account logged in and left in the background, with a small Swift
daemon inside its session that offstage talks to over a unix socket. See
[session-lane.md](session-lane.md) for the design and
[`native/sessiond/README.md`](../native/sessiond/README.md) for the daemon.

### One reading above was wrong, and it is worth correcting in place

Earlier in this file the second account's session is described as "sitting at
the login window". It was not. `IOConsoleUsers` reports
`kCGSessionLoginDoneKey: true` for that entry — a completed login and a full
Aqua session — alongside `kCGSSessionOnConsoleKey: false`. What was actually on
that session's screen was **Setup Assistant**, which the account had been parked
in and which looks like a login window from the outside. The distinction is the
whole lane: a login window has no window server connection to spawn apps into,
and a logged-in background session has one. Reading `LoginDone` rather than
guessing from a screenshot is why `src/session/discover.ts` parses that key and
why the lane's availability ladder gates on it.

The Screen Sharing findings above stay as they are. They remain true, and they
remain the fallback if Apple ever takes the multi-session behaviour away.
