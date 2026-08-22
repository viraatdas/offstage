import Foundation
import Security

// The designated requirement, exported.
//
// A TCC grant (Screen Recording, Accessibility) is stored in the system
// database as a row keyed to a path, and that row carries a `csreq` BLOB — the
// binary's Designated Requirement in Security.framework's external
// representation. When something at that path later asks for the permission,
// tccd re-derives the running code's requirement and checks it against the
// stored blob; a mismatch means the grant silently does not apply.
//
// `offstage session setup` therefore needs this exact blob before any human
// ever approves anything: with it, setup can INSERT both rows itself (as root,
// when the invoking terminal holds Full Disk Access) so the helper session's
// daemon comes up already trusted, with no toggles and no prompts. The blob is
// printed as lowercase hex, ready to be pasted into a sqlite X'' literal.

/// Print the Designated Requirement of the signed binary at `path` as hex.
///
/// Runs entirely in-process on whatever code is handed to it: no socket, no
/// session, no side effects. Setup invokes it on the freshly compiled,
/// freshly signed daemon *before* installing it, so the rows it writes name
/// the same bytes launchd will start.
func printCsreq(path: String) -> Never {
    let url = URL(fileURLWithPath: path)
    var staticCode: SecStaticCode?
    var status = SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(), &staticCode)
    guard status == errSecSuccess, let code = staticCode else {
        die("cannot read code at \(path): OSStatus \(status)", code: 70)
    }

    var requirement: SecRequirement?
    status = SecCodeCopyDesignatedRequirement(code, SecCSFlags(), &requirement)
    guard status == errSecSuccess, let req = requirement else {
        die("no designated requirement for \(path): OSStatus \(status) — is it signed?", code: 70)
    }

    var data: CFData?
    status = SecRequirementCopyData(req, SecCSFlags(), &data)
    guard status == errSecSuccess, let blob = data as Data? else {
        die("cannot serialize the requirement for \(path): OSStatus \(status)", code: 70)
    }

    print(blob.map { String(format: "%02x", $0) }.joined())
    exit(0)
}
