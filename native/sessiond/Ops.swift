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

/// Pump the main runloop briefly so AppKit delivers its pending workspace
/// notifications. This process runs as a launchd daemon with no NSApplication
/// event loop, and `NSWorkspace`'s snapshot of `runningApplications` only
/// updates when the main runloop turns: without this, an app opened seconds
/// ago is simply missing from the list (measured: TextEdit frontmost on
/// screen while `apps` denied it existed).
func refreshWorkspaceState() {
    let deadline = Date().addingTimeInterval(0.1)
    let runloop = RunLoop.main
    while runloop.run(mode: .default, before: deadline) && Date() < deadline {
        // Drain until the deadline; run(mode:before:) returns false once the
        // deadline passes with nothing scheduled, which ends the loop.
    }
}

func opApps(_ req: [String: Any]) throws -> [String: Any] {
    refreshWorkspaceState()
    let front = frontmostWindowPid()
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .map { app -> [String: Any] in
            var entry: [String: Any] = [
                "pid": Int(app.processIdentifier),
                // Live, for the same reason sessionTargetPid() is.
                "active": app.processIdentifier == front,
                "hidden": app.isHidden,
            ]
            entry["name"] = app.localizedName ?? NSNull()
            entry["bundleId"] = app.bundleIdentifier ?? NSNull()
            return entry
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
