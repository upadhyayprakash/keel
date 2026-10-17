import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';

// A software passkey for tests: P-256 key, "none" attestation, user verification
// on. It builds real WebAuthn responses, so the server's checks run unchanged.

type Cbor = number | string | Buffer | Map<number | string, Cbor>;

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 256) return Buffer.from([(major << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)])]);
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();
const b64 = (data: Buffer) => data.toString('base64url');

export interface Tamper {
  origin?: string;
  rpId?: string;
  /** Leave out user verification (no Face ID). */
  noUv?: boolean;
  challenge?: string;
}

export class SoftAuthenticator {
  private key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credentialId = randomBytes(16);
  counter = 0;

  constructor(
    readonly origin: string,
    readonly rpId: string,
  ) {}

  get id(): string {
    return b64(this.credentialId);
  }

  private authData(rpId: string, flags: number, attested?: Buffer): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    return Buffer.concat([sha256(rpId), Buffer.from([flags]), counter, ...(attested ? [attested] : [])]);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** navigator.credentials.create(), as JSON. */
  register(options: { challenge: string }, t: Tamper = {}) {
    const jwk = this.key.publicKey.export({ format: 'jwk' });
    const cose = cbor(new Map<number, Cbor>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, 'base64url')], [-3, Buffer.from(jwk.y!, 'base64url')]]));
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, cose]);
    const authData = this.authData(t.rpId ?? this.rpId, 0x41 | (t.noUv ? 0 : 0x04), attested);
    const attestationObject = cbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64(this.clientData('webauthn.create', t.challenge ?? options.challenge, t.origin ?? this.origin)),
        attestationObject: b64(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
    };
  }

  /** navigator.credentials.get(), as JSON. Each sign-in moves the counter on. */
  signIn(options: { challenge: string }, t: Tamper = {}) {
    this.counter++;
    const authData = this.authData(t.rpId ?? this.rpId, 0x01 | (t.noUv ? 0 : 0x04));
    const clientData = this.clientData('webauthn.get', t.challenge ?? options.challenge, t.origin ?? this.origin);
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientData)]), this.key.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(signature) },
      clientExtensionResults: {},
    };
  }
}
