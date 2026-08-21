/**
 * The Screen Sharing client, tested without a daemon.
 *
 * The interesting test is the last one: it plays the server, performs its own
 * half of the Diffie-Hellman exchange, and decrypts what the client sent. That
 * proves the whole authentication path — key agreement, MD5 derivation, block
 * layout, ECB encryption — without needing a machine to authenticate against,
 * which matters because the only real server available is the developer's own
 * console and connecting to it takes their screen.
 */

import { createDecipheriv, createHash, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  RfbProtocolError,
  SRP_TYPES,
  SecurityType,
  SessionSelect,
  ardAesKey,
  ardAuthResponse,
  ardCredentialBlock,
  chooseSecurityType,
  encryptArdCredentials,
  framebufferUpdateRequest,
  fromBigInt,
  keyEvent,
  keysymForChar,
  modPow,
  parseArdChallenge,
  parseProtocolVersion,
  parseServerInit,
  pointerEvent,
  toBigInt,
} from '../src/screen/rfb.js';

describe('protocol version', () => {
  it('accepts what macOS actually sends', () => {
    expect(parseProtocolVersion(Buffer.from('RFB 003.889\n', 'ascii'))).toBe('RFB 003.889');
  });

  it('rejects a short read rather than guessing', () => {
    expect(() => parseProtocolVersion(Buffer.from('RFB 003.8', 'ascii'))).toThrow(/12 bytes/);
  });

  it('rejects something that is not an RFB banner', () => {
    // Exactly 12 bytes, so it reaches the format check rather than the length one.
    expect(() => parseProtocolVersion(Buffer.from('HTTP/1.1 20\n', 'ascii'))).toThrow(/not an RFB/);
  });
});

describe('choosing a security type', () => {
  const macos = [30, 33, 36, 35];

  it('prefers SRP, because only SRP can request a virtual display', () => {
    expect(SRP_TYPES).toContain(chooseSecurityType(macos));
    expect(chooseSecurityType(macos)).not.toBe(SecurityType.ARD);
  });

  it('refuses a server offering only ARD, because accepting takes the console', () => {
    // This is the safety property. Type 30 authenticates fine and then switches
    // the console to the authenticating user — the exact harm offstage exists
    // to prevent, so it cannot be the silent fallback.
    expect(() => chooseSecurityType([SecurityType.ARD])).toThrow(/switches the console/);
  });

  it('allows ARD only when the caller says so explicitly', () => {
    expect(chooseSecurityType([SecurityType.ARD], { allowConsoleTakeover: true })).toBe(30);
  });

  it('says what it saw when nothing is usable', () => {
    expect(() => chooseSecurityType([1, 2])).toThrow(/\[1, 2\]/);
  });
});

describe('big-endian bigint conversion', () => {
  it('round-trips', () => {
    const value = 0xdeadbeefcafen;
    expect(toBigInt(fromBigInt(value, 16))).toBe(value);
  });

  it('left-pads to the fixed width the protocol requires', () => {
    expect(fromBigInt(1n, 4)).toEqual(Buffer.from([0, 0, 0, 1]));
  });

  it('refuses to silently truncate an oversized value', () => {
    expect(() => fromBigInt(0x1_0000n, 2)).toThrow(/does not fit/);
  });

  it('treats an empty buffer as zero', () => {
    expect(toBigInt(Buffer.alloc(0))).toBe(0n);
  });
});

describe('modPow', () => {
  it('agrees with the schoolbook answer', () => {
    expect(modPow(4n, 13n, 497n)).toBe(445n);
  });

  it('handles the exponent-zero and modulus-one edges', () => {
    expect(modPow(7n, 0n, 13n)).toBe(1n);
    expect(modPow(7n, 5n, 1n)).toBe(0n);
  });

  it('is usable at the 1024-bit size the daemon negotiates', () => {
    const prime = toBigInt(randomBytes(128)) | 1n;
    const result = modPow(2n, toBigInt(randomBytes(128)), prime);
    expect(result).toBeLessThan(prime);
  });
});

describe('the ARD credential block', () => {
  const fixedFill = (n: number) => Buffer.alloc(n, 0xaa);

  it('puts the username at 0 and the password at 64, each NUL-terminated', () => {
    const block = ardCredentialBlock('alice', 'hunter2', fixedFill);

    expect(block).toHaveLength(128);
    expect(block.subarray(0, 5).toString()).toBe('alice');
    expect(block[5]).toBe(0);
    expect(block.subarray(64, 71).toString()).toBe('hunter2');
    expect(block[71]).toBe(0);
  });

  it('leaves the rest of each half as fill, not zeroes', () => {
    // Zero padding under ECB would make short credentials recognisable by
    // producing identical ciphertext blocks.
    const block = ardCredentialBlock('a', 'b', fixedFill);
    expect(block[10]).toBe(0xaa);
    expect(block[100]).toBe(0xaa);
  });

  it('refuses credentials that would overflow their half of the block', () => {
    expect(() => ardCredentialBlock('x'.repeat(64), 'p')).toThrow(/at most 63/);
    expect(() => ardCredentialBlock('u', 'p'.repeat(64))).toThrow(/at most 63/);
  });
});

describe('the ARD challenge', () => {
  it('parses generator, key length, prime and peer key', () => {
    const body = Buffer.concat([
      Buffer.from([0x00, 0x02, 0x00, 0x04]),
      Buffer.from([1, 2, 3, 4]),
      Buffer.from([5, 6, 7, 8]),
    ]);

    const challenge = parseArdChallenge(body);
    expect(challenge.generator).toBe(2);
    expect(challenge.keyLength).toBe(4);
    expect([...challenge.prime]).toEqual([1, 2, 3, 4]);
    expect([...challenge.peerKey]).toEqual([5, 6, 7, 8]);
  });

  it('refuses a truncated challenge rather than reading past the end', () => {
    const short = Buffer.concat([Buffer.from([0x00, 0x02, 0x00, 0x40]), Buffer.alloc(8)]);
    expect(() => parseArdChallenge(short)).toThrow(/needs 132 bytes/);
  });
});

describe('the full type 30 exchange', () => {
  it('produces credentials the server can decrypt with the shared secret', () => {
    // Play the server: pick a prime and a private key, and see whether what the
    // client sends back decrypts to the credentials we expect.
    const generator = 2n;
    // A known 128-bit safe-ish prime is enough to exercise the arithmetic; the
    // wire sizes are covered separately.
    const prime = 0xffffffffffffffffffffffffffffff61n;
    const width = 16;

    const serverPriv = toBigInt(randomBytes(width)) % prime;
    const serverPub = modPow(generator, serverPriv, prime);

    const challenge = parseArdChallenge(
      Buffer.concat([
        Buffer.from([0x00, 0x02]),
        Buffer.from([0x00, width]),
        fromBigInt(prime, width),
        fromBigInt(serverPub, width),
      ]),
    );

    const clientPriv = randomBytes(width);
    const response = ardAuthResponse(challenge, 'computeruse', 's3cret', clientPriv);

    expect(response).toHaveLength(128 + width);
    const encrypted = response.subarray(0, 128);
    const clientPub = toBigInt(response.subarray(128));

    // Server side of the agreement.
    const shared = modPow(clientPub, serverPriv, prime);
    const key = createHash('md5').update(fromBigInt(shared, width)).digest();

    const decipher = createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    expect(plain.subarray(0, 11).toString()).toBe('computeruse');
    expect(plain[11]).toBe(0);
    expect(plain.subarray(64, 70).toString()).toBe('s3cret');
    expect(plain[70]).toBe(0);
  });

  it('derives the AES key as MD5 of the shared secret, which is not negotiable', () => {
    const secret = Buffer.from('shared', 'utf8');
    expect(ardAesKey(secret)).toEqual(createHash('md5').update(secret).digest());
    expect(ardAesKey(secret)).toHaveLength(16);
  });

  it('encrypts without padding, so 128 bytes in is 128 bytes out', () => {
    const out = encryptArdCredentials(Buffer.alloc(128, 7), Buffer.alloc(16, 1));
    expect(out).toHaveLength(128);
  });
});

describe('ServerInit', () => {
  const build = (w: number, h: number, name: string) => {
    const nameBuf = Buffer.from(name, 'utf8');
    const buf = Buffer.alloc(24 + nameBuf.length);
    buf.writeUInt16BE(w, 0);
    buf.writeUInt16BE(h, 2);
    buf.writeUInt32BE(nameBuf.length, 20);
    nameBuf.copy(buf, 24);
    return buf;
  };

  it('reads the framebuffer size and desktop name', () => {
    expect(parseServerInit(build(3456, 2234, "Viraat's MacBook Pro"))).toEqual({
      width: 3456,
      height: 2234,
      name: "Viraat's MacBook Pro",
    });
  });

  it('refuses a truncated name rather than returning a short one', () => {
    const truncated = build(100, 100, 'desktop').subarray(0, 26);
    expect(() => parseServerInit(truncated)).toThrow(/name needs 7 bytes/);
  });
});

describe('input events', () => {
  it('encodes a pointer event', () => {
    expect([...pointerEvent(300, 200, 1)]).toEqual([5, 1, 0x01, 0x2c, 0x00, 0xc8]);
  });

  it('encodes key down and key up for the same keysym', () => {
    expect([...keyEvent(0x61, true)]).toEqual([4, 1, 0, 0, 0, 0, 0, 0x61]);
    expect([...keyEvent(0x61, false)]).toEqual([4, 0, 0, 0, 0, 0, 0, 0x61]);
  });

  it('encodes a framebuffer update request', () => {
    expect([...framebufferUpdateRequest(0, 0, 1920, 1080)]).toEqual([
      3, 0, 0, 0, 0, 0, 0x07, 0x80, 0x04, 0x38,
    ]);
  });

  it('maps printable ASCII to itself and the control keys people actually need', () => {
    expect(keysymForChar('a')).toBe(0x61);
    expect(keysymForChar(' ')).toBe(0x20);
    expect(keysymForChar('\n')).toBe(0xff0d);
    expect(keysymForChar('\t')).toBe(0xff09);
    expect(keysymForChar('\b')).toBe(0xff08);
  });

  it('refuses a character it has no mapping for, rather than sending a wrong key', () => {
    expect(() => keysymForChar('é')).toThrow(RfbProtocolError);
  });
});

describe('session selectors', () => {
  it('carries the exact strings read out of ScreenSharing.framework', () => {
    // Pulled from the framework's CFString constants. If Apple renames these,
    // the virtual-display request stops working and this test says why.
    expect(SessionSelect.ConnectToVirtualDisplay).toBe('ConnectToVirtualDisplay');
    expect(SessionSelect.DontConnectToVirtualDisplay).toBe('DontConnectToVirtualDisplay');
    expect(SessionSelect.ConnectToConsole).toBe('ConnectToConsole');
    expect(SessionSelect.RequestConsole).toBe('RequestConsole');
  });
});
