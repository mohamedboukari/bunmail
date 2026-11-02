import { createHash, randomBytes } from "crypto";

/**
 * An in-process OpenID Connect provider for SSO tests (#224): `Bun.serve`
 * on 127.0.0.1 with a WebCrypto RSA key. It serves a discovery document,
 * a token endpoint (authorization code + PKCE S256, `client_secret_basic`)
 * that returns an ID token signed with the key, and a JWKS. There is no
 * authorize page: a test reads the authorization URL BunMail built and
 * calls `issueCode` with what it carries, as the provider would after the
 * user signed in.
 *
 * Every knob is a public field so a test can bend one thing at a time.
 */

/** What a code was issued for, checked at the token endpoint. */
interface IssuedCode {
  codeChallenge: string;
  redirectUri: string;
  nonce: string;
  used: boolean;
}

/** base64url of bytes or a string. */
function b64u(input: Uint8Array | string): string {
  return Buffer.from(input).toString("base64url");
}

/** An RSA signing key pair (RS256), extractable so its public half can be published. */
async function rsaKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
}

export class FakeOidcProvider {
  /** The base URL, also the default issuer: `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret: string;

  /** The `issuer` the discovery document claims (default: {@link url}). */
  documentIssuer: string;
  /** Extra or overriding discovery fields. */
  documentExtra: Record<string, unknown> = {};
  /** Delay before the discovery document is served, in milliseconds. */
  discoveryDelayMs = 0;
  /** Raw discovery answer, when a test needs a broken one. */
  discoveryOverride: (() => Response) | null = null;
  /**
   * Claims merged over the default ID token claims; a key set to
   * `undefined` removes that claim.
   */
  claimOverrides: Record<string, unknown> = {};
  /** Sign ID tokens with a key the JWKS does not publish (same `kid`). */
  signWithWrongKey = false;
  /** Delay before the JWKS is served, in milliseconds. */
  jwksDelayMs = 0;

  /** Requests seen per path, to assert what BunMail did or did not call. */
  readonly hits = new Map<string, number>();

  private readonly codes = new Map<string, IssuedCode>();
  private readonly server: ReturnType<typeof Bun.serve>;
  private readonly kid = "test-key-1";

  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly wrongKeys: CryptoKeyPair,
    private readonly publicJwk: object,
  ) {
    this.clientId = "bunmail-test-client";
    this.clientSecret = "test secret/with:special&chars";
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => this.handle(request),
    });
    this.url = `http://127.0.0.1:${this.server.port}`;
    this.documentIssuer = this.url;
  }

  /** Starts a provider with fresh keys. */
  static async start(): Promise<FakeOidcProvider> {
    const keys = await rsaKeyPair();
    const wrongKeys = await rsaKeyPair();
    const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    return new FakeOidcProvider(keys, wrongKeys, publicJwk);
  }

  /** Stops the server. */
  async stop(): Promise<void> {
    await this.server.stop(true);
  }

  /** How many times `path` was requested. */
  hitCount(path: string): number {
    return this.hits.get(path) ?? 0;
  }

  /**
   * Issues a one-time code for the request in `authorizationUrl`, as the
   * provider would once the user signed in, and returns the callback
   * query BunMail receives.
   */
  issueCode(authorizationUrl: string): URLSearchParams {
    const params = new URL(authorizationUrl).searchParams;
    const code = randomBytes(16).toString("hex");
    this.codes.set(code, {
      codeChallenge: params.get("code_challenge") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      nonce: params.get("nonce") ?? "",
      used: false,
    });
    return new URLSearchParams({ code, state: params.get("state") ?? "" });
  }

  /** The discovery document. */
  private document(): Record<string, unknown> {
    return {
      issuer: this.documentIssuer,
      authorization_endpoint: `${this.url}/authorize`,
      token_endpoint: `${this.url}/token`,
      jwks_uri: `${this.url}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      ...this.documentExtra,
    };
  }

  /** A signed RS256 JWT. */
  private async sign(claims: Record<string, unknown>): Promise<string> {
    const header = b64u(JSON.stringify({ alg: "RS256", typ: "JWT", kid: this.kid }));
    const payload = b64u(JSON.stringify(claims));
    const key = this.signWithWrongKey ? this.wrongKeys.privateKey : this.keys.privateKey;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    return `${header}.${payload}.${b64u(new Uint8Array(signature))}`;
  }

  /** The token endpoint: checks the client, the code, the redirect URI and PKCE. */
  private async token(request: Request): Promise<Response> {
    const refuse = (error: string, status = 400): Response =>
      Response.json({ error }, { status });
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Basic ")) return refuse("invalid_client", 401);
    const [id, secret] = Buffer.from(auth.slice(6), "base64")
      .toString("utf8")
      .split(":")
      .map((part) => decodeURIComponent(part.replace(/\+/g, " ")));
    if (id !== this.clientId || secret !== this.clientSecret) {
      return refuse("invalid_client", 401);
    }
    const form = new URLSearchParams(await request.text());
    if (form.has("client_secret")) return refuse("invalid_request");
    if (form.get("grant_type") !== "authorization_code") {
      return refuse("unsupported_grant_type");
    }
    const issued = this.codes.get(form.get("code") ?? "");
    if (!issued || issued.used) return refuse("invalid_grant");
    issued.used = true;
    if (form.get("redirect_uri") !== issued.redirectUri) return refuse("invalid_grant");
    const verifier = form.get("code_verifier") ?? "";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== issued.codeChallenge) return refuse("invalid_grant");

    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: this.documentIssuer,
      sub: "user-123",
      aud: this.clientId,
      exp: now + 300,
      iat: now,
      nonce: issued.nonce,
      email: "Alice@Example.com",
      email_verified: true,
      name: "Alice Example",
    };
    for (const [name, value] of Object.entries(this.claimOverrides)) {
      if (value === undefined) delete claims[name];
      else claims[name] = value;
    }
    return Response.json(
      {
        access_token: "fake-access-token",
        token_type: "Bearer",
        expires_in: 300,
        id_token: await this.sign(claims),
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  /** Routes one request. */
  private async handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    this.hits.set(path, (this.hits.get(path) ?? 0) + 1);
    switch (path) {
      case "/.well-known/openid-configuration":
        if (this.discoveryDelayMs > 0) await Bun.sleep(this.discoveryDelayMs);
        return this.discoveryOverride
          ? this.discoveryOverride()
          : Response.json(this.document());
      case "/token":
        return request.method === "POST"
          ? this.token(request)
          : new Response("method not allowed", { status: 405 });
      case "/jwks":
        if (this.jwksDelayMs > 0) await Bun.sleep(this.jwksDelayMs);
        return Response.json({
          keys: [{ ...this.publicJwk, kid: this.kid, alg: "RS256", use: "sig" }],
        });
      default:
        return new Response("not found", { status: 404 });
    }
  }
}
