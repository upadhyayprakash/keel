import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// ADR 0002: TOTP (RFC 6238) as the optional fallback login. SHA-1, 6 digits,
// 30-second steps, one step of clock drift either side.

export const TOTP_STEP = 30;
const DRIFT = 1;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) without padding, the form authenticator apps expect. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`"${char}" is not base32.`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP for one counter value. */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = mac[mac.length - 1]! & 15;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(code).padStart(digits, '0');
}

/** The time step a moment falls in. */
export const totpStep = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP);

/** The code for a moment, from a base32 secret. */
export function totpCode(secret: string, ms: number, digits = 6): string {
  return hotp(base32Decode(secret), totpStep(ms), digits);
}

/**
 * Checks a code against the current step and one step either side. Returns the
 * step it matched, so the caller can refuse it next time (no replay), or null.
 */
export function checkTotp(secret: string, code: string, ms: number): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const key = base32Decode(secret);
  const now = totpStep(ms);
  for (let step = now - DRIFT; step <= now + DRIFT; step++) {
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(given))) return step;
  }
  return null;
}

/** The otpauth:// address an authenticator app reads from the QR code. */
export function totpUri(secret: string, account: string): string {
  const label = encodeURIComponent(`Keel:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Keel&algorithm=SHA1&digits=6&period=${TOTP_STEP}`;
}
