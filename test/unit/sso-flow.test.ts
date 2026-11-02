import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import { createHash, randomBytes } from "crypto";
import type { SsoProviderSettings } from "../../src/config.ts";
import {
  clearSsoDiscoveryCache,
  getSsoProviderMetadata,
  SSO_HTTP_MAX_BYTES,
} from "../../src/modules/users/services/sso-discovery.service.ts";
import {
  defaultSsoFlowKey,
  deriveSsoFlowKey,
  openSsoFlow,
  sealSsoFlow,
  SSO_FLOW_TTL_SECONDS,
} from "../../src/modules/users/services/sso-flow-cookie.service.ts";
import {
  SharedSsoReplayStore,
  ssoReplayKey,
} from "../../src/modules/users/services/sso-replay.service.ts";
import {
  completeSsoCallback,
  ssoRedirectUri,
  startSsoFlow,
} from "../../src/modules/users/services/sso.service.ts";
import type { SsoCallbackResult } from "../../src/modules/users/types/sso.types.ts";
import { encryptSecret } from "../../src/utils/crypto.ts";
import {
  MemoryOneTimeStore,
  SharedStoreError,
  type OneTimeStore,
} from "../../src/utils/shared-store.ts";
import { logger } from "../../src/utils/logger.ts";
import {
  clearSsoFlowCookie,
  readSsoFlowCookie,
  ssoFlowSetCookie,
} from "../../src/pages/session.ts";
import { FakeOidcProvider } from "../fixtures/fake-oidc-provider.ts";

/**
 * The SSO flow (#224) against an in-process OpenID Connect provider
 * (`test/fixtures/fake-oidc-provider.ts`), through the real `oauth4webapi`
 * code path: discovery, the authorization request, the flow cookie, the
 * code exchange, and every check of the callback and the ID token.
 */

const BASE_URL = "https://mail.example.com";

let idp: FakeOidcProvider;

beforeAll(async () => {
  idp = await FakeOidcProvider.start();
});

afterAll(async () => {
  await idp.stop();
});

beforeEach(() => {
  clearSsoDiscoveryCache();
  idp.documentIssuer = idp.url;
  idp.documentExtra = {};
  idp.discoveryDelayMs = 0;
  idp.discoveryOverride = null;
  idp.claimOverrides = {};
  idp.signWithWrongKey = false;
  idp.jwksDelayMs = 0;
  idp.hits.clear();
});

/** The provider settings BunMail would read for the fake provider. */
function provider(overrides: Partial<SsoProviderSettings> = {}): SsoProviderSettings {
  return {
    id: "corp",
    issuer: idp.url,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    label: "Corp",
    scopes: "openid email profile",
    allowedDomains: [],
    autoLink: false,
    ...overrides,
  };
}

/** Starts a login flow and returns its URL and cookie, failing the test otherwise. */
async function start(
  settings: SsoProviderSettings = provider(),
  now?: number,
): Promise<{ authorizationUrl: string; flowCookie: string }> {
  const started = await startSsoFlow({
    provider: settings,
    baseUrl: BASE_URL,
    purpose: "login",
    ...(now === undefined ? {} : { now }),
  });
  if (!started.ok) throw new Error(`start failed: ${started.reason}`);
  return started;
}

/** Runs a full flow: start, provider sign-in, callback. */
async function fullFlow(
  mutate: (params: URLSearchParams) => void = () => {},
): Promise<SsoCallbackResult> {
  const { authorizationUrl, flowCookie } = await start();
  const params = idp.issueCode(authorizationUrl);
  mutate(params);
  return completeSsoCallback({
    provider: provider(),
    baseUrl: BASE_URL,
    flowCookie,
    params,
  });
}

/** The failure reason of a result, or `"ok"`. */
function reasonOf(result: SsoCallbackResult): string {
  return result.ok ? "ok" : result.reason;
}

describe("startSsoFlow", () => {
  test("builds a code + PKCE S256 request with state, nonce and the fixed redirect URI", async () => {
    const { authorizationUrl, flowCookie } = await start();
    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${idp.url}/authorize`);
    const params = url.searchParams;
    expect(params.get("client_id")).toBe(idp.clientId);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe("openid email profile");
    expect(params.get("redirect_uri")).toBe(
      "https://mail.example.com/dashboard/login/sso/corp/callback",
    );
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.has("response_mode")).toBe(false);

    const flow = openSsoFlow(flowCookie, defaultSsoFlowKey());
    expect(flow).not.toBeNull();
    expect(flow?.provider).toBe("corp");
    expect(flow?.purpose).toBe("login");
    expect(flow?.sessionId).toBeUndefined();
    expect(params.get("state")).toBe(flow?.state ?? "");
    expect(params.get("nonce")).toBe(flow?.nonce ?? "");
    const challenge = createHash("sha256")
      .update(flow?.codeVerifier ?? "")
      .digest("base64url");
    expect(params.get("code_challenge")).toBe(challenge);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(flow?.exp).toBeGreaterThan(nowSec + SSO_FLOW_TTL_SECONDS - 5);
    expect(flow?.exp).toBeLessThanOrEqual(nowSec + SSO_FLOW_TTL_SECONDS);
    /** The cookie is opaque: nothing of the payload is readable in it. */
    expect(flowCookie).not.toContain(flow?.state ?? "missing");
  });

  test("each flow has its own state, nonce and verifier", async () => {
    const a = openSsoFlow((await start()).flowCookie, defaultSsoFlowKey());
    const b = openSsoFlow((await start()).flowCookie, defaultSsoFlowKey());
    expect(a?.state).not.toBe(b?.state ?? "");
    expect(a?.nonce).not.toBe(b?.nonce ?? "");
    expect(a?.codeVerifier).not.toBe(b?.codeVerifier ?? "");
  });

  test("a redirect URI per provider", () => {
    expect(ssoRedirectUri("http://localhost:3000", "google-ws")).toBe(
      "http://localhost:3000/dashboard/login/sso/google-ws/callback",
    );
  });
});

describe("completeSsoCallback: success", () => {
  test("happy path: the identity, and no token in it", async () => {
    const result = await fullFlow();
    expect(result).toEqual({
      ok: true,
      identity: {
        issuer: idp.url,
        sub: "user-123",
        email: "alice@example.com",
        emailVerified: true,
        name: "Alice Example",
        hostedDomain: null,
      },
      purpose: "login",
      sessionId: null,
    });
    expect(idp.hitCount("/token")).toBe(1);
    expect(idp.hitCount("/jwks")).toBe(1);
    /** Discovery ran once for the start and the callback together. */
    expect(idp.hitCount("/.well-known/openid-configuration")).toBe(1);
  });

  test("a link flow carries its session id back", async () => {
    const started = await startSsoFlow({
      provider: provider(),
      baseUrl: BASE_URL,
      purpose: "link",
      sessionId: "ses_0123456789abcdef",
    });
    if (!started.ok) throw new Error("start failed");
    const params = idp.issueCode(started.authorizationUrl);
    const result = await completeSsoCallback({
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie: started.flowCookie,
      params,
    });
    expect(result.ok && result.purpose).toBe("link");
    expect(result.ok && result.sessionId).toBe("ses_0123456789abcdef");
  });

  test("an unverified email is surfaced as emailVerified false", async () => {
    idp.claimOverrides = { email_verified: false };
    const result = await fullFlow();
    expect(result.ok && result.identity.emailVerified).toBe(false);
    expect(result.ok && result.identity.email).toBe("alice@example.com");
  });

  test('only the boolean true counts as verified ("true" as a string does not)', async () => {
    idp.claimOverrides = { email_verified: "true" };
    const result = await fullFlow();
    expect(result.ok && result.identity.emailVerified).toBe(false);
  });

  test("no email or name claims: null", async () => {
    idp.claimOverrides = { email: undefined, email_verified: undefined, name: undefined };
    const result = await fullFlow();
    expect(result.ok && result.identity).toEqual({
      issuer: idp.url,
      sub: "user-123",
      email: null,
      emailVerified: false,
      name: null,
      hostedDomain: null,
    });
  });

  test("RFC 9207: a correct iss parameter is accepted", async () => {
    idp.documentExtra = { authorization_response_iss_parameter_supported: true };
    const result = await fullFlow((params) => params.set("iss", idp.url));
    expect(result.ok).toBe(true);
  });

  test("several audiences with azp equal to our client id are accepted", async () => {
    idp.claimOverrides = { aud: [idp.clientId, "other-client"], azp: idp.clientId };
    expect(reasonOf(await fullFlow())).toBe("ok");
  });
});

describe("completeSsoCallback: the flow cookie and state", () => {
  test("no cookie: flow_missing, and nothing reaches the provider", async () => {
    const { authorizationUrl } = await start();
    const params = idp.issueCode(authorizationUrl);
    idp.hits.clear();
    const result = await completeSsoCallback({
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie: undefined,
      params,
    });
    expect(reasonOf(result)).toBe("flow_missing");
    expect(idp.hits.size).toBe(0);
  });

  test("wrong state: state_mismatch, and the code is never exchanged", async () => {
    expect(reasonOf(await fullFlow((params) => params.set("state", "forged")))).toBe(
      "state_mismatch",
    );
    expect(reasonOf(await fullFlow((params) => params.delete("state")))).toBe(
      "state_mismatch",
    );
    expect(idp.hitCount("/token")).toBe(0);
  });

  test("an expired cookie: flow_expired", async () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    const { authorizationUrl, flowCookie } = await start(provider(), elevenMinutesAgo);
    const params = idp.issueCode(authorizationUrl);
    const result = await completeSsoCallback({
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie,
      params,
    });
    expect(reasonOf(result)).toBe("flow_expired");
    expect(idp.hitCount("/token")).toBe(0);
  });

  test("a tampered cookie: flow_invalid", async () => {
    const { authorizationUrl, flowCookie } = await start();
    const params = idp.issueCode(authorizationUrl);
    const [version, iv, ciphertext, tag] = flowCookie.split(":");
    const bytes = Buffer.from(ciphertext ?? "", "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    const tampered = [version, iv, bytes.toString("base64"), tag].join(":");
    for (const cookie of [tampered, "garbage", "v1:a:b:c", "x".repeat(5000)]) {
      const result = await completeSsoCallback({
        provider: provider(),
        baseUrl: BASE_URL,
        flowCookie: cookie,
        params,
      });
      expect(reasonOf(result)).toBe("flow_invalid");
    }
    expect(idp.hitCount("/token")).toBe(0);
  });

  test("a cookie sealed under another key: flow_invalid", async () => {
    const { authorizationUrl, flowCookie } = await start();
    const result = await completeSsoCallback({
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie,
      params: idp.issueCode(authorizationUrl),
      key: deriveSsoFlowKey(randomBytes(32)),
    });
    expect(reasonOf(result)).toBe("flow_invalid");
  });

  test("a cookie made for another provider: provider_mismatch", async () => {
    const { authorizationUrl, flowCookie } = await start(provider({ id: "other" }));
    const result = await completeSsoCallback({
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie,
      params: idp.issueCode(authorizationUrl),
    });
    expect(reasonOf(result)).toBe("provider_mismatch");
    expect(idp.hitCount("/token")).toBe(0);
  });

  test("a replayed cookie + state: flow_replayed, one token request only", async () => {
    const { authorizationUrl, flowCookie } = await start();
    const params = idp.issueCode(authorizationUrl);
    const input = { provider: provider(), baseUrl: BASE_URL, flowCookie, params };
    expect(reasonOf(await completeSsoCallback(input))).toBe("ok");
    expect(idp.hitCount("/token")).toBe(1);
    expect(reasonOf(await completeSsoCallback(input))).toBe("flow_replayed");
    const junk = new URLSearchParams({ state: params.get("state") ?? "", code: "junk" });
    expect(reasonOf(await completeSsoCallback({ ...input, params: junk }))).toBe(
      "flow_replayed",
    );
    expect(idp.hitCount("/token")).toBe(1);
  });

  test("a flow whose first callback failed cannot be retried with junk codes", async () => {
    const { authorizationUrl, flowCookie } = await start();
    const state = new URL(authorizationUrl).searchParams.get("state") ?? "";
    const input = { provider: provider(), baseUrl: BASE_URL, flowCookie };
    for (let i = 0; i < 5; i++) {
      const params = new URLSearchParams({ state, code: `junk-${i}` });
      const expected = i === 0 ? "provider_error" : "flow_replayed";
      expect(reasonOf(await completeSsoCallback({ ...input, params }))).toBe(expected);
    }
    expect(idp.hitCount("/token")).toBe(1);
  });

  test("two concurrent callbacks of one flow: only one reaches the provider", async () => {
    const { authorizationUrl, flowCookie } = await start();
    const params = idp.issueCode(authorizationUrl);
    const input = { provider: provider(), baseUrl: BASE_URL, flowCookie, params };
    const results = await Promise.all([
      completeSsoCallback(input),
      completeSsoCallback(input),
    ]);
    expect(results.map(reasonOf).toSorted()).toEqual(["flow_replayed", "ok"]);
    expect(idp.hitCount("/token")).toBe(1);
  });
});

describe("SharedSsoReplayStore (#185)", () => {
  test("consumes a key once until it expires", async () => {
    const store = new SharedSsoReplayStore(new MemoryOneTimeStore(10));
    expect(await store.consume("k", 100, 50)).toBe(true);
    expect(await store.consume("k", 100, 99)).toBe(false);
    expect(await store.consume("other", 100, 99)).toBe(true);
  });

  test("concurrent consumes of one key: exactly one wins", async () => {
    const store = new SharedSsoReplayStore(new MemoryOneTimeStore(10));
    const wins = await Promise.all(
      Array.from({ length: 10 }, () => store.consume("k", 100, 0)),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  test("holds a key for what is left of the flow plus 60 s of clock skew", async () => {
    const claims: Array<{ key: string; ttlMs: number }> = [];
    const recording: OneTimeStore = {
      put: () => Promise.resolve(),
      take: () => Promise.resolve({ status: "missing" }),
      claim: (key, ttlMs) => {
        claims.push({ key, ttlMs });
        return Promise.resolve(true);
      },
    };
    const store = new SharedSsoReplayStore(recording);
    await store.consume("a", 1_000, 400);
    await store.consume("b", 1_000, 1_000);
    expect(claims).toEqual([
      { key: "a", ttlMs: 660_000 },
      { key: "b", ttlMs: 60_000 },
    ]);
  });

  test("fails closed: an in-memory store full of live states rejects the next callback", async () => {
    const store = new SharedSsoReplayStore(new MemoryOneTimeStore(1));
    expect(await store.consume("first", 100, 0)).toBe(true);
    const error = await store.consume("second", 100, 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SharedStoreError);
    expect(await store.consume("first", 100, 0)).toBe(false);
  });

  test("fails closed: a store error rejects, never lets the state through", async () => {
    const down: OneTimeStore = {
      put: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      take: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
      claim: () => Promise.reject(new SharedStoreError("REDIS_UNAVAILABLE", "down")),
    };
    const store = new SharedSsoReplayStore(down);
    const error = await store.consume("k", 100, 0).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SharedStoreError);
  });

  test("the key is a SHA-256, never the state itself", () => {
    const key = ssoReplayKey("the-state");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("the-state");
  });
});

describe("completeSsoCallback: provider answers", () => {
  test("an error parameter from the provider: provider_error", async () => {
    const result = await fullFlow((params) => {
      params.delete("code");
      params.set("error", "access_denied");
    });
    expect(reasonOf(result)).toBe("provider_error");
    expect(idp.hitCount("/token")).toBe(0);
  });

  test("RFC 9207: a wrong iss parameter is refused", async () => {
    const result = await fullFlow((params) =>
      params.set("iss", "https://evil.example.com"),
    );
    expect(reasonOf(result)).toBe("issuer_mismatch");
    expect(idp.hitCount("/token")).toBe(0);
  });

  test("RFC 9207: a missing iss is refused when the provider promises it", async () => {
    idp.documentExtra = { authorization_response_iss_parameter_supported: true };
    expect(reasonOf(await fullFlow())).toBe("issuer_mismatch");
  });

  test("a wrong client secret: provider_error", async () => {
    const { authorizationUrl, flowCookie } = await start();
    const result = await completeSsoCallback({
      provider: provider({ clientSecret: "wrong" }),
      baseUrl: BASE_URL,
      flowCookie,
      params: idp.issueCode(authorizationUrl),
    });
    expect(reasonOf(result)).toBe("provider_error");
  });

  test("a different redirect URI at exchange time: provider_error", async () => {
    const { authorizationUrl, flowCookie } = await start();
    const result = await completeSsoCallback({
      provider: provider(),
      baseUrl: "https://other.example.com",
      flowCookie,
      params: idp.issueCode(authorizationUrl),
    });
    expect(reasonOf(result)).toBe("provider_error");
  });
});

describe("completeSsoCallback: the ID token", () => {
  const cases: [string, () => Record<string, unknown>][] = [
    ["a wrong iss", () => ({ iss: "https://evil.example.com" })],
    ["an iss with a trailing slash", () => ({ iss: `${idp.url}/` })],
    ["a wrong aud", () => ({ aud: "another-client" })],
    ["several audiences without azp", () => ({ aud: [idp.clientId, "other-client"] })],
    ["a wrong azp", () => ({ azp: "other-client" })],
    ["a wrong nonce", () => ({ nonce: "forged-nonce" })],
    ["no nonce", () => ({ nonce: undefined })],
    ["an expired token", () => ({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ["an iat in the future", () => ({ iat: Math.floor(Date.now() / 1000) + 600 })],
    ["no sub", () => ({ sub: undefined })],
    ["an empty sub", () => ({ sub: "" })],
    ["a sub over 255 characters", () => ({ sub: "s".repeat(256) })],
    ["a sub with a NUL", () => ({ sub: "user\u0000123" })],
    ["a sub with a control character", () => ({ sub: "user\n123" })],
    ["a non-ASCII sub", () => ({ sub: "us\u00e9r" })],
  ];

  for (const [name, claims] of cases) {
    test(`${name}: id_token_invalid`, async () => {
      idp.claimOverrides = claims();
      expect(reasonOf(await fullFlow())).toBe("id_token_invalid");
    });
  }

  const badEmails: [string, string][] = [
    ["the Kelvin sign (folds to k under Unicode lower-casing)", "\u212Aate@corp.com"],
    ["a NUL", "alice\u0000@example.com"],
    ["a control character", "alice\u0007@example.com"],
    ["a line break in the domain", "alice@exam\nple.com"],
    ["a space", "alice smith@example.com"],
    ["two @", "alice@evil.com@example.com"],
    ["no domain", "alice@"],
    ["no local part", "@example.com"],
    ["a single-label domain", "alice@localhost"],
    ["a non-ASCII domain", "alice@ex\u00e4mple.com"],
    ["a local part over 64 characters", `${"a".repeat(65)}@example.com`],
  ];

  for (const [name, email] of badEmails) {
    test(`an email with ${name}: email null, not verified`, async () => {
      idp.claimOverrides = { email, email_verified: true };
      const result = await fullFlow();
      expect(result.ok && result.identity.email).toBeNull();
      expect(result.ok && result.identity.emailVerified).toBe(false);
    });
  }

  test("an ASCII email is lower-cased by its ASCII letters only", async () => {
    idp.claimOverrides = { email: "Alice.O'Brien+X@Sub.Example.COM" };
    const result = await fullFlow();
    expect(result.ok && result.identity.email).toBe("alice.o'brien+x@sub.example.com");
    expect(result.ok && result.identity.emailVerified).toBe(true);
  });

  test("Google's hd claim is kept as hostedDomain when it is a domain", async () => {
    idp.claimOverrides = { hd: "Corp.Example.com" };
    let result = await fullFlow();
    expect(result.ok && result.identity.hostedDomain).toBe("corp.example.com");
    idp.claimOverrides = { hd: "not a domain" };
    result = await fullFlow();
    expect(result.ok && result.identity.hostedDomain).toBeNull();
    idp.claimOverrides = { hd: "\u212Aorp.com" };
    result = await fullFlow();
    expect(result.ok && result.identity.hostedDomain).toBeNull();
  });

  test("concurrent callbacks on a cold JWKS cache download the JWKS once", async () => {
    idp.jwksDelayMs = 150;
    const first = await start();
    const second = await start();
    const results = await Promise.all(
      [first, second].map(({ authorizationUrl, flowCookie }) =>
        completeSsoCallback({
          provider: provider(),
          baseUrl: BASE_URL,
          flowCookie,
          params: idp.issueCode(authorizationUrl),
        }),
      ),
    );
    expect(results.map(reasonOf)).toEqual(["ok", "ok"]);
    expect(idp.hitCount("/token")).toBe(2);
    expect(idp.hitCount("/jwks")).toBe(1);
  });

  test("an expiry within the 30 s clock tolerance is accepted", async () => {
    idp.claimOverrides = { exp: Math.floor(Date.now() / 1000) - 10 };
    expect(reasonOf(await fullFlow())).toBe("ok");
  });

  test("a bad signature: id_token_invalid (the signature is checked)", async () => {
    idp.signWithWrongKey = true;
    expect(reasonOf(await fullFlow())).toBe("id_token_invalid");
    expect(idp.hitCount("/jwks")).toBe(1);
  });
});

describe("discovery", () => {
  test("cached: one request for several flows", async () => {
    await start();
    await start();
    expect(idp.hitCount("/.well-known/openid-configuration")).toBe(1);
  });

  test("refetched after an hour", async () => {
    const now = Date.now();
    await getSsoProviderMetadata(provider(), { now });
    await getSsoProviderMetadata(provider(), { now: now + 59 * 60 * 1000 });
    expect(idp.hitCount("/.well-known/openid-configuration")).toBe(1);
    await getSsoProviderMetadata(provider(), { now: now + 61 * 60 * 1000 });
    expect(idp.hitCount("/.well-known/openid-configuration")).toBe(2);
  });

  test("a failure is not cached: the next use tries again", async () => {
    idp.discoveryOverride = () => new Response("down", { status: 503 });
    expect(await getSsoProviderMetadata(provider())).toBeNull();
    idp.discoveryOverride = null;
    expect(await getSsoProviderMetadata(provider())).not.toBeNull();
    expect(idp.hitCount("/.well-known/openid-configuration")).toBe(2);
  });

  const failures: [string, () => void][] = [
    [
      "another issuer in the document",
      () => (idp.documentIssuer = "https://evil.example.com"),
    ],
    [
      "the issuer with a trailing slash (equal as a URL, not as a string)",
      () => (idp.documentIssuer = `${idp.url}/`),
    ],
    ["no token endpoint", () => (idp.documentExtra = { token_endpoint: undefined })],
    [
      "an endpoint on another scheme",
      () => (idp.documentExtra = { authorization_endpoint: "javascript:alert(1)" }),
    ],
    [
      "a plain http endpoint off loopback, even with a loopback http issuer",
      () => (idp.documentExtra = { token_endpoint: "http://idp.example.com/token" }),
    ],
    [
      "no S256 PKCE",
      () => (idp.documentExtra = { code_challenge_methods_supported: ["plain"] }),
    ],
    [
      "an HTTP error",
      () => (idp.discoveryOverride = () => new Response("", { status: 500 })),
    ],
    [
      "a redirect (never followed)",
      () =>
        (idp.discoveryOverride = () =>
          new Response(null, {
            status: 302,
            headers: { location: `${idp.url}/elsewhere` },
          })),
    ],
    [
      "not JSON",
      () =>
        (idp.discoveryOverride = () =>
          new Response("<html>", { headers: { "content-type": "text/html" } })),
    ],
    [
      "a document over 64 KiB",
      () =>
        (idp.discoveryOverride = () =>
          Response.json({ issuer: idp.url, pad: "x".repeat(SSO_HTTP_MAX_BYTES) })),
    ],
  ];

  for (const [name, arrange] of failures) {
    test(`${name}: discovery_failed`, async () => {
      arrange();
      const started = await startSsoFlow({
        provider: provider(),
        baseUrl: BASE_URL,
        purpose: "login",
      });
      expect(started).toEqual({ ok: false, reason: "discovery_failed" });
    });
  }

  test("a timeout: discovery_failed, without waiting for the provider", async () => {
    idp.discoveryDelayMs = 1000;
    const startedAt = Date.now();
    const started = await startSsoFlow({
      provider: provider(),
      baseUrl: BASE_URL,
      purpose: "login",
      http: { timeoutMs: 100 },
    });
    expect(started).toEqual({ ok: false, reason: "discovery_failed" });
    expect(Date.now() - startedAt).toBeLessThan(900);
  });

  test("an unreachable provider: discovery_failed", async () => {
    const started = await startSsoFlow({
      provider: provider({ issuer: "http://127.0.0.1:1" }),
      baseUrl: BASE_URL,
      purpose: "login",
    });
    expect(started).toEqual({ ok: false, reason: "discovery_failed" });
  });

  test("a failed callback discovery: discovery_failed after the cookie checks", async () => {
    const { authorizationUrl, flowCookie } = await start();
    clearSsoDiscoveryCache();
    idp.discoveryOverride = () => new Response("", { status: 503 });
    const result = await completeSsoCallback({
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie,
      params: idp.issueCode(authorizationUrl),
    });
    expect(reasonOf(result)).toBe("discovery_failed");
  });
});

describe("logging", () => {
  /**
   * Spies on the `logger` object itself, not on `console`: another test
   * file may have replaced the logger module (`mock.module` leaks across
   * files), and the service and this file share whichever object it is.
   */
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  /** Every warn call so far, message and fields, as one string. */
  function warned(): string {
    return warn.mock.calls
      .map((call: unknown[]) =>
        call
          .map((part) => (typeof part === "string" ? part : JSON.stringify(part)))
          .join(" "),
      )
      .join("\n");
  }

  test("a refused callback logs the provider and reason, never a secret or a code", async () => {
    idp.claimOverrides = { nonce: "forged-nonce" };
    const { authorizationUrl, flowCookie } = await start();
    const params = idp.issueCode(authorizationUrl);
    const result = await completeSsoCallback({
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie,
      params,
    });
    expect(reasonOf(result)).toBe("id_token_invalid");
    const logged = warned();
    expect(logged).toContain("SSO callback refused");
    expect(logged).toContain('"provider":"corp"');
    expect(logged).toContain('"reason":"id_token_invalid"');
    for (const secret of [
      idp.clientSecret,
      params.get("code") ?? "missing",
      flowCookie,
      "fake-access-token",
      "forged-nonce",
      "alice@example.com",
    ]) {
      expect(logged.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  test("a failed discovery logs the provider and a short reason", async () => {
    idp.documentIssuer = "https://evil.example.com";
    expect(await getSsoProviderMetadata(provider())).toBeNull();
    const logged = warned();
    expect(logged).toContain("SSO discovery failed");
    expect(logged).toContain('"reason":"issuer_mismatch"');
  });
});

describe("the flow cookie", () => {
  const key = deriveSsoFlowKey(randomBytes(32));
  const login = {
    v: 1,
    provider: "corp",
    purpose: "login",
    state: "s".repeat(43),
    nonce: "n".repeat(43),
    codeVerifier: "c".repeat(43),
    exp: 2_000_000_000,
  } as const;

  test("round-trips a login and a link payload", () => {
    expect(openSsoFlow(sealSsoFlow(login, key), key)).toEqual(login);
    const link = { ...login, purpose: "link", sessionId: "ses_1" } as const;
    expect(openSsoFlow(sealSsoFlow(link, key), key)).toEqual(link);
  });

  test("refuses a payload of the wrong shape", () => {
    const seal = (value: unknown): string => sealSsoFlowUnchecked(value, key);
    expect(openSsoFlow(seal({ ...login, v: 2 }), key)).toBeNull();
    expect(openSsoFlow(seal({ ...login, sessionId: "ses_1" }), key)).toBeNull();
    expect(openSsoFlow(seal({ ...login, purpose: "link" }), key)).toBeNull();
    expect(openSsoFlow(seal({ ...login, purpose: "admin" }), key)).toBeNull();
    expect(openSsoFlow(seal({ ...login, state: "" }), key)).toBeNull();
    expect(openSsoFlow(seal({ ...login, exp: "soon" }), key)).toBeNull();
    expect(openSsoFlow(seal([login]), key)).toBeNull();
    expect(openSsoFlow(seal("login"), key)).toBeNull();
  });

  test("the key is HKDF-derived and differs from the master and from other uses", () => {
    const master = randomBytes(32);
    const derived = deriveSsoFlowKey(master);
    expect(derived).toHaveLength(32);
    expect(derived.equals(master)).toBe(false);
    expect(deriveSsoFlowKey(master).equals(derived)).toBe(true);
  });

  test("Set-Cookie: HttpOnly, SameSite=Lax, Path=/dashboard, Max-Age, Secure when asked", () => {
    expect(ssoFlowSetCookie("abc", true, SSO_FLOW_TTL_SECONDS)).toBe(
      "bm_sso=abc; HttpOnly; SameSite=Lax; Secure; Path=/dashboard; Max-Age=600",
    );
    expect(ssoFlowSetCookie("abc", false, 600)).toBe(
      "bm_sso=abc; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=600",
    );
    expect(clearSsoFlowCookie(true)).toBe(
      "bm_sso=; HttpOnly; SameSite=Lax; Secure; Path=/dashboard; Max-Age=0",
    );
  });

  test("read back from a Cookie header by exact name", () => {
    expect(readSsoFlowCookie("bm_session=x; bm_sso=v1:a:b:c")).toBe("v1:a:b:c");
    expect(readSsoFlowCookie("xbm_sso=nope")).toBeUndefined();
    expect(readSsoFlowCookie(null)).toBeUndefined();
  });
});

/**
 * Seals any JSON value the way `sealSsoFlow` does, so the shape checks of
 * `openSsoFlow` can be fed payloads the type would not allow.
 */
function sealSsoFlowUnchecked(value: unknown, key: Buffer): string {
  return encryptSecret(JSON.stringify(value), key);
}
