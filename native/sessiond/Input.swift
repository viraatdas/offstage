import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

// Synthetic input for this session only.
//
// The hard-won detail: a background (non-console) session cannot be driven
// through the global HID event tap. `CGEvent.post(tap: .cghidEventTap)` hands
// the event to the window server, which routes it to whichever session is on
// the console — the user's, not ours — so from a background session it lands
// nowhere useful (verified live: cmd+space opened no Spotlight, keystrokes
// reached no TextEdit). The event has to be delivered straight to a process
// instead, with `CGEvent.postToPid`, which bypasses session routing entirely.
//
// So every event here is posted to the session's frontmost application's pid.
// That is exactly the target a screenshot→click→type agent loop wants: the app
// it just brought to the front. When no frontmost app can be resolved we fall
// back to the HID tap rather than drop the event.
//
// Coordinates are points in global display space, origin top-left of the main
// display — the same space hello.display describes.

/// The pid every synthetic event is delivered to: the frontmost app in *this*
/// session. `nil` when nothing is frontmost, or when it is the daemon itself
/// (posting to ourselves would do nothing useful).
func sessionTargetPid() -> pid_t? {
    guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
    let pid = app.processIdentifier
    if pid == getpid() { return nil }
    return pid
}

/// US-layout virtual keycodes. Only the keys the spec names are present;
/// anything else is a bad-request rather than a guess.
let KEYCODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44,
    "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36,
    "tab": 48, "space": 49,
    "backspace": 51, "delete": 51,
    "escape": 53, "esc": 53,
    "forwarddelete": 117,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
    "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "home": 115, "pageup": 116, "end": 119, "pagedown": 121,
    "left": 123, "right": 124, "down": 125, "up": 126,
]

let MODIFIERS: [String: CGEventFlags] = [
    "cmd": .maskCommand, "command": .maskCommand,
    "ctrl": .maskControl, "control": .maskControl,
    "alt": .maskAlternate, "opt": .maskAlternate, "option": .maskAlternate,
    "shift": .maskShift,
    "fn": .maskSecondaryFn,
]

/// A validated action. The request is parsed into these *in full* before any
/// event is posted (see README: this refines the spec's "first failing
/// action" wording — a malformed list performs nothing and reports
/// performed: 0, which is the safer behaviour for injected input).
enum InputAction {
    case move(x: Double, y: Double)
    case click(x: Double, y: Double, button: CGMouseButton, count: Int, flags: CGEventFlags)
    case drag(fromX: Double, fromY: Double, toX: Double, toY: Double, button: CGMouseButton)
    case scroll(x: Double?, y: Double?, dx: Int32, dy: Int32)
    case type(text: String)
    case key(code: CGKeyCode, flags: CGEventFlags)
    case wait(ms: Int)
}

private func num(_ v: Any?) -> Double? {
    if let n = v as? NSNumber, !(v is NSNull) { return n.doubleValue }
    return nil
}

private func parseModifiers(_ v: Any?, _ index: Int) throws -> CGEventFlags {
    guard let v, !(v is NSNull) else { return [] }
    guard let list = v as? [Any] else { throw badRequest("action \(index): modifiers must be an array of strings", extra: ["performed": 0]) }
    var flags: CGEventFlags = []
    for m in list {
        guard let s = m as? String, let f = MODIFIERS[s.lowercased()] else {
            throw badRequest("action \(index): unknown modifier '\(m)'", extra: ["performed": 0])
        }
        flags.insert(f)
    }
    return flags
}

private func parseButton(_ v: Any?, _ index: Int) throws -> CGMouseButton {
    guard let v, !(v is NSNull) else { return .left }
    guard let s = v as? String else { throw badRequest("action \(index): button must be a string", extra: ["performed": 0]) }
    switch s.lowercased() {
    case "left": return .left
    case "right": return .right
    case "middle", "center": return .center
    default: throw badRequest("action \(index): unknown button '\(s)'", extra: ["performed": 0])
    }
}

/// `[modifier+]*name`, e.g. "cmd+shift+t". A trailing "+" means the key
/// itself is "+" (i.e. shift+"=" on a US layout).
func parseKeyCombo(_ combo: String, _ index: Int) throws -> (CGKeyCode, CGEventFlags) {
    var parts = combo.split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    var flags: CGEventFlags = []
    var name: String
    if parts.count > 1 && parts[parts.count - 1].isEmpty {
        parts.removeLast()
        name = "+"
    } else {
        name = parts.removeLast().lowercased()
    }
    if name == "+" {
        flags.insert(.maskShift)
        name = "="
    }
    guard !name.isEmpty else { throw badRequest("action \(index): empty key", extra: ["performed": 0]) }
    for m in parts {
        guard let f = MODIFIERS[m.lowercased()] else {
            throw badRequest("action \(index): unknown modifier '\(m)'", extra: ["performed": 0])
        }
        flags.insert(f)
    }
    guard let code = KEYCODES[name] else {
        throw badRequest("action \(index): unknown key '\(name)'", extra: ["performed": 0])
    }
    return (code, flags)
}

func parseActions(_ raw: [Any]) throws -> [InputAction] {
    var out: [InputAction] = []
    for (i, item) in raw.enumerated() {
        guard let a = item as? [String: Any] else {
            throw badRequest("action \(i): must be an object", extra: ["performed": 0])
        }
        guard let type = a["type"] as? String else {
            throw badRequest("action \(i): missing \"type\"", extra: ["performed": 0])
        }
        switch type {
        case "move":
            guard let x = num(a["x"]), let y = num(a["y"]) else {
                throw badRequest("action \(i): move requires numeric x and y", extra: ["performed": 0])
            }
            out.append(.move(x: x, y: y))
        case "click":
            guard let x = num(a["x"]), let y = num(a["y"]) else {
                throw badRequest("action \(i): click requires numeric x and y", extra: ["performed": 0])
            }
            let button = try parseButton(a["button"], i)
            let flags = try parseModifiers(a["modifiers"], i)
            var count = 1
            if let c = num(a["count"]) {
                count = Int(c)
                guard count >= 1 && count <= 5 else {
                    throw badRequest("action \(i): count must be between 1 and 5", extra: ["performed": 0])
                }
            }
            out.append(.click(x: x, y: y, button: button, count: count, flags: flags))
        case "drag":
            guard let fx = num(a["fromX"]), let fy = num(a["fromY"]),
                  let tx = num(a["toX"]), let ty = num(a["toY"]) else {
                throw badRequest("action \(i): drag requires numeric fromX, fromY, toX, toY", extra: ["performed": 0])
            }
            out.append(.drag(fromX: fx, fromY: fy, toX: tx, toY: ty, button: try parseButton(a["button"], i)))
        case "scroll":
            let dx = num(a["dx"]) ?? 0
            let dy = num(a["dy"]) ?? 0
            out.append(.scroll(x: num(a["x"]), y: num(a["y"]), dx: Int32(dx), dy: Int32(dy)))
        case "type":
            guard let text = a["text"] as? String else {
                throw badRequest("action \(i): type requires a \"text\" string", extra: ["performed": 0])
            }
            out.append(.type(text: text))
        case "key":
            guard let combo = a["key"] as? String, !combo.isEmpty else {
                throw badRequest("action \(i): key requires a \"key\" string", extra: ["performed": 0])
            }
            let (code, flags) = try parseKeyCombo(combo, i)
            out.append(.key(code: code, flags: flags))
        case "wait":
            guard let ms = num(a["ms"]) else {
                throw badRequest("action \(i): wait requires numeric ms", extra: ["performed": 0])
            }
            guard ms >= 0 && ms <= 10_000 else {
                throw badRequest("action \(i): wait ms must be between 0 and 10000", extra: ["performed": 0])
            }
            out.append(.wait(ms: Int(ms)))
        default:
            throw badRequest("action \(i): unknown action type '\(type)'", extra: ["performed": 0])
        }
    }
    return out
}

private func post(_ e: CGEvent?, flags: CGEventFlags = [], pid: pid_t? = nil) {
    guard let e else { return }
    if !flags.isEmpty { e.flags = flags }
    if let pid {
        e.postToPid(pid)
    } else {
        e.post(tap: .cghidEventTap)
    }
}

private func mouseEvent(_ type: CGEventType, _ x: Double, _ y: Double, _ button: CGMouseButton) -> CGEvent? {
    CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: button)
}

private func downUpTypes(_ b: CGMouseButton) -> (CGEventType, CGEventType, CGEventType) {
    switch b {
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case .center: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

private func sleepMs(_ ms: Int) {
    if ms > 0 { usleep(UInt32(ms) * 1000) }
}

func perform(_ action: InputAction) {
    // Resolve the delivery target once per action, from the session's current
    // frontmost app. A click that changes which app is frontmost is followed by
    // its own action anyway, so the next one re-resolves.
    let pid = sessionTargetPid()
    switch action {
    case let .move(x, y):
        post(mouseEvent(.mouseMoved, x, y, .left), pid: pid)
    case let .click(x, y, button, count, flags):
        let (down, up, _) = downUpTypes(button)
        post(mouseEvent(.mouseMoved, x, y, button), pid: pid)
        for n in 1...count {
            if let e = mouseEvent(down, x, y, button) {
                e.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                post(e, flags: flags, pid: pid)
            }
            if let e = mouseEvent(up, x, y, button) {
                e.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                post(e, flags: flags, pid: pid)
            }
            if n < count { sleepMs(60) }
        }
    case let .drag(fx, fy, tx, ty, button):
        let (down, up, dragged) = downUpTypes(button)
        post(mouseEvent(.mouseMoved, fx, fy, button), pid: pid)
        post(mouseEvent(down, fx, fy, button), pid: pid)
        // A few interpolated points: a single jump is often ignored by AppKit
        // drag tracking.
        let steps = 10
        for s in 1...steps {
            let t = Double(s) / Double(steps)
            post(mouseEvent(dragged, fx + (tx - fx) * t, fy + (ty - fy) * t, button), pid: pid)
            sleepMs(8)
        }
        post(mouseEvent(up, tx, ty, button), pid: pid)
    case let .scroll(x, y, dx, dy):
        if let x, let y { post(mouseEvent(.mouseMoved, x, y, .left), pid: pid) }
        // wheel1 = vertical, wheel2 = horizontal. dy is passed straight
        // through, so positive dy is what a natural trackpad swipe down does.
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        post(e, pid: pid)
    case let .type(text):
        // keyboardSetUnicodeString in <=20 UTF-16 unit chunks, 2 ms apart:
        // longer strings get dropped by the window server.
        let units = Array(text.utf16)
        var i = 0
        while i < units.count {
            let end = min(i + 20, units.count)
            var chunk = Array(units[i..<end])
            if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
                down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                post(down, pid: pid)
            }
            if let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                post(up, pid: pid)
            }
            i = end
            sleepMs(2)
        }
    case let .key(code, flags):
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
            post(down, flags: flags, pid: pid)
        }
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
            post(up, flags: flags, pid: pid)
        }
    case let .wait(ms):
        sleepMs(ms)
    }
}

func opInput(_ req: [String: Any]) throws -> [String: Any] {
    // Permission check comes BEFORE validation, per spec: a daemon without
    // Accessibility can post nothing, so that is the more useful answer.
    guard AXIsProcessTrusted() else {
        throw OpError(code: ErrCode.tccAccessibility,
                      message: "accessibility permission is not granted to offstage-sessiond in the \(identity.name) session",
                      fix: accessibilityFix(),
                      extra: ["performed": 0])
    }
    guard let raw = req["actions"] as? [Any] else {
        throw badRequest("input requires an \"actions\" array", extra: ["performed": 0])
    }
    let actions = try parseActions(raw)   // all-or-nothing validation
    for a in actions { perform(a) }
    return ["ok": true, "performed": actions.count]
}
