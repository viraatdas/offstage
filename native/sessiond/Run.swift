import Foundation

/// PATH used when the request does not supply one. The daemon's own PATH
/// comes from launchd and is deliberately minimal.
let DEFAULT_PATH = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

/// Grace period between SIGTERM and SIGKILL for a timed-out child.
let KILL_GRACE_SECONDS: Double = 5

private let SIGNAL_NAMES: [Int32: String] = [
    SIGHUP: "SIGHUP", SIGINT: "SIGINT", SIGQUIT: "SIGQUIT", SIGILL: "SIGILL",
    SIGTRAP: "SIGTRAP", SIGABRT: "SIGABRT", SIGFPE: "SIGFPE", SIGKILL: "SIGKILL",
    SIGBUS: "SIGBUS", SIGSEGV: "SIGSEGV", SIGSYS: "SIGSYS", SIGPIPE: "SIGPIPE",
    SIGALRM: "SIGALRM", SIGTERM: "SIGTERM", SIGXCPU: "SIGXCPU", SIGXFSZ: "SIGXFSZ",
]

private func signalName(_ s: Int32) -> String { SIGNAL_NAMES[s] ?? "SIG\(s)" }

/// PATH lookup done here rather than via /usr/bin/env, because posix_spawnp
/// searches the *parent's* PATH, not the child environment's. Observable
/// behaviour is the spec's: "PATH lookup with the effective environment".
func resolveExecutable(_ name: String, path: String) -> String? {
    if name.contains("/") {
        return access(name, X_OK) == 0 ? name : nil
    }
    for dir in path.split(separator: ":", omittingEmptySubsequences: false) {
        let d = dir.isEmpty ? "." : String(dir)
        let candidate = (d as NSString).appendingPathComponent(name)
        var st = stat()
        if stat(candidate, &st) == 0, (st.st_mode & S_IFMT) == S_IFREG, access(candidate, X_OK) == 0 {
            return candidate
        }
    }
    return nil
}

/// Environment for the child: the daemon's own environment (it carries the
/// Aqua session's window-server bootstrap) overlaid with the request's, then
/// the invariants the spec fixes.
func childEnvironment(_ requested: [String: String]) -> [String: String] {
    var env = ProcessInfo.processInfo.environment
    for (k, v) in requested { env[k] = v }
    env.removeValue(forKey: "DISPLAY")
    env["HOME"] = identity.home
    env["USER"] = identity.name
    env["LOGNAME"] = identity.name
    env["TMPDIR"] = identity.tmpdir
    if requested["PATH"] == nil { env["PATH"] = DEFAULT_PATH }
    return env
}

private func cArray(_ items: [String]) -> [UnsafeMutablePointer<CChar>?] {
    items.map { strdup($0) } + [nil]
}

private func freeCArray(_ arr: [UnsafeMutablePointer<CChar>?]) {
    for p in arr where p != nil { free(p) }
}

func opRun(_ req: [String: Any], _ conn: Conn) throws -> [String: Any]? {
    guard let rawArgv = req["argv"] as? [Any], !rawArgv.isEmpty else {
        throw badRequest("run requires a non-empty \"argv\" array")
    }
    let argv = rawArgv.compactMap { $0 as? String }
    guard argv.count == rawArgv.count else {
        throw badRequest("run requires every argv entry to be a string")
    }
    var requestedEnv: [String: String] = [:]
    if let e = req["env"] as? [String: Any] {
        for (k, v) in e {
            guard let s = v as? String else { throw badRequest("env values must be strings (\(k) is not)") }
            requestedEnv[k] = s
        }
    } else if let e = req["env"], !(e is NSNull) {
        throw badRequest("env must be an object of string values")
    }
    var timeoutMs: Int? = nil
    if let t = req["timeoutMs"] as? NSNumber, !(req["timeoutMs"] is NSNull) {
        let v = t.intValue
        guard v > 0 else { throw badRequest("timeoutMs must be a positive integer") }
        timeoutMs = v
    }
    let cwd = req["cwd"] as? String

    let env = childEnvironment(requestedEnv)

    // Pre-flight cwd so an unreadable repo yields the share fix rather than a
    // bare posix_spawn errno.
    if let cwd {
        var st = stat()
        if stat(cwd, &st) != 0 {
            throw OpError(code: ErrCode.spawnFailed,
                          message: "cwd \(cwd): \(String(cString: strerror(errno)))")
        }
        if access(cwd, X_OK) != 0 || access(cwd, R_OK) != 0 {
            throw OpError(code: ErrCode.spawnFailed,
                          message: "cwd \(cwd): \(String(cString: strerror(EACCES)))",
                          fix: "offstage session share \(cwd)")
        }
    }

    guard let exePath = resolveExecutable(argv[0], path: env["PATH"] ?? DEFAULT_PATH) else {
        throw OpError(code: ErrCode.spawnFailed,
                      message: "\(argv[0]): command not found on PATH")
    }

    // One pipe for stdout and stderr so interleaving order is preserved.
    var fds: [Int32] = [-1, -1]
    guard pipe(&fds) == 0 else {
        throw OpError(code: ErrCode.internalError, message: "pipe() failed: \(String(cString: strerror(errno)))")
    }
    let readEnd = fds[0], writeEnd = fds[1]
    // The child gets stdio via dup2 only; it must not inherit the read end,
    // the client socket, or the listening socket.
    _ = fcntl(readEnd, F_SETFD, FD_CLOEXEC)

    var fileActions: posix_spawn_file_actions_t? = nil
    posix_spawn_file_actions_init(&fileActions)
    defer { posix_spawn_file_actions_destroy(&fileActions) }
    if let cwd {
        // _np spelling: present since 10.15, and still the portable one for
        // the older SDKs this source may be compiled against.
        posix_spawn_file_actions_addchdir_np(&fileActions, cwd)
    }
    posix_spawn_file_actions_addopen(&fileActions, 0, "/dev/null", O_RDONLY, 0)
    posix_spawn_file_actions_adddup2(&fileActions, writeEnd, 1)
    posix_spawn_file_actions_adddup2(&fileActions, writeEnd, 2)
    posix_spawn_file_actions_addclose(&fileActions, readEnd)
    posix_spawn_file_actions_addclose(&fileActions, writeEnd)

    var attrs: posix_spawnattr_t? = nil
    posix_spawnattr_init(&attrs)
    defer { posix_spawnattr_destroy(&attrs) }
    // Own session/process group, so a timeout can kill the whole tree.
    //
    // SETSIGMASK/SETSIGDEF are not optional here: connections are served on
    // libdispatch worker threads, which run with almost every signal blocked,
    // and both the signal mask and ignored dispositions are inherited across
    // exec. Without resetting them the child ignores the SIGTERM we send on
    // timeout and only dies to the SIGKILL five seconds later.
    var emptyMask = sigset_t()
    sigemptyset(&emptyMask)
    posix_spawnattr_setsigmask(&attrs, &emptyMask)
    var allSignals = sigset_t()
    sigfillset(&allSignals)
    posix_spawnattr_setsigdefault(&attrs, &allSignals)
    posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF))

    let cArgv = cArray(argv)
    let cEnv = cArray(env.map { "\($0.key)=\($0.value)" })
    defer { freeCArray(cArgv); freeCArray(cEnv) }

    var pid: pid_t = 0
    let started = Date()
    var argvPtr = cArgv
    var envPtr = cEnv
    let rc = posix_spawn(&pid, exePath, &fileActions, &attrs, &argvPtr, &envPtr)
    close(writeEnd)
    if rc != 0 {
        close(readEnd)
        var err = OpError(code: ErrCode.spawnFailed,
                          message: "\(argv[0]): \(String(cString: strerror(rc)))")
        if rc == EACCES, let cwd { err = OpError(code: ErrCode.spawnFailed, message: err.message, fix: "offstage session share \(cwd)") }
        throw err
    }

    conn.send(["event": "started", "pid": Int(pid)])

    let deadline = timeoutMs.map { started.addingTimeInterval(Double($0) / 1000.0) }
    var timedOut = false
    var killDeadline: Date? = nil
    var clientGone = false

    var buf = [UInt8](repeating: 0, count: 64 * 1024)
    var eof = false

    while !eof {
        var pfds = [
            pollfd(fd: readEnd, events: Int16(POLLIN), revents: 0),
            pollfd(fd: conn.fd, events: Int16(POLLIN), revents: 0),
        ]
        // Wake at whichever comes first: the timeout, the SIGKILL escalation,
        // or 250 ms (so a deadline that passes while idle is still noticed).
        var waitMs: Int32 = 250
        let now = Date()
        for d in [deadline, killDeadline].compactMap({ $0 }) {
            let ms = Int32(max(0, min(250, (d.timeIntervalSince(now) * 1000).rounded())))
            waitMs = min(waitMs, ms)
        }
        let ready = poll(&pfds, 2, waitMs)
        if ready < 0 && errno != EINTR { break }

        if ready > 0 && (pfds[1].revents & Int16(POLLIN | POLLHUP | POLLERR)) != 0 {
            // The client only ever sends one line; anything here (including
            // EOF) means it has gone away. Treat it as cancellation.
            var probe = [UInt8](repeating: 0, count: 1)
            let n = read(conn.fd, &probe, 1)
            if n <= 0 { clientGone = true }
        }

        if ready > 0 && (pfds[0].revents & Int16(POLLIN | POLLHUP | POLLERR)) != 0 {
            let n = buf.withUnsafeMutableBytes { read(readEnd, $0.baseAddress, $0.count) }
            if n > 0 {
                let data = Data(bytes: buf, count: n)
                if !conn.send(["event": "output", "data": data.base64EncodedString()]) {
                    clientGone = true
                }
            } else if n == 0 {
                eof = true
            } else if errno != EINTR && errno != EAGAIN {
                eof = true
            }
        }

        if clientGone {
            // Nobody is listening: same kill sequence, then no final line.
            killpg(pid, SIGTERM)
            let until = Date().addingTimeInterval(KILL_GRACE_SECONDS)
            while Date() < until {
                var status: Int32 = 0
                if waitpid(pid, &status, WNOHANG) == pid { break }
                usleep(50_000)
            }
            killpg(pid, SIGKILL)
            var status: Int32 = 0
            _ = waitpid(pid, &status, 0)
            close(readEnd)
            logLine("run pid=\(pid) cancelled (client disconnected)")
            return nil
        }

        if let d = deadline, !timedOut, Date() >= d {
            timedOut = true
            killpg(pid, SIGTERM)
            killDeadline = Date().addingTimeInterval(KILL_GRACE_SECONDS)
        }
        if let k = killDeadline, Date() >= k {
            killpg(pid, SIGKILL)
            killDeadline = nil
        }
    }

    close(readEnd)

    var status: Int32 = 0
    while waitpid(pid, &status, 0) < 0 && errno == EINTR {}
    let durationMs = Int((Date().timeIntervalSince(started) * 1000).rounded())

    var exitCode: Any = NSNull()
    var signal: Any = NSNull()
    if (status & 0x7f) == 0 {
        exitCode = Int((status >> 8) & 0xff)
    } else {
        signal = signalName(status & 0x7f)
    }
    // A timed-out child is reported as exitCode null even if it happened to
    // exit cleanly during the grace period.
    if timedOut { exitCode = NSNull() }

    logLine("run pid=\(pid) argv0=\(argv[0]) exit=\(exitCode) signal=\(signal) timedOut=\(timedOut) durationMs=\(durationMs)")

    return [
        "ok": true,
        "exitCode": exitCode,
        "signal": signal,
        "timedOut": timedOut,
        "durationMs": durationMs,
    ]
}
