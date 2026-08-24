import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

// Synthetic input for this session only.
//
// Three ways exist to inject a CGEvent, and only one of them works from a
// background session. Measured on this machine against the window server's own
// delivery log:
//
//   .cghidEventTap    the global hardware entry point. The window server routes
//                     it to whichever session is ON THE CONSOLE, which is the
//                     user's own screen. Never correct from here, and actively
//                     dangerous: it types on the desktop we promised not to
//                     touch.
//   postToPid         delivers to a process's queue, bypassing the window
//                     server. Sounds right, is not: the window server logged
//                     ZERO deliveries for events posted this way, and nothing
//                     ever appeared in the target app. Events go into a void.
//   .cgSessionEventTap  the per-session entry point. Posted from a process
//                     inside session N, the event enters session N's stream and
//                     the window server routes it to that session's key window,
//                     confirmed in its log, delivered to the helper session's
//                     frontmost app, with nothing reaching the console session.
//
// So input is posted to the session event tap. Correct routing, real keyboard
// focus, real modifier handling, and no way to reach the user's display from a
// background session.
//
// The one case where the session tap WOULD reach the user's screen is if this
// daemon were running in the session that is currently on the console. That is
// refused outright rather than trusted not to happen: see `perform`.
//
// Coordinates are points in global display space, origin top-left of the main
// display: the same space hello.display describes.

/// The pid every synthetic event is delivered to: the frontmost app in *this*
/// session. `nil` when nothing is frontmost, or when it is the daemon itself
/// (posting to ourselves would do nothing useful).
func sessionTargetPid() -> pid_t? {
    // Window-server truth, not NSWorkspace's cache: see frontmostWindowPid().
    guard let pid = frontmostWindowPid() else { return nil }
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
/// action" wording: a malformed list performs nothing and reports
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

/// Post into THIS session's event stream. There is deliberately no parameter
/// selecting a different tap: the HID tap would reach the console session.
private func post(_ e: CGEvent?, flags: CGEventFlags = []) {
    guard let e else { return }
    // ALWAYS assign, including the empty set. A freshly created CGEvent picks
    // up the session's CURRENT modifier state, so an ambient or stuck modifier
    // silently rewrites every event we post: a plain "3" arrives as cmd+3, and
    // typed text arrives as a string of keyboard shortcuts. Assigning only when
    // the caller asked for modifiers (`if !flags.isEmpty`) leaves that state in
    // place and is how this was wrong. Observed live: Calculator switched to
    // Programmer mode instead of entering a digit.
    e.flags = flags
    e.post(tap: .cgSessionEventTap)
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

func perform(_ action: InputAction) throws {
    // A wait moves no cursor and presses no key, so it needs no target.
    if case let .wait(ms) = action {
        sleepMs(ms)
        return
    }
    // Resolve the delivery target once per action, from the session's current
    // frontmost app. A click that changes which app is frontmost is followed by
    // its own action anyway, so the next one re-resolves. No target means we
    // refuse: see the note at the top of this file on why there is no
    // HID-tap fallback.
    // Hard refusal, not a warning: posting into the session event tap while
    // this session is the one on the console would type on the user's real
    // screen. The lane's whole promise is that it cannot.
    guard !isOnConsole() else {
        throw OpError(
            code: ErrCode.onConsole,
            message: "refusing to inject input: the \(identity.name) session is currently on the console, so events would land on the user's screen",
            fix: "Switch back to your own account with fast user switching. The helper session keeps running in the background and input works again as soon as it is no longer on the console.")
    }
    guard sessionTargetPid() != nil else {
        throw OpError(
            code: ErrCode.noTarget,
            message: "no frontmost application in the \(identity.name) session to deliver input to",
            fix: "Start or focus an app in that session first (for example `offstage run --lane session -- open -a TextEdit`), then retry.")
    }
    switch action {
    case let .move(x, y):
        post(mouseEvent(.mouseMoved, x, y, .left))
    case let .click(x, y, button, count, flags):
        let (down, up, _) = downUpTypes(button)
        post(mouseEvent(.mouseMoved, x, y, button))
        for n in 1...count {
            if let e = mouseEvent(down, x, y, button) {
                e.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                post(e, flags: flags)
            }
            if let e = mouseEvent(up, x, y, button) {
                e.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                post(e, flags: flags)
            }
            if n < count { sleepMs(60) }
        }
    case let .drag(fx, fy, tx, ty, button):
        // A drag is a STREAM, not "down, jump, up": AppKit only begins
        // tracking once the app has entered its own mouse-tracking loop, and
        // decides what is happening from the events that follow. So this pauses
        // after the press, sends enough intermediate points to look like a real
        // gesture at roughly one step per frame, and pauses before the release.
        //
        // Honest status: dragging a window by its title bar in the helper
        // session has been seen to work and has also been seen to do nothing,
        // and an A/B against the previous timing (10 steps, 8 ms, no settle)
        // did not separate them. So this shape is a best effort on how AppKit
        // is documented to track drags, NOT a verified fix. `drag` is listed as
        // unverified end to end and should be treated as such.
        let (down, up, dragged) = downUpTypes(button)
        post(mouseEvent(.mouseMoved, fx, fy, button))
        sleepMs(30)
        post(mouseEvent(down, fx, fy, button))
        sleepMs(80)
        let steps = 24
        var lastX = fx, lastY = fy
        for s in 1...steps {
            let t = Double(s) / Double(steps)
            let x = fx + (tx - fx) * t
            let y = fy + (ty - fy) * t
            if let e = mouseEvent(dragged, x, y, button) {
                // Some views read the deltas rather than differencing the
                // positions themselves; without these the gesture reads as a
                // series of teleports.
                e.setDoubleValueField(.mouseEventDeltaX, value: x - lastX)
                e.setDoubleValueField(.mouseEventDeltaY, value: y - lastY)
                post(e)
            }
            lastX = x
            lastY = y
            sleepMs(16)
        }
        sleepMs(80)
        post(mouseEvent(up, tx, ty, button))
    case let .scroll(x, y, dx, dy):
        if let x, let y { post(mouseEvent(.mouseMoved, x, y, .left)) }
        // wheel1 = vertical, wheel2 = horizontal. dy is passed straight
        // through, so positive dy is what a natural trackpad swipe down does.
        let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
        post(e)
    case let .type(text):
        // One event per character, 2 ms apart.
        //
        // Packing several characters into a single keyboardSetUnicodeString
        // event is faster and works in an NSTextView, but it is not portable:
        // an app that reads only the first character of the event silently
        // swallows the rest. Observed live: typing "8675309" at Calculator
        // entered "8" and dropped the other six digits. One character per
        // event is what every app handles the same way.
        //
        // Grapheme clusters, not UTF-16 units, so an emoji or a combining
        // sequence is delivered whole rather than split into surrogate halves.
        for ch in text {
            var units = Array(String(ch).utf16)
            if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                post(down)
            }
            if let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                post(up)
            }
            sleepMs(2)
        }
    case let .key(code, flags):
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true) {
            post(down, flags: flags)
        }
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) {
            post(up, flags: flags)
        }
    case .wait:
        break  // handled above, before the target is resolved
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
    // Actions are performed in order; a failure part-way through reports how
    // many already landed, so the caller knows the session's real state.
    var performed = 0
    for a in actions {
        do {
            try perform(a)
        } catch var e as OpError {
            e.extra["performed"] = performed
            throw e
        }
        performed += 1
    }
    return ["ok": true, "performed": performed]
}
