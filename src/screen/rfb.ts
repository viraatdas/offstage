/**
 * A client for macOS Screen Sharing (`screensharingd`), spoken directly.
 *
 * offstage needs this because Apple's own client refuses to connect to its own
 * host — "You cannot control your own screen" — which rules it out for driving
 * a second session on the machine you are sitting at. The daemon has no such
 * policy and accepts loopback connections happily, so the way in is to speak
 * RFB ourselves.
 *
 * What the daemon offers on macOS 26.3 (`RFB 003.889`): security types
 * **30, 33, 36, 35**.
 *
 * - **30** is legacy Apple/ARD auth, implemented here and verified against a
 *   real daemon. It predates the session selectors, so a server authenticating
 *   it has nothing to read and falls back to *switching the console* to that
 *   user. That makes it useless for offstage's purpose and actively hostile to
 *   it: it takes the screen it is supposed to protect. It is implemented anyway
 *   because it is the only type we can currently complete, and because reaching
 *   the useful types means getting the framing right first.
 * - **33 / 35 / 36** are SASL SRP (RFC 5054 4096-bit, SHA-512, PBKDF2). Those
 *   carry the session selectors — `ConnectToVirtualDisplay` and friends — which
 *   is what a virtual display actually requires. Detected here, not yet spoken.
 *
 * See `docs/macos-sessions.md` for how this was established and why no cheaper
 * mechanism exists on macOS.
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';

/** Security types `screensharingd` advertises. */
export const SecurityType = {
  /** Legacy Apple/ARD: DH + AES-128-ECB. Drives the console — see the note above. */
  ARD: 30,
  /** SASL SRP. These carry the session selectors. */
  SRP_33: 33,
  SRP_35: 35,
  SRP_36: 36,
} as const;

export type SecurityTypeValue = (typeof SecurityType)[keyof typeof SecurityType];

/** The session a client may ask the server for, once it can speak SRP. */
export const SessionSelect = {
  ConnectToConsole: 'ConnectToConsole',
  RequestConsole: 'RequestConsole',
  /** The one offstage wants: a framebuffer and HID of its own. */
  ConnectToVirtualDisplay: 'ConnectToVirtualDisplay',
  DontConnectToVirtualDisplay: 'DontConnectToVirtualDisplay',
} as const;

/** Every SRP-based type, i.e. every type that can reach a virtual display. */
export const SRP_TYPES: readonly number[] = [
  SecurityType.SRP_33,
  SecurityType.SRP_35,
  SecurityType.SRP_36,
];

export class RfbProtocolError extends Error {}

/* -------------------------------------------------------------------------- */
/* handshake                                                                  */
/* -------------------------------------------------------------------------- */

/** `RFB 003.889\n` and friends. Twelve bytes, ASCII, newline-terminated. */
export function parseProtocolVersion(banner: Buffer): string {
  if (banner.length !== 12) {
    throw new RfbProtocolError(`protocol version must be 12 bytes, got ${banner.length}`);
  }
  const text = banner.toString('ascii');
  if (!/^RFB \d{3}\.\d{3}\n$/.test(text)) {
    throw new RfbProtocolError(`not an RFB banner: ${JSON.stringify(text)}`);
  }
  return text.trim();
}

/**
 * Pick the best security type on offer.
 *
 * Prefers SRP, because that is the only family that can request a virtual
 * display. Falls back to ARD only when asked to, since choosing it silently
 * would mean taking the user's console — the one thing offstage exists to
 * prevent.
 */
export function chooseSecurityType(
  offered: readonly number[],
  options: { allowConsoleTakeover?: boolean } = {},
): number {
  const srp = SRP_TYPES.find((type) => offered.includes(type));
  if (srp !== undefined) return srp;
  if (offered.includes(SecurityType.ARD)) {
    if (!options.allowConsoleTakeover) {
      throw new RfbProtocolError(
        'the server offers only legacy ARD auth (type 30), which switches the console to the ' +
          'authenticating user rather than creating a virtual display. Refusing: this would take ' +
          'the screen offstage exists to protect. Pass allowConsoleTakeover to override.',
      );
    }
    return SecurityType.ARD;
  }
  throw new RfbProtocolError(`no supported security type in [${offered.join(', ')}]`);
}

/* -------------------------------------------------------------------------- */
/* type 30 — Apple/ARD authentication                                         */
/* -------------------------------------------------------------------------- */

/** The Diffie-Hellman parameters the server opens type 30 with. */
export interface ArdChallenge {
  generator: number;
  keyLength: number;
  prime: Buffer;
  peerKey: Buffer;
}

/** Parse `generator:u16, keyLength:u16, prime[keyLength], peerKey[keyLength]`. */
export function parseArdChallenge(data: Buffer): ArdChallenge {
  if (data.length < 4) throw new RfbProtocolError('ARD challenge shorter than its header');
  const generator = data.readUInt16BE(0);
  const keyLength = data.readUInt16BE(2);
  const needed = 4 + keyLength * 2;
  if (data.length < needed) {
    throw new RfbProtocolError(`ARD challenge needs ${needed} bytes, got ${data.length}`);
  }
  return {
    generator,
    keyLength,
    prime: data.subarray(4, 4 + keyLength),
    peerKey: data.subarray(4 + keyLength, needed),
  };
}

/** Big-endian bytes to bigint. */
export function toBigInt(bytes: Buffer): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${bytes.toString('hex')}`);
}

/** bigint to fixed-width big-endian bytes, left-padded. */
export function fromBigInt(value: bigint, width: number): Buffer {
  const hex = value.toString(16).padStart(width * 2, '0');
  if (hex.length > width * 2) {
    throw new RfbProtocolError(`value does not fit in ${width} bytes`);
  }
  return Buffer.from(hex, 'hex');
}

/** Modular exponentiation. Square-and-multiply; the modulus here is 1024-bit. */
export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) return 0n;
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

/**
 * The AES key is the MD5 of the shared secret.
 *
 * MD5 is not a choice offstage gets to make — it is what the daemon does, and
 * a client that hashes differently simply fails to authenticate.
 */
export function ardAesKey(sharedSecret: Buffer): Buffer {
  return createHash('md5').update(sharedSecret).digest();
}

/**
 * The 128-byte credential block: username at offset 0, password at offset 64,
 * each NUL-terminated, every remaining byte random.
 *
 * The padding is random rather than zero because the block is encrypted ECB:
 * identical plaintext blocks would otherwise produce identical ciphertext and
 * leak the length of short credentials.
 */
export function ardCredentialBlock(
  username: string,
  password: string,
  fill: (size: number) => Buffer = randomBytes,
): Buffer {
  const user = Buffer.from(username, 'utf8');
  const pass = Buffer.from(password, 'utf8');
  if (user.length > 63) throw new RfbProtocolError('username must be at most 63 bytes');
  if (pass.length > 63) throw new RfbProtocolError('password must be at most 63 bytes');

  const block = fill(128);
  if (block.length !== 128) throw new RfbProtocolError('credential block must be 128 bytes');
  user.copy(block, 0);
  block[user.length] = 0;
  pass.copy(block, 64);
  block[64 + pass.length] = 0;
  return block;
}

/** AES-128-ECB, no padding — the block is already exactly 128 bytes. */
export function encryptArdCredentials(block: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]);
}

/** Everything the client sends for type 30, in order: credentials then public key. */
export function ardAuthResponse(
  challenge: ArdChallenge,
  username: string,
  password: string,
  privateKey: Buffer,
  fill: (size: number) => Buffer = randomBytes,
): Buffer {
  const prime = toBigInt(challenge.prime);
  const priv = toBigInt(privateKey);
  const publicKey = modPow(BigInt(challenge.generator), priv, prime);
  const shared = modPow(toBigInt(challenge.peerKey), priv, prime);

  const key = ardAesKey(fromBigInt(shared, challenge.keyLength));
  const encrypted = encryptArdCredentials(ardCredentialBlock(username, password, fill), key);
  return Buffer.concat([encrypted, fromBigInt(publicKey, challenge.keyLength)]);
}

/* -------------------------------------------------------------------------- */
/* post-auth                                                                  */
/* -------------------------------------------------------------------------- */

export interface ServerInit {
  width: number;
  height: number;
  name: string;
}

/**
 * `width:u16, height:u16, pixelFormat[16], nameLength:u32, name[nameLength]`.
 *
 * The dimensions are the diagnostic that matters: a framebuffer matching the
 * physical display means the connection landed on the console, not a virtual
 * display. That is how the type 30 console-takeover was identified.
 */
export function parseServerInit(data: Buffer): ServerInit {
  if (data.length < 24) throw new RfbProtocolError('ServerInit shorter than its fixed header');
  const width = data.readUInt16BE(0);
  const height = data.readUInt16BE(2);
  const nameLength = data.readUInt32BE(20);
  if (data.length < 24 + nameLength) {
    throw new RfbProtocolError(`ServerInit name needs ${nameLength} bytes`);
  }
  return { width, height, name: data.subarray(24, 24 + nameLength).toString('utf8') };
}

/* -------------------------------------------------------------------------- */
/* input                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `PointerEvent`: type 5, button mask, x, y.
 *
 * On a virtual display these reach that session's synthetic HID and nothing
 * else — which is the entire point of the exercise.
 */
export function pointerEvent(x: number, y: number, buttonMask = 0): Buffer {
  const buf = Buffer.alloc(6);
  buf.writeUInt8(5, 0);
  buf.writeUInt8(buttonMask, 1);
  buf.writeUInt16BE(x, 2);
  buf.writeUInt16BE(y, 4);
  return buf;
}

/** `KeyEvent`: type 4, down flag, two pad bytes, X11 keysym. */
export function keyEvent(keysym: number, down: boolean): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt8(4, 0);
  buf.writeUInt8(down ? 1 : 0, 1);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt32BE(keysym, 4);
  return buf;
}

/** `FramebufferUpdateRequest`: type 3, incremental flag, then the rectangle. */
export function framebufferUpdateRequest(
  x: number,
  y: number,
  width: number,
  height: number,
  incremental = false,
): Buffer {
  const buf = Buffer.alloc(10);
  buf.writeUInt8(3, 0);
  buf.writeUInt8(incremental ? 1 : 0, 1);
  buf.writeUInt16BE(x, 2);
  buf.writeUInt16BE(y, 4);
  buf.writeUInt16BE(width, 6);
  buf.writeUInt16BE(height, 8);
  return buf;
}

/** Printable ASCII maps to its own code point; that covers typing into a session. */
export function keysymForChar(char: string): number {
  const code = char.codePointAt(0);
  if (code === undefined) throw new RfbProtocolError('empty string has no keysym');
  if (code >= 0x20 && code <= 0x7e) return code;
  if (char === '\n' || char === '\r') return 0xff0d; // Return
  if (char === '\t') return 0xff09; // Tab
  if (char === '\b') return 0xff08; // BackSpace
  throw new RfbProtocolError(`no keysym mapping for ${JSON.stringify(char)}`);
}
