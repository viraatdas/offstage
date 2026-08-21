import Foundation

// offstage-sessiond --uid <n> [--socket-dir <dir>] [--once]
//
// Lives inside one macOS Aqua session (normally a background helper account's)
// and lends that session out over a unix socket: run commands there, capture
// its framebuffer, inject into its HID stream. See docs/session-lane.md.

// EPIPE must surface as an errno on write(), not as a fatal signal: it is how
// `run` learns the client hung up.
signal(SIGPIPE, SIG_IGN)
// Children are reaped explicitly by `run`; nothing else spawns.

func die(_ message: String, code: Int32) -> Never {
    logLine("offstage-sessiond: \(message)")
    exit(code)
}

var wantUid: uid_t? = nil
var socketDir = "/tmp/offstage-session"
var once = false

var args = Array(CommandLine.arguments.dropFirst())
var i = 0
while i < args.count {
    switch args[i] {
    case "--uid":
        i += 1
        guard i < args.count, let v = UInt32(args[i]) else { die("--uid needs a numeric argument", code: 64) }
        wantUid = v
    case "--socket-dir":
        i += 1
        guard i < args.count else { die("--socket-dir needs an argument", code: 64) }
        socketDir = args[i]
    case "--once":
        once = true
    case "--version":
        print(DAEMON_VERSION)
        exit(0)
    case "--help", "-h":
        print("usage: offstage-sessiond --uid <n> [--socket-dir <dir>] [--once]")
        exit(0)
    default:
        die("unknown argument '\(args[i])'", code: 64)
    }
    i += 1
}

guard let wantUid else { die("--uid is required", code: 64) }

// Belt and braces: the LaunchAgent lives in the helper account's own
// ~/Library/LaunchAgents, but if it ever runs elsewhere, do nothing.
if getuid() != wantUid {
    logLine("offstage-sessiond: running as uid \(getuid()), expected \(wantUid); exiting")
    exit(0)
}

// The socket directory must be ours: never bind inside a directory someone
// else controls.
var dirStat = stat()
if stat(socketDir, &dirStat) != 0 {
    if mkdir(socketDir, 0o755) != 0 && errno != EEXIST {
        die("cannot create \(socketDir): \(String(cString: strerror(errno)))", code: 78)
    }
    chmod(socketDir, 0o755)
    if stat(socketDir, &dirStat) != 0 {
        die("cannot stat \(socketDir): \(String(cString: strerror(errno)))", code: 78)
    }
}
if (dirStat.st_mode & S_IFMT) != S_IFDIR {
    die("\(socketDir) exists and is not a directory", code: 78)
}
if dirStat.st_uid != getuid() {
    die("\(socketDir) is owned by uid \(dirStat.st_uid), not \(getuid()); refusing to bind there", code: 78)
}

let sockPath = (socketDir as NSString).appendingPathComponent("\(wantUid).sock")
guard sockPath.utf8.count < 104 else { die("socket path \(sockPath) is too long for sockaddr_un", code: 78) }
unlink(sockPath)   // a stale socket from a previous run

let listenFd = socket(AF_UNIX, SOCK_STREAM, 0)
guard listenFd >= 0 else { die("socket(): \(String(cString: strerror(errno)))", code: 70) }

var addr = sockaddr_un()
addr.sun_family = sa_family_t(AF_UNIX)
addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
withUnsafeMutablePointer(to: &addr.sun_path) { p in
    p.withMemoryRebound(to: CChar.self, capacity: 104) { dst in
        _ = strlcpy(dst, sockPath, 104)
    }
}
let bindResult = withUnsafePointer(to: &addr) { p in
    p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
        bind(listenFd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
}
guard bindResult == 0 else { die("bind(\(sockPath)): \(String(cString: strerror(errno)))", code: 70) }

// 0660, group staff (gid 20): anyone in staff on this machine can drive the
// session. That is the stated trust model of a single-user laptop.
chmod(sockPath, 0o660)
chown(sockPath, uid_t.max, 20)

_ = fcntl(listenFd, F_SETFD, FD_CLOEXEC)
guard listen(listenFd, 16) == 0 else { die("listen(): \(String(cString: strerror(errno)))", code: 70) }

logLine("offstage-sessiond: listening on \(sockPath) as uid \(getuid()) (\(identity.name)) pid \(getpid())")

if once {
    let fd = accept(listenFd, nil, nil)
    if fd >= 0 { _ = fcntl(fd, F_SETFD, FD_CLOEXEC); handleConnection(fd) }
    unlink(sockPath)
    exit(0)
}

// Each connection on its own queue; ops are independent and short.
let workers = DispatchQueue(label: "dev.offstage.sessiond.conn", attributes: .concurrent)
while true {
    let fd = accept(listenFd, nil, nil)
    if fd < 0 {
        if errno == EINTR || errno == ECONNABORTED { continue }
        die("accept(): \(String(cString: strerror(errno)))", code: 70)
    }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    workers.async { handleConnection(fd) }
}
