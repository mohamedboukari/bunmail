/**
 * A software WebAuthn authenticator for the passkey integration tests
 * (#223). It holds a real P-256 key pair (WebCrypto) and builds
 * `clientDataJSON`, `authenticatorData` and the `none` attestation object
 * by hand, so `@simplewebauthn/server` verifies real signatures: nothing
 * of the library is mocked.
 *
 * Every field a test may want to get wrong is an option: the origin and
 * the RP ID the data claims, the challenge, the user-verified flag, the
 * signature counter, the user handle, and a corrupted signature.
 */

/** Concatenates byte arrays. */
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** base64url without padding. */
export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Bytes of a base64url string. */
function fromB64url(value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

/** SHA-256. */
async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/* ─── A minimal CBOR encoder (RFC 8949): what an attestation object needs ─── */

/** A CBOR value this encoder writes. */
type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

/** The head of a data item: major type and argument. */
function cborHead(major: number, value: number): Uint8Array {
  if (value < 24) return Uint8Array.of((major << 5) | value);
  if (value < 0x100) return Uint8Array.of((major << 5) | 24, value);
  if (value < 0x10000) return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
  return Uint8Array.of(
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  );
}

/** Encodes one CBOR value. */
function cbor(value: Cbor): Uint8Array {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    return concat(cborHead(3, bytes.length), bytes);
  }
  if (value instanceof Uint8Array) return concat(cborHead(2, value.length), value);
  const parts: Uint8Array[] = [cborHead(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return concat(...parts);
}

/* ─── ECDSA signature: WebCrypto gives r||s, WebAuthn wants DER ─── */

/** One DER INTEGER from an unsigned big-endian value. */
function derInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  let body = bytes.slice(start);
  if ((body[0] ?? 0) & 0x80) body = concat(Uint8Array.of(0), body);
  return concat(Uint8Array.of(0x02, body.length), body);
}

/** A raw P-256 signature (64 bytes) as an ASN.1 DER `SEQUENCE { r, s }`. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32));
  return concat(Uint8Array.of(0x30, r.length + s.length), r, s);
}

/* ─── Authenticator data ─── */

/** Flag bits of `authenticatorData`. */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

/** A 32-bit big-endian counter. */
function u32(value: number): Uint8Array {
  return Uint8Array.of(
    (value >>> 24) & 0xff,
    (value >> 16) & 0xff,
    (value >> 8) & 0xff,
    value & 0xff,
  );
}

/** What a test can change about one ceremony. */
export interface CeremonyOverrides {
  /** The origin `clientDataJSON` claims (default: the one given to the authenticator). */
  origin?: string;
  /** The RP ID whose hash goes in `authenticatorData` (default: the options' one). */
  rpID?: string;
  /** The challenge `clientDataJSON` claims (default: the options' one). */
  challenge?: string;
  /** Set the user-verified flag (default true). */
  userVerified?: boolean;
  /** The signature counter to report (default: the next value of the authenticator's own). */
  counter?: number;
  /** Corrupt the signature (one byte flipped). */
  badSignature?: boolean;
  /** The user handle to return (default: the one the authenticator registered with). */
  userHandle?: string | null;
  /** Report this credential id instead of the authenticator's own. */
  credentialId?: string;
}

/** A registration response, as `dashboard.js` would post it. */
export interface TestRegistration {
  id: string;
  rawId: string;
  type: "public-key";
  response: { clientDataJSON: string; attestationObject: string; transports: string[] };
  clientExtensionResults: Record<string, never>;
}

/** An assertion, as `dashboard.js` would post it. */
export interface TestAssertion {
  id: string;
  rawId: string;
  type: "public-key";
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: Record<string, never>;
}

/** One software passkey: a key pair, a credential id and a counter. */
export class TestAuthenticator {
  /** The credential id, base64url. */
  readonly credentialId: string;
  /** The last signature counter reported. */
  counter: number;
  /** The user handle it registered with (base64url), returned on assertions. */
  userHandle: string | null = null;

  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly origin: string,
    options: { counter: number },
  ) {
    this.credentialId = b64url(crypto.getRandomValues(new Uint8Array(32)));
    this.counter = options.counter;
  }

  /**
   * A new authenticator for `origin`. `counter`: the signature counter it
   * starts from (0, the default, is a counter-less platform passkey; a
   * security key counts up from 1).
   */
  static async create(
    origin: string,
    options: { counter?: number } = {},
  ): Promise<TestAuthenticator> {
    const keys = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"],
    );
    return new TestAuthenticator(keys, origin, { counter: options.counter ?? 0 });
  }

  /** The COSE_Key (EC2, ES256) of the public key. */
  private async coseKey(): Promise<Uint8Array> {
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey);
    if (!jwk.x || !jwk.y) throw new Error("no EC point");
    return cbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64url(jwk.x)],
        [-3, fromB64url(jwk.y)],
      ]),
    );
  }

  /** `clientDataJSON` bytes. */
  private clientData(
    type: "webauthn.create" | "webauthn.get",
    challenge: string,
    origin: string,
  ): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  }

  /** The flags byte. */
  private static flags(userVerified: boolean, attested: boolean): number {
    return FLAG_UP | (userVerified ? FLAG_UV : 0) | (attested ? FLAG_AT : 0);
  }

  /**
   * Answers creation options (`navigator.credentials.create`): a `none`
   * attestation over the authenticator data with the new public key.
   */
  async register(
    options: { challenge: string; rp: { id?: string }; user: { id: string } },
    overrides: CeremonyOverrides = {},
  ): Promise<TestRegistration> {
    const rpID = overrides.rpID ?? options.rp.id ?? "";
    this.userHandle = options.user.id;
    const credentialId = fromB64url(this.credentialId);
    const authData = concat(
      await sha256(new TextEncoder().encode(rpID)),
      Uint8Array.of(TestAuthenticator.flags(overrides.userVerified ?? true, true)),
      u32(overrides.counter ?? this.counter),
      new Uint8Array(16),
      Uint8Array.of(credentialId.length >> 8, credentialId.length & 0xff),
      credentialId,
      await this.coseKey(),
    );
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    const clientDataJSON = this.clientData(
      "webauthn.create",
      overrides.challenge ?? options.challenge,
      overrides.origin ?? this.origin,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
    };
  }

  /**
   * Answers request options (`navigator.credentials.get`): signs the
   * authenticator data and the client data hash with the private key.
   * The counter goes up by one when the authenticator counts (starts
   * above 0), unless the test sets it.
   */
  async assert(
    options: { challenge: string; rpId?: string },
    overrides: CeremonyOverrides = {},
  ): Promise<TestAssertion> {
    const rpID = overrides.rpID ?? options.rpId ?? "";
    if (overrides.counter !== undefined) {
      this.counter = overrides.counter;
    } else if (this.counter > 0) {
      this.counter += 1;
    }
    const authData = concat(
      await sha256(new TextEncoder().encode(rpID)),
      Uint8Array.of(TestAuthenticator.flags(overrides.userVerified ?? true, false)),
      u32(this.counter),
    );
    const clientDataJSON = this.clientData(
      "webauthn.get",
      overrides.challenge ?? options.challenge,
      overrides.origin ?? this.origin,
    );
    const signed = concat(authData, await sha256(clientDataJSON));
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.keys.privateKey,
        signed,
      ),
    );
    /** A well-formed signature that does not verify: one bit of `s` flipped. */
    if (overrides.badSignature) raw[63] = (raw[63] ?? 0) ^ 0x01;
    const signature = rawToDer(raw);
    const handle =
      overrides.userHandle === undefined ? this.userHandle : overrides.userHandle;
    const id = overrides.credentialId ?? this.credentialId;
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(handle === null ? {} : { userHandle: handle }),
      },
      clientExtensionResults: {},
    };
  }
}
