import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

// Windows that land on a display the capture does not include.
//
// The helper account shares the Mac's physical displays. `screenshot` runs
// `/usr/sbin/screencapture`, which captures the MAIN display only, and `input`
// coordinates are main-display points. An app is free to open its window on
// any display, and a SwiftUI WindowGroup app does: measured on a machine with
// a 1728x1117pt main display and a 1920-wide second display at x=-1920,
// i2Message's only window came up at {x:-1920, y:67, w:1920, h:1050}. Every
// screenshot showed an empty desktop and the window was unreachable by input.
//
// `gather-windows` moves such windows onto the main display through
// Accessibility (kAXPositionAttribute / kAXSizeAttribute), the same grant
// `input` already needs. The fix was verified by a standalone binary run as a
// child of this daemon in the real helper session; this op is that binary's
// logic behind the socket.

/// The main display's bounds in global points (origin top-left of main).
func mainDisplayBounds() -> CGRect {
    CGDisplayBounds(CGMainDisplayID())
}

func frameDict(_ r: CGRect) -> [String: Any] {
    [
        "x": Double(r.origin.x),
        "y": Double(r.origin.y),
        "w": Double(r.size.width),
        "h": Double(r.size.height),
    ]
}

/// Where a gathered window goes: the main display's top-left, 30pt down so the
/// title bar clears the menu bar, shrunk to fit when it is larger than the
/// display (40pt of height is left for the menu bar and a margin).
/// Pure, so the arithmetic is readable on its own.
func gatherTarget(for frame: CGRect, main: CGRect) -> CGRect {
    let width = min(frame.width, main.width)
    let height = min(frame.height, max(main.height - 40, 1))
    return CGRect(x: main.minX, y: main.minY + 30, width: width, height: height)
}

func axFrame(of window: AXUIElement) -> CGRect? {
    var posRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &posRef) == .success,
          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let posRef, let sizeRef,
          CFGetTypeID(posRef) == AXValueGetTypeID(),
          CFGetTypeID(sizeRef) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(posRef as! AXValue, .cgPoint, &point),
          AXValueGetValue(sizeRef as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

// MARK: - gather-windows

func opGatherWindows(_ req: [String: Any]) throws -> [String: Any] {
    guard let n = req["pid"] as? NSNumber, n.intValue > 0, n.intValue <= Int(Int32.max) else {
        throw badRequest("gather-windows requires a positive integer \"pid\"")
    }
    let pid = pid_t(n.intValue)

    // Fail closed: without Accessibility the AX calls below would all fail
    // (or, worse, prompt). Say so the same way `input` does.
    guard AXIsProcessTrusted() else {
        throw OpError(code: ErrCode.tccAccessibility,
                      message: "accessibility permission is not granted to offstage-sessiond in the \(identity.name) session",
                      fix: accessibilityFix())
    }
    guard kill(pid, 0) == 0 || errno == EPERM else {
        throw OpError(code: ErrCode.notFound, message: "no process with pid \(pid) in this session")
    }

    let main = mainDisplayBounds()
    var out: [String: Any] = [
        "ok": true,
        "pid": Int(pid),
        "mainDisplay": frameDict(main),
    ]

    let app = AXUIElementCreateApplication(pid)
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    guard err == .success, let windows = value as? [AXUIElement] else {
        // Right after launch an app often answers cannotComplete / noValue
        // until its UI is up. That is "no windows yet", not a failure: the
        // host polls. The raw AXError is reported for diagnosis.
        out["windows"] = [[String: Any]]()
        out["axError"] = Int(err.rawValue)
        return out
    }

    var entries: [[String: Any]] = []
    for window in windows {
        guard let before = axFrame(of: window) else {
            entries.append([
                "before": NSNull(), "after": NSNull(), "moved": false,
                "error": "could not read the window's position and size",
            ])
            continue
        }
        if before.intersects(main) {
            entries.append(["before": frameDict(before), "after": NSNull(), "moved": false])
            continue
        }

        let target = gatherTarget(for: before, main: main)
        var point = target.origin
        var size = target.size
        var entry: [String: Any] = ["before": frameDict(before)]
        var errors: [String] = []
        if let pv = AXValueCreate(.cgPoint, &point) {
            let e = AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, pv)
            if e != .success { errors.append("setting position failed (AXError \(e.rawValue))") }
        } else {
            errors.append("could not build the position value")
        }
        // Size only when it has to shrink: the reference binary always set
        // it, but leaving a fitting window's size alone is one fewer AX call
        // that an app can refuse.
        if size.width != before.width || size.height != before.height {
            if let sv = AXValueCreate(.cgSize, &size) {
                let e = AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, sv)
                if e != .success { errors.append("setting size failed (AXError \(e.rawValue))") }
            } else {
                errors.append("could not build the size value")
            }
        }

        let after = axFrame(of: window)
        entry["after"] = after.map(frameDict) ?? NSNull()
        // Moved means it now intersects the captured display, which is the
        // only thing the caller cares about.
        entry["moved"] = after?.intersects(main) ?? false
        if !errors.isEmpty { entry["error"] = errors.joined(separator: "; ") }
        entries.append(entry)
    }
    out["windows"] = entries
    return out
}

// MARK: - off-display windows (for screenshot)

/// On-screen, layer-0 (normal) windows whose bounds do not intersect the main
/// display: windows a main-display capture cannot show. Read from the window
/// server, so it needs no Accessibility; window titles need Screen Recording,
/// which `screenshot` has already checked for.
func offDisplayWindows() -> [[String: Any]] {
    let opts: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    let main = mainDisplayBounds()
    let me = getpid()
    var out: [[String: Any]] = []
    for w in list {
        guard let layer = w[kCGWindowLayer as String] as? Int, layer == 0 else { continue }
        guard let pid = w[kCGWindowOwnerPID as String] as? pid_t, pid != me else { continue }
        guard let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
        // Zero-area windows (invisible helpers) are not something anyone can see anywhere.
        if bounds.width < 1 || bounds.height < 1 { continue }
        if bounds.intersects(main) { continue }
        out.append([
            "pid": Int(pid),
            "owner": (w[kCGWindowOwnerName as String] as? String) ?? NSNull(),
            "name": (w[kCGWindowName as String] as? String) ?? NSNull(),
            "bounds": frameDict(bounds),
        ])
    }
    return out
}
