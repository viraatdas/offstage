import Foundation

// Wire protocol: JSON Lines over a unix socket, one request per connection.
// The daemon answers with zero or more event lines, then exactly one final
// line carrying "ok", then closes.

let PROTOCOL_VERSION = 1
let DAEMON_VERSION = "1"

/// Max bytes we will read for a single request line (spec: 1 MiB).
let MAX_REQUEST_BYTES = 1 << 20

enum ErrCode {
    static let badRequest = "bad-request"
    static let spawnFailed = "spawn-failed"
    static let tccScreenCapture = "tcc-screen-capture"
    static let tccAccessibility = "tcc-accessibility"
    static let notFound = "not-found"
    static let internalError = "internal"
}

/// A failure that becomes the final `{"ok":false,...}` line.
/// `extra` carries op-specific fields the spec puts alongside the error
/// (e.g. `performed` for `input`).
struct OpError: Error {
    let code: String
    let message: String
    var fix: String? = nil
    var extra: [String: Any] = [:]

    func finalLine() -> [String: Any] {
        var out: [String: Any] = ["ok": false, "error": message, "code": code]
        if let fix { out["fix"] = fix }
        for (k, v) in extra { out[k] = v }
        return out
    }
}

func badRequest(_ message: String, extra: [String: Any] = [:]) -> OpError {
    OpError(code: ErrCode.badRequest, message: message, fix: nil, extra: extra)
}

/// One client connection. Owns the fd and all writes to it.
///
/// Writes are best-effort: once the peer goes away (EPIPE / short write) we
/// latch `clientGone` and stop writing, which is how `run` learns it should
/// cancel the child. SIGPIPE is ignored process-wide so EPIPE surfaces as an
/// errno rather than killing the daemon.
final class Conn {
    let fd: Int32
    private(set) var clientGone = false

    init(fd: Int32) { self.fd = fd }

    /// Serialize and write one JSON line. Returns false if the peer is gone.
    @discardableResult
    func send(_ obj: [String: Any]) -> Bool {
        if clientGone { return false }
        guard var data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
            // Should not happen; if it does, tell the client something valid.
            let fallback = #"{"ok":false,"code":"internal","error":"failed to encode response"}"# + "\n"
            return writeAll(Data(fallback.utf8))
        }
        data.append(0x0A)
        return writeAll(data)
    }

    private func writeAll(_ data: Data) -> Bool {
        var sent = 0
        let total = data.count
        return data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Bool in
            guard let base = raw.baseAddress else { return true }
            while sent < total {
                let n = write(fd, base.advanced(by: sent), total - sent)
                if n > 0 { sent += n; continue }
                if n < 0 && errno == EINTR { continue }
                clientGone = true
                return false
            }
            return true
        }
    }

    /// Read one `\n`-terminated request, capped at MAX_REQUEST_BYTES.
    /// Returns nil on EOF before any newline.
    func readRequestLine() throws -> Data? {
        var buf = Data()
        var chunk = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n < 0 {
                if errno == EINTR { continue }
                return nil
            }
            if n == 0 { return buf.isEmpty ? nil : buf }
            for i in 0..<n {
                if chunk[i] == 0x0A { return buf }
                buf.append(chunk[i])
                if buf.count > MAX_REQUEST_BYTES {
                    throw badRequest("request larger than 1 MiB")
                }
            }
        }
    }

    func close() {
        _ = Darwin.close(fd)
    }
}

func logLine(_ s: String) {
    FileHandle.standardError.write(Data((s + "\n").utf8))
}
