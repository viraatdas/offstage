import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

/// Who the daemon is. Resolved once at startup; every op that needs the
/// helper account's own HOME/USER/TMPDIR reads it from here rather than from
/// whatever the caller sent.
struct Identity {
    let uid: uid_t
    let name: String
    let home: String
    let tmpdir: String

    init() {
        uid = getuid()
        var nameOut = "unknown"
        if let pw = getpwuid(uid), let cName = pw.pointee.pw_name {
            nameOut = String(cString: cName)
        }
        name = nameOut
        home = NSHomeDirectory()
        // The daemon's own per-user temp dir, never the caller's.
        if let t = ProcessInfo.processInfo.environment["TMPDIR"], !t.isEmpty {
            tmpdir = t
        } else {
            var buf = [CChar](repeating: 0, count: 1024)
            let n = confstr(_CS_DARWIN_USER_TEMP_DIR, &buf, buf.count)
            tmpdir = n > 0 ? String(cString: buf) : "/tmp"
        }
    }
}

let identity = Identity()

func screenCaptureFix() -> String {
    "switch to the \(identity.name) account once and allow Screen Recording for offstage-sessiond in System Settings → Privacy & Security"
}

func accessibilityFix() -> String {
    "switch to the \(identity.name) account once and allow Accessibility for offstage-sessiond in System Settings → Privacy & Security"
}

// MARK: - display

/// Main display bounds in points plus the backing scale.
///
/// Note: on macOS 26 `CGDisplayPixelsWide()` returns the *point* width for a
/// Retina display (1728, not 3456), so it cannot be used to derive the scale.
/// The display mode's `pixelWidth / width` is the value that is actually
/// backing-store accurate.
func mainDisplayInfo() -> (width: Int, height: Int, scale: Int) {
    let did = CGMainDisplayID()
    let bounds = CGDisplayBounds(did)
    var scale = 1
    if let mode = CGDisplayCopyDisplayMode(did), mode.width > 0 {
        let s = Int((Double(mode.pixelWidth) / Double(mode.width)).rounded())
        if s >= 1 { scale = s }
    }
    return (Int(bounds.width.rounded()), Int(bounds.height.rounded()), scale)
}

// MARK: - hello

/// The pid owning the frontmost normal window, read from the window server.
///
/// `NSWorkspace.shared.frontmostApplication` is a cache kept fresh by workspace
/// notifications, and this daemon has no run loop to receive them, so it goes
/// stale: observed reporting TextEdit as frontmost minutes after TextEdit had
/// been killed and Calculator activated. The window list is live state, so it
/// is the honest answer.
///
/// Layer 0 is the normal window layer; the first on-screen entry is frontmost.
/// Menus, the Dock and other chrome sit on higher layers and are skipped.
func frontmostWindowPid() -> pid_t? {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return nil
    }
    for w in list {
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let pid = w[kCGWindowOwnerPID as String] as? pid_t else { continue }
        return pid
    }
    return nil
}

/// Is THIS session the one on the console, i.e. the display the user is
/// actually looking at? Input injection is refused when it is: see Input.swift.
///
/// CGSessionCopyCurrentDictionary() uses the double-S spelling
/// "kCGSSessionOnConsoleKey" in the returned dictionary; the documented
/// constant name is kCGSessionOnConsoleKey. Accept both.
///
/// Fails CLOSED: if the session dictionary cannot be read at all, we report
/// "on console" so that input refuses rather than gambling with the user's
/// screen.
func isOnConsole() -> Bool {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    let v = dict["kCGSSessionOnConsoleKey"] ?? dict["kCGSessionOnConsoleKey"]
    guard let n = v as? NSNumber else { return true }
    return n.boolValue
}

func sessionManagerName() -> String {
    guard let dict = CGSessionCopyCurrentDictionary() as? [String: Any],
          let m = dict["kCGSSessionManagerNameKey"] as? String else { return "Aqua" }
    return m
}

func opHello(_ req: [String: Any]) throws -> [String: Any] {
    let display = mainDisplayInfo()
    let onConsole = isOnConsole()
    let managerName = sessionManagerName()

    return [
        "ok": true,
        "op": "hello",
        "daemon": ["version": DAEMON_VERSION, "pid": Int(getpid()), "protocol": PROTOCOL_VERSION],
        "user": ["uid": Int(identity.uid), "name": identity.name, "home": identity.home],
        "session": ["onConsole": onConsole, "managerName": managerName],
        "display": ["width": display.width, "height": display.height, "scale": display.scale],
        "permissions": [
            "screenCapture": CGPreflightScreenCaptureAccess(),
            "accessibility": AXIsProcessTrusted(),
        ],
    ]
}

// MARK: - access

func opAccess(_ req: [String: Any]) throws -> [String: Any] {
    guard let path = req["path"] as? String, !path.isEmpty else {
        throw badRequest("access requires a non-empty \"path\" string")
    }
    var st = stat()
    let exists = stat(path, &st) == 0
    let isDir = exists && (st.st_mode & S_IFMT) == S_IFDIR

    // access(2) answers for the real uid, so ACLs added by
    // `offstage session share` are honoured.
    var readable = exists && access(path, R_OK) == 0
    if isDir { readable = readable && access(path, X_OK) == 0 }
    let writable = exists && access(path, W_OK) == 0

    return [
        "ok": true,
        "exists": exists,
        "readable": readable,
        "writable": writable,
        "directory": isDir,
    ]
}

// MARK: - apps

/// Launch Services' own registry, read through `lsappinfo`.
///
/// This replaced `NSWorkspace.runningApplications` after that API proved to
/// serve frozen snapshots from a launchd-daemon context: Calculator and
/// Safari were visibly running — one of them frontmost, menu bar and all —
/// while the list denied either existed. Without a full NSApplication context
/// the workspace only learns about changes sporadically, and a 0.1-second
/// runloop pump per request did not fix it. `lsappinfo` asks LaunchServices
/// directly and is always current; it is what Apple's own tools use.
func runLsAppInfo(_ args: [String]) -> String {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/lsappinfo")
    process.arguments = args
    let pipe = Pipe()
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    do { try process.run() } catch { return "" }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return String(data: data, encoding: .utf8) ?? ""
}

struct LSAppEntry {
    let asn: String
    let name: String?
    let bundleId: String?
    let pid: Int32
    /// "regular" for Foreground apps, "accessory" for UIElement (menu-bar /
    /// LSUIElement) apps. BackgroundOnly daemons are not skipped-invisible
    /// apps anyone drives, so they are left out entirely.
    let policy: String
}

/// The header of one entry: `<digits>) "<name>" ASN:<0x0-0x…>:` — deliberately
/// strict, because continuation lines like `parentASN="loginwindow" ASN:…`
/// also carry ` ASN:` plus quotes and would otherwise split apps in half.
func lsAppHeader(_ line: Substring) -> (name: String, asn: String)? {
    guard let paren = line.firstIndex(of: ")"), paren > line.startIndex else { return nil }
    let indexPart = line[line.startIndex..<paren]
    guard !indexPart.isEmpty, indexPart.allSatisfy({ $0.isNumber }) else { return nil }
    var rest = line[line.index(after: paren)...]
    rest = rest.drop(while: { $0 == " " })
    guard rest.first == "\"",
          let openQuote = rest.firstIndex(of: "\""),
          let closeQuote = rest[rest.index(after: openQuote)...].firstIndex(of: "\""),
          let asnRange = rest.range(of: " ASN:"), asnRange.lowerBound > closeQuote else { return nil }
    let name = String(rest[rest.index(after: openQuote)..<closeQuote])
    let afterAsn = rest[asnRange.upperBound...]
    guard let asnEnd = afterAsn.firstIndex(of: ":") else { return nil }
    return (name, String(afterAsn[..<asnEnd]))
}

func parseLsAppList(_ output: String) -> [LSAppEntry] {
    var entries: [LSAppEntry] = []
    var name: String? = nil
    var asn: String? = nil
    var bundleId: String? = nil
    var pid: Int32? = nil
    var type: String? = nil

    func flush() {
        if let asn, let pid {
            switch type {
            case "Foreground":
                entries.append(LSAppEntry(asn: asn, name: name, bundleId: bundleId, pid: pid, policy: "regular"))
            case "UIElement":
                entries.append(LSAppEntry(asn: asn, name: name, bundleId: bundleId, pid: pid, policy: "accessory"))
            default:
                break
            }
        }
        name = nil; asn = nil; bundleId = nil; pid = nil; type = nil
    }

    for rawLine in output.split(separator: "\n") {
        let line = Substring(rawLine).drop(while: { $0 == " " || $0 == "\t" })

        if let header = lsAppHeader(line) {
            flush()
            name = header.name
            asn = header.asn
            continue
        }

        guard asn != nil else { continue }

        /* Fields are read independently rather than as an else-if chain:
           `pid` and `type` share one physical line
           (`pid = 21635 type="UIElement" flavor=3 …`), so first-match-per-line
           silently dropped every `type`. */
        if bundleId == nil, let v = quotedValue(in: line, key: "bundleID") {
            bundleId = v == "NULL" ? nil : v
        }
        if pid == nil, let r = line.range(of: "pid = ") {
            let digits = line[r.upperBound...].prefix { $0.isNumber }
            pid = Int32(digits)
        }
        if type == nil, let v = quotedValue(in: line, key: "type") {
            type = v
        }

        // `type` is the last field an app entry needs; once it and the pid are
        // in, this entry is complete.
        if type != nil && pid != nil {
            flush()
        }
    }
    flush()
    return entries
}

/// The value inside double quotes after `<key>="`, or the bare token when the
/// field reads `[ NULL ]` → returns "NULL".
func quotedValue(in line: Substring, key: String) -> String? {
    guard let keyRange = line.range(of: "\(key)=") else { return nil }
    let rest = line[keyRange.upperBound...]
    if rest.hasPrefix("\"") {
        let inner = rest[rest.index(after: rest.startIndex)...]
        if let end = inner.firstIndex(of: "\"") {
            return String(inner[..<end])
        }
        return nil
    }
    let token = rest.prefix { !$0.isWhitespace && $0 != "]" }
    return String(token).isEmpty ? nil : String(token)
}

func opApps(_ req: [String: Any]) throws -> [String: Any] {
    // Accessory apps are listed on purpose: LSUIElement/menu-bar tools — which
    // is what a lot of utility apps an agent wants to test actually are — never
    // get the regular policy, and filtering them out made every launch of such
    // an app look like a failure ("open" succeeded but apps denied it existed,
    // measured with GestureEngine, dev.viraat.GestureEngine).
    let listing = runLsAppInfo(["list"])
    let frontRaw = runLsAppInfo(["front"]).trimmingCharacters(in: .whitespacesAndNewlines)
    let frontAsn = frontRaw.hasPrefix("ASN:")
        ? String(frontRaw.dropFirst("ASN:".count).drop { $0 == ":" })
        : frontRaw

    let apps: [[String: Any]] = parseLsAppList(listing).map { entry in
        [
            "pid": Int(entry.pid),
            // CGWindowList-derived and live; lsappinfo does not expose a
            // reliable hidden flag, so hidden is reported as false.
            "active": !frontAsn.isEmpty && entry.asn == frontAsn,
            "hidden": false,
            "policy": entry.policy as Any,
            "name": entry.name ?? NSNull(),
            "bundleId": entry.bundleId ?? NSNull(),
        ]
    }
    return ["ok": true, "apps": apps]
}

// MARK: - request-permissions

func opRequestPermissions(_ req: [String: Any]) throws -> [String: Any] {
    // Both calls are idempotent; the prompts appear in this session only.
    _ = CGRequestScreenCaptureAccess()
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    _ = AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    return [
        "ok": true,
        "permissions": [
            "screenCapture": CGPreflightScreenCaptureAccess(),
            "accessibility": AXIsProcessTrusted(),
        ],
    ]
}

// MARK: - restart

func opRestart(_ req: [String: Any]) throws -> [String: Any] {
    // Both TCC answers — Screen Recording and Accessibility — are cached for
    // the lifetime of a process, so a grant given after we launched is
    // invisible to us until we start again. Restarting used to mean
    // `launchctl kickstart` in another user's gui domain, which needs root and
    // therefore an admin prompt; prompting is exactly what must not happen
    // behind a user's back. The LaunchAgent is KeepAlive{SuccessfulExit:false},
    // so exiting non-zero has launchd relaunch us with no privilege at all.
    //
    // The exit is deferred so this connection's final line is written and the
    // socket closed first; the caller sees a normal answer, then a short gap
    // while launchd brings the replacement up.
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) {
        logLine("restart requested: exiting non-zero so launchd relaunches us")
        exit(70)
    }
    return ["ok": true, "restarting": true]
}

// MARK: - screenshot

/// Width/height from a PNG's IHDR chunk (bytes 16..24, big endian).
/// Cheaper and more predictable than pulling in ImageIO for two integers.
func pngDimensions(_ data: Data) -> (Int, Int)? {
    guard data.count >= 24 else { return nil }
    let sig: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
    for (i, b) in sig.enumerated() where data[data.startIndex + i] != b { return nil }
    func be32(_ off: Int) -> Int {
        var v = 0
        for i in 0..<4 { v = (v << 8) | Int(data[data.startIndex + off + i]) }
        return v
    }
    return (be32(16), be32(20))
}

/// Run a helper tool to completion, returning (exit status, combined output).
@discardableResult
func runTool(_ path: String, _ args: [String], timeout: TimeInterval = 30) -> (Int32, String) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: path)
    p.arguments = args
    let pipe = Pipe()
    p.standardOutput = pipe
    p.standardError = pipe
    do { try p.run() } catch { return (-1, "\(error)") }
    let out = pipe.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, String(data: out, encoding: .utf8) ?? "")
}

func opScreenshot(_ req: [String: Any]) throws -> [String: Any] {
    // Check first: invoking /usr/sbin/screencapture without the grant can
    // raise a TCC prompt in this session, which is exactly what we must not do.
    guard CGPreflightScreenCaptureAccess() else {
        throw OpError(code: ErrCode.tccScreenCapture,
                      message: "screen recording permission is not granted to offstage-sessiond in the \(identity.name) session",
                      fix: screenCaptureFix())
    }

    var maxDimension: Int? = nil
    if let n = req["maxDimension"] as? NSNumber {
        let v = n.intValue
        guard v > 0 else { throw badRequest("maxDimension must be a positive integer") }
        maxDimension = v
    } else if req["maxDimension"] != nil && !(req["maxDimension"] is NSNull) {
        throw badRequest("maxDimension must be a positive integer")
    }

    let dir = (identity.tmpdir as NSString).appendingPathComponent("offstage-shot-\(getpid())-\(UInt32.random(in: 0..<UInt32.max))")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    let shot = (dir as NSString).appendingPathComponent("screen.png")
    defer { try? FileManager.default.removeItem(atPath: dir) }

    let (status, toolOut) = runTool("/usr/sbin/screencapture", ["-x", "-t", "png", shot])
    guard status == 0, FileManager.default.fileExists(atPath: shot) else {
        throw OpError(code: ErrCode.tccScreenCapture,
                      message: "screencapture produced no file (exit \(status))\(toolOut.isEmpty ? "" : ": " + toolOut.trimmingCharacters(in: .whitespacesAndNewlines))",
                      fix: screenCaptureFix())
    }

    if let maxDimension {
        let (rc, out) = runTool("/usr/bin/sips", ["--resampleHeightWidthMax", String(maxDimension), shot])
        if rc != 0 {
            throw OpError(code: ErrCode.internalError, message: "sips failed to downscale the capture: \(out.trimmingCharacters(in: .whitespacesAndNewlines))")
        }
    }

    guard let data = FileManager.default.contents(atPath: shot) else {
        throw OpError(code: ErrCode.internalError, message: "could not read the captured PNG back")
    }
    guard let (w, h) = pngDimensions(data) else {
        throw OpError(code: ErrCode.internalError, message: "the captured file is not a PNG")
    }

    return [
        "ok": true,
        "png": data.base64EncodedString(),
        "width": w,
        "height": h,
        "scale": mainDisplayInfo().scale,
    ]
}
