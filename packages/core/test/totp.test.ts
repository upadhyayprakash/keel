import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AuthStore, base32Decode, base32Encode, checkTotp, hotp, newTotpSecret, totpCode, totpStep, totpUri } from '../src';

// The RFC test key: the ASCII bytes "12345678901234567890".
const KEY = Buffer.from('12345678901234567890');
const SECRET = base32Encode(KEY);

describe('TOTP codes', () => {
  it('matches the RFC 4226 HOTP vectors', () => {
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expect(expected.map((_, counter) => hotp(KEY, counter))).toEqual(expected);
  });

  it('matches the RFC 6238 SHA-1 vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) expect(totpCode(SECRET, seconds * 1000, 8)).toBe(code);
  });

  it('round-trips base32 and makes 160-bit secrets', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi==').toString()).toBe('foobar');
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(secret)).toHaveLength(20);
  });

  it('accepts one step of drift either side, and nothing further', () => {
    const now = 1_700_000_000_000;
    const at = (offset: number) => totpCode(SECRET, now + offset * 30_000);
    expect(checkTotp(SECRET, at(0), now)).toBe(totpStep(now));
    expect(checkTotp(SECRET, at(-1), now)).toBe(totpStep(now) - 1);
    expect(checkTotp(SECRET, at(1), now)).toBe(totpStep(now) + 1);
    expect(checkTotp(SECRET, at(-2), now)).toBeNull();
    expect(checkTotp(SECRET, at(2), now)).toBeNull();
  });

  it('refuses anything that is not six digits', () => {
    const now = 1_700_000_000_000;
    expect(checkTotp(SECRET, '12345', now)).toBeNull();
    expect(checkTotp(SECRET, 'abcdef', now)).toBeNull();
    const code = totpCode(SECRET, now);
    expect(checkTotp(SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(totpStep(now));
  });

  it('builds the otpauth address for the QR code', () => {
    expect(totpUri('ABC', 'my mac')).toBe('otpauth://totp/Keel%3Amy%20mac?secret=ABC&issuer=Keel&algorithm=SHA1&digits=6&period=30');
  });
});

describe('AuthStore TOTP', () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const store = () => {
    dir = mkdtempSync(join(tmpdir(), 'keel-totp-'));
    return AuthStore.at(dir);
  };

  it('is off until enabled, and refuses a step used before (no replay)', () => {
    const s = store();
    expect(s.totp()).toBeNull();
    expect(s.useTotpStep(5)).toBe(false);
    s.enableTotp(10);
    expect(s.totp()?.lastStep).toBe(10);
    expect(s.useTotpStep(10)).toBe(false);
    expect(s.useTotpStep(9)).toBe(false);
    expect(s.useTotpStep(11)).toBe(true);
    expect(s.useTotpStep(11)).toBe(false);
  });

  it('gives code sign-ins 12-hour sessions, and disabling ends only those', () => {
    const s = store();
    s.enableTotp(1);
    const code = s.createSession({ passkeyId: null, method: 'totp', scope: 'goals' }).session;
    s.createSession({ passkeyId: 'p1', method: 'passkey', scope: 'goals' });
    expect(Date.parse(code.expiresAt) - Date.parse(code.createdAt)).toBe(12 * 3600_000);
    expect(s.disableTotp()).toBe(1);
    expect(s.totp()).toBeNull();
    expect(s.sessions().map((x) => x.method)).toEqual(['passkey']);
  });
});
