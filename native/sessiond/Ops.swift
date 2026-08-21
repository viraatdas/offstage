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

func opHello(_ req: [String: Any]) throws -> [String: Any] {
    let display = mainDisplayInfo()

    // CGSessionCopyCurrentDictionary() uses the double-S spelling
    // "kCGSSessionOnConsoleKey" in the returned dictionary; the documented
    // constant name is kCGSessionOnConsoleKey. Accept both.
    var onConsole = false
    var managerName = "Aqua"
    if let dict = CGSessionCopyCurrentDictionary() as? [String: Any] {
        let v = dict["kCGSSessionOnConsoleKey"] ?? dict["kCGSessionOnConsoleKey"]
        if let n = v as? NSNumber { onConsole = n.boolValue }
        if let m = dict["kCGSSessionManagerNameKey"] as? String { managerName = m }
    }

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

func opApps(_ req: [String: Any]) throws -> [String: Any] {
    let apps = NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .map { app -> [String: Any] in
            var entry: [String: Any] = [
                "pid": Int(app.processIdentifier),
                "active": app.isActive,
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
