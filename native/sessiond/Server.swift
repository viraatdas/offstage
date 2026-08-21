import Foundation

/// Dispatch one request. Ops either return the final line, throw an OpError,
/// or (only `run`, on client disconnect) return nil meaning "no final line,
/// nobody is listening".
func dispatch(_ req: [String: Any], _ conn: Conn) throws -> [String: Any]? {
    guard let op = req["op"] as? String else {
        throw badRequest("request is missing an \"op\" string")
    }
    switch op {
    case "hello": return try opHello(req)
    case "access": return try opAccess(req)
    case "run": return try opRun(req, conn)
    case "screenshot": return try opScreenshot(req)
    case "input": return try opInput(req)
    case "apps": return try opApps(req)
    case "request-permissions": return try opRequestPermissions(req)
    default: throw badRequest("unknown op '\(op)'")
    }
}

/// One request per connection: read a line, answer, close.
func handleConnection(_ fd: Int32) {
    let conn = Conn(fd: fd)
    defer { conn.close() }

    var op = "?"
    do {
        guard let line = try conn.readRequestLine() else {
            logLine("request op=? error=empty-request")
            return
        }
        guard let obj = try? JSONSerialization.jsonObject(with: line),
              let req = obj as? [String: Any] else {
            conn.send(badRequest("request is not a JSON object").finalLine())
            logLine("request op=? error=malformed-json")
            return
        }
        op = (req["op"] as? String) ?? "?"
        if let final = try dispatch(req, conn) {
            conn.send(final)
            let ok = (final["ok"] as? Bool) ?? false
            logLine("request op=\(op) ok=\(ok)")
        }
    } catch let e as OpError {
        conn.send(e.finalLine())
        logLine("request op=\(op) ok=false code=\(e.code) error=\(e.message)")
    } catch {
        let e = OpError(code: ErrCode.internalError, message: "\(error)")
        conn.send(e.finalLine())
        logLine("request op=\(op) ok=false code=internal error=\(error)")
    }
}
