/**
 * The session lane's host side.
 *
 * Three modules, one door:
 *
 * - `discover.ts` — which account, which uid, does it have a background GUI
 *   session, is the socket there. Pure parsers over `ioreg`/`dscl` text plus
 *   one exec seam.
 * - `client.ts` — the typed RPC client for `offstage-sessiond`.
 * - `setup.ts` — the LaunchAgent plist, the root install script, `swiftc`, and
 *   the `chmod +a` ACLs.
 *
 * Everything the CLI, the MCP server and the lane need is re-exported here, so
 * no consumer has to know which of the three a symbol lives in.
 */

export * from './discover.js';
export * from './client.js';
export * from './setup.js';

import { DEFAULT_SESSION_USER, DEFAULT_SOCKET_DIR } from './discover.js';
import { DAEMON_BINARY_NAME, DEFAULT_INSTALL_DIR, DEFAULT_LABEL } from './setup.js';

/**
 * The four values that describe a stock installation. Every one of them is
 * overridable — the account by `OFFSTAGE_SESSION_USER` or the config file, the
 * rest per call — but these are what `offstage session setup` writes and what
 * the lane assumes when nothing says otherwise.
 */
export const SESSION_DEFAULTS = {
  user: DEFAULT_SESSION_USER,
  socketDir: DEFAULT_SOCKET_DIR,
  label: DEFAULT_LABEL,
  installDir: DEFAULT_INSTALL_DIR,
  binaryName: DAEMON_BINARY_NAME,
} as const;
