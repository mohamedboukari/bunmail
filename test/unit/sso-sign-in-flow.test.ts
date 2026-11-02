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
import type { SsoProviderSettings } from "../../src/config.ts";
import { logger } from "../../src/utils/logger.ts";
import { clearSsoDiscoveryCache } from "../../src/modules/users/services/sso-discovery.service.ts";
import {
  ssoFlowPurposeOf,
  deriveSsoFlowKey,
} from "../../src/modules/users/services/sso-flow-cookie.service.ts";
import { ssoSignInRefusal } from "../../src/modules/users/services/sso-link-policy.service.ts";
import {
  finishSsoSignInCallback,
  type SsoSignInCallbackDeps,
} from "../../src/modules/users/services/sso-sign-in-flow.service.ts";
import {
  startSsoFlow,
  warnSsoAutoLinkNotImplemented,
} from "../../src/modules/users/services/sso.service.ts";
import type {
  SsoSignInDecision,
  SsoSignInRefusal,
} from "../../src/modules/users/types/sso.types.ts";
import { FakeOidcProvider } from "../fixtures/fake-oidc-provider.ts";

/**
 * The sign-in half of the SSO callback (#224, part 3) against the
 * in-process provider (`test/fixtures/fake-oidc-provider.ts`), through the
 * real flow checks of `completeSsoCallback`, with the identity lookup, the
 * session write and the audit record replaced: which checks run, in which
 * order, what is looked up (never the email), which assurance comes out,
 * what is recorded, and that nothing secret reaches the log. Also the pure
 * sign-in rules (`ssoSignInRefusal`) and the purpose read of the callback.
 */

const BASE_URL = "https://mail.example.com";
const CLIENT = { ip: "203.0.113.7", userAgent: "test" };

let idp: FakeOidcProvider;
let logged: unknown[][];
let spies: Array<{ mockRestore: () => void }>;

beforeAll(async () => {
  idp = await FakeOidcProvider.start();
});

afterAll(async () => {
  await idp.stop();
});

beforeEach(() => {
  clearSsoDiscoveryCache();
  idp.claimOverrides = {};
  idp.hits.clear();
  logged = [];
  spies = (["debug", "info", "warn", "error"] as const).map((level) =>
    spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      logged.push(args);
    }),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

/** The provider settings BunMail would read for the fake provider. */
function provider(): SsoProviderSettings {
  return {
    id: "corp",
    issuer: idp.url,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    label: "Corp",
    scopes: "openid email profile",
    allowedDomains: [],
    autoLink: false,
  };
}

/** A decision of the fake lookup. */
function allowed(assurance: "pending" | "password"): SsoSignInDecision {
  return {
    ok: true,
    userId: "usr_1",
    email: "member@example.com",
    linkId: "crd_link",
    assurance,
  };
}

/** Fake deps recording every call, in order, in one list. */
function fakeDeps(
  options: {
    decision?: SsoSignInDecision;
    /** What the session write decides under the lock (default: the lookup's decision). */
    openDecision?: SsoSignInDecision;
  } = {},
): SsoSignInCallbackDeps & {
  calls: string[];
  lookups: unknown[];
  failures: Array<[string | null, string, string]>;
} {
  const decision = options.decision ?? allowed("password");
  const openDecision = options.openDecision ?? decision;
  const calls: string[] = [];
  const lookups: unknown[] = [];
  const failures: Array<[string | null, string, string]> = [];
  return {
    calls,
    lookups,
    failures,
    resolve: (identity) => {
      calls.push("resolve");
      lookups.push(identity);
      return Promise.resolve(decision);
    },
    open: (identity) => {
      calls.push("open");
      lookups.push(identity);
      return Promise.resolve(
        openDecision.ok
          ? { ...openDecision, sessionId: "ses_new", token: "t".repeat(43) }
          : openDecision,
      );
    },
    recordFailure: (userId, providerId, reason) => {
      calls.push("recordFailure");
      failures.push([userId, providerId, reason]);
      return Promise.resolve();
    },
  };
}

/** Starts a flow with BunMail's own start, as the login button does. */
async function started(
  purpose: "login" | "link" = "login",
  now?: number,
): Promise<{ authorizationUrl: string; flowCookie: string }> {
  const base = { provider: provider(), baseUrl: BASE_URL };
  const result = await startSsoFlow(
    purpose === "link"
      ? { ...base, purpose, sessionId: "ses_start", ...(now ? { now } : {}) }
      : { ...base, purpose, ...(now ? { now } : {}) },
  );
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/** Runs the sign-in callback for a started flow; `replaced` counts the previous-session step. */
async function finish(
  flow: { authorizationUrl: string; flowCookie: string | undefined },
  deps: ReturnType<typeof fakeDeps>,
  params?: URLSearchParams,
): ReturnType<typeof finishSsoSignInCallback> {
  return finishSsoSignInCallback(
    {
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie: flow.flowCookie,
      params: params ?? idp.issueCode(flow.authorizationUrl),
      client: CLIENT,
      replacePreviousSession: () => {
        deps.calls.push("replace");
        return Promise.resolve();
      },
    },
    deps,
  );
}

describe("finishSsoSignInCallback: success", () => {
  test("no second factor: lookup by (issuer, sub), the previous session replaced, then a password-level session", async () => {
    const deps = fakeDeps();
    const outcome = await finish(await started(), deps);
    expect(outcome).toEqual({
      ok: true,
      userId: "usr_1",
      email: "member@example.com",
      linkId: "crd_link",
      assurance: "password",
      sessionId: "ses_new",
      token: "t".repeat(43),
    });
    expect(deps.calls).toEqual(["resolve", "replace", "open"]);
    expect(deps.lookups).toEqual([
      { providerKey: `oidc:${idp.url}`, sub: "user-123" },
      { providerKey: `oidc:${idp.url}`, sub: "user-123", providerId: "corp" },
    ]);
    expect(deps.failures).toEqual([]);
    expect(idp.hitCount("/token")).toBe(1);
  });

  test("a second factor: the session is pending (the second step follows)", async () => {
    const deps = fakeDeps({ decision: allowed("pending") });
    const outcome = await finish(await started(), deps);
    expect(outcome).toMatchObject({ ok: true, assurance: "pending" });
  });

  test("the email claim is never the key: another email, same subject, same lookup", async () => {
    idp.claimOverrides = { email: "owner@example.com", email_verified: true };
    const deps = fakeDeps();
    await finish(await started(), deps);
    expect(deps.lookups[0]).toEqual({ providerKey: `oidc:${idp.url}`, sub: "user-123" });
  });
});

describe("finishSsoSignInCallback: account refusals", () => {
  const refusals: Array<[SsoSignInRefusal, string | null]> = [
    ["unknown_identity", null],
    ["deactivated", "usr_1"],
    ["owner_second_factor_required", "usr_1"],
  ];
  for (const [reason, userId] of refusals) {
    test(`${reason}: recorded, the previous session kept, no session opened`, async () => {
      const deps = fakeDeps({ decision: { ok: false, reason, userId } });
      expect(await finish(await started(), deps)).toEqual({
        ok: false,
        stage: "account",
        reason,
        userId,
      });
      expect(deps.calls).toEqual(["resolve", "recordFailure"]);
      expect(deps.failures).toEqual([[userId, "corp", reason]]);
    });
  }

  test("decided again under the lock: a link removed meanwhile is refused and recorded", async () => {
    const deps = fakeDeps({
      openDecision: { ok: false, reason: "unknown_identity", userId: null },
    });
    expect(await finish(await started(), deps)).toEqual({
      ok: false,
      stage: "account",
      reason: "unknown_identity",
      userId: null,
    });
    expect(deps.calls).toEqual(["resolve", "replace", "open", "recordFailure"]);
    expect(deps.failures).toEqual([[null, "corp", "unknown_identity"]]);
  });
});

describe("finishSsoSignInCallback: flow refusals", () => {
  test("state mismatch: recorded with no account, before any token request or lookup", async () => {
    const flow = await started();
    const params = idp.issueCode(flow.authorizationUrl);
    params.set("state", "forged");
    const deps = fakeDeps();
    expect(await finish(flow, deps, params)).toEqual({
      ok: false,
      stage: "flow",
      reason: "state_mismatch",
    });
    expect(idp.hitCount("/token")).toBe(0);
    expect(deps.calls).toEqual(["recordFailure"]);
    expect(deps.failures).toEqual([[null, "corp", "state_mismatch"]]);
  });

  test("no flow cookie: flow_missing, nothing called at the provider", async () => {
    const deps = fakeDeps();
    const flow = await started();
    expect(await finish({ ...flow, flowCookie: undefined }, deps)).toMatchObject({
      stage: "flow",
      reason: "flow_missing",
    });
    expect(idp.hitCount("/token")).toBe(0);
  });

  test("an expired flow: flow_expired", async () => {
    const deps = fakeDeps();
    const flow = await started("login", Date.now() - 11 * 60 * 1000);
    expect(await finish(flow, deps)).toMatchObject({
      stage: "flow",
      reason: "flow_expired",
    });
    expect(deps.failures).toEqual([[null, "corp", "flow_expired"]]);
  });

  test("a replayed callback: flow_replayed, one token request, one session", async () => {
    const flow = await started();
    const params = idp.issueCode(flow.authorizationUrl);
    const deps = fakeDeps();
    expect((await finish(flow, deps, params)).ok).toBe(true);
    expect(await finish(flow, deps, params)).toMatchObject({
      stage: "flow",
      reason: "flow_replayed",
    });
    expect(deps.calls.filter((c) => c === "open")).toHaveLength(1);
    expect(idp.hitCount("/token")).toBe(1);
  });

  test("the provider's error answer: provider_error", async () => {
    const flow = await started();
    const state = new URL(flow.authorizationUrl).searchParams.get("state") ?? "";
    const deps = fakeDeps();
    const params = new URLSearchParams({ error: "access_denied", state });
    expect(await finish(flow, deps, params)).toMatchObject({
      stage: "flow",
      reason: "provider_error",
    });
    expect(deps.failures).toEqual([[null, "corp", "provider_error"]]);
  });

  test("an ID token for another client: id_token_invalid, no lookup", async () => {
    idp.claimOverrides = { aud: "someone-else" };
    const deps = fakeDeps();
    expect(await finish(await started(), deps)).toMatchObject({
      stage: "flow",
      reason: "id_token_invalid",
    });
    expect(deps.lookups).toEqual([]);
  });

  test("a link flow is not a sign-in: refused (purpose), nothing looked up or recorded", async () => {
    const deps = fakeDeps();
    expect(await finish(await started("link"), deps)).toEqual({
      ok: false,
      stage: "purpose",
    });
    expect(deps.calls).toEqual([]);
  });
});

describe("no secret reaches the log", () => {
  test("neither the code, the state, the subject, the email nor a token, on success or failure", async () => {
    const flow = await started();
    const params = idp.issueCode(flow.authorizationUrl);
    await finish(flow, fakeDeps(), params);
    /** A refusal after the provider round trip logs too. */
    const second = await started();
    const secondParams = idp.issueCode(second.authorizationUrl);
    await finish(
      second,
      fakeDeps({ decision: { ok: false, reason: "unknown_identity", userId: null } }),
      secondParams,
    );
    const text = JSON.stringify(logged);
    for (const secret of [
      params.get("code") ?? "missing",
      params.get("state") ?? "missing",
      secondParams.get("code") ?? "missing",
      "user-123",
      "alice@example.com",
      "Alice@Example.com",
      "fake-access-token",
      idp.clientSecret,
      flow.flowCookie,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("ssoSignInRefusal", () => {
  test("in order: no account, a disabled one, then the owner rule", () => {
    expect(ssoSignInRefusal(null)).toBe("unknown_identity");
    expect(
      ssoSignInRefusal({ disabled: true, role: "owner", hasSecondFactor: false }),
    ).toBe("deactivated");
    expect(
      ssoSignInRefusal({ disabled: false, role: "owner", hasSecondFactor: false }),
    ).toBe("owner_second_factor_required");
  });

  test("the owner with a second factor, and every other role, may sign in", () => {
    expect(
      ssoSignInRefusal({ disabled: false, role: "owner", hasSecondFactor: true }),
    ).toBeNull();
    expect(
      ssoSignInRefusal({ disabled: false, role: "admin", hasSecondFactor: false }),
    ).toBeNull();
    expect(
      ssoSignInRefusal({ disabled: false, role: "member", hasSecondFactor: false }),
    ).toBeNull();
  });
});

describe("ssoFlowPurposeOf", () => {
  test("the purpose of a cookie that opens; null for none, a forged one or another key's", async () => {
    const key = deriveSsoFlowKey(Buffer.alloc(32, 7));
    const login = await startSsoFlow({
      provider: provider(),
      baseUrl: BASE_URL,
      purpose: "login",
      key,
    });
    const link = await startSsoFlow({
      provider: provider(),
      baseUrl: BASE_URL,
      purpose: "link",
      sessionId: "ses_1",
      key,
    });
    if (!login.ok || !link.ok) throw new Error("start failed");
    expect(ssoFlowPurposeOf(login.flowCookie, key)).toBe("login");
    expect(ssoFlowPurposeOf(link.flowCookie, key)).toBe("link");
    expect(ssoFlowPurposeOf(undefined, key)).toBeNull();
    expect(ssoFlowPurposeOf("v1:forged", key)).toBeNull();
    expect(
      ssoFlowPurposeOf(login.flowCookie, deriveSsoFlowKey(Buffer.alloc(32, 8))),
    ).toBeNull();
  });
});

describe("removedLinkFacts (the reset email, #224)", () => {
  test("a configured provider by its label, a removed one by its issuer's host, the account as named", async () => {
    const { config } = await import("../../src/config.ts");
    const { removedLinkFacts } = await import("../../src/pages/lib/sso.ts");
    const original = config.sso;
    expect(
      Reflect.set(config, "sso", { providers: [provider()], baseUrl: BASE_URL }),
    ).toBe(true);
    try {
      expect(
        removedLinkFacts([
          { id: "crd_1", provider: `oidc:${idp.url}`, name: "alice@example.com" },
          { id: "crd_2", provider: "oidc:https://gone.example.org/realm", name: null },
        ]),
      ).toEqual([
        { provider: "Corp", account: "alice@example.com" },
        { provider: "gone.example.org", account: null },
      ]);
    } finally {
      expect(Reflect.set(config, "sso", original)).toBe(true);
    }
  });
});

describe("warnSsoAutoLinkNotImplemented (until #224 part 4)", () => {
  test("one boot warn per provider with AUTO_LINK=true, naming its setting; none otherwise", () => {
    const providers = [
      { ...provider(), id: "corp", autoLink: true },
      { ...provider(), id: "google", autoLink: false },
      { ...provider(), id: "my-idp", autoLink: true },
    ];
    expect(warnSsoAutoLinkNotImplemented(providers)).toEqual(["corp", "my-idp"]);
    expect(logged).toEqual([
      [
        "SSO auto-link is not implemented yet; identities must be linked under Account > Sign-in methods",
        { provider: "corp", setting: "SSO_CORP_AUTO_LINK" },
      ],
      [
        "SSO auto-link is not implemented yet; identities must be linked under Account > Sign-in methods",
        { provider: "my-idp", setting: "SSO_MY_IDP_AUTO_LINK" },
      ],
    ]);
    logged.length = 0;
    expect(warnSsoAutoLinkNotImplemented([provider()])).toEqual([]);
    expect(logged).toEqual([]);
  });
});

describe("the callback's uncounted refusals (#224, review M1)", () => {
  test("an embedded request (Sec-Fetch-Dest not document) or no flow cookie is refused before counting", async () => {
    const { uncountedCallbackRefusal } = await import("../../src/pages/lib/sso.ts");
    const headers = (dest?: string): Headers =>
      new Headers(dest === undefined ? {} : { "sec-fetch-dest": dest });
    expect(uncountedCallbackRefusal(headers("image"), "v1:cookie")).toBe(
      "not_a_navigation",
    );
    expect(uncountedCallbackRefusal(headers("iframe"), "v1:cookie")).toBe(
      "not_a_navigation",
    );
    expect(uncountedCallbackRefusal(headers("script"), undefined)).toBe(
      "not_a_navigation",
    );
    expect(uncountedCallbackRefusal(headers("document"), undefined)).toBe(
      "no_flow_cookie",
    );
    expect(uncountedCallbackRefusal(headers(), undefined)).toBe("no_flow_cookie");
    /** A top-level navigation with a flow cookie, or an older browser without the header: counted. */
    expect(uncountedCallbackRefusal(headers("document"), "v1:cookie")).toBeNull();
    expect(uncountedCallbackRefusal(headers(), "v1:cookie")).toBeNull();
  });
});

describe("the start budget and the alert label (#224, review L1, L3)", () => {
  test("the start key is per address bucket, an IPv6 /64 as one", async () => {
    const { ssoStartKey, SSO_START_MAX, SSO_START_WINDOW_MS } =
      await import("../../src/pages/lib/sso.ts");
    expect(ssoStartKey("203.0.113.7")).toBe("sso-start:ip:203.0.113.7");
    expect(ssoStartKey("2001:db8:1:2::5")).toBe(ssoStartKey("2001:db8:1:2:ffff::9"));
    expect(ssoStartKey("::ffff:203.0.113.7")).toBe("sso-start:ip:203.0.113.7");
    expect(SSO_START_MAX).toBe(20);
    expect(SSO_START_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  test("a stored link's provider label for the new-device alert; nothing for other first factors", async () => {
    const { config } = await import("../../src/config.ts");
    const { ssoProviderLabelOf } = await import("../../src/pages/lib/sso.ts");
    const original = config.sso;
    expect(
      Reflect.set(config, "sso", { providers: [provider()], baseUrl: BASE_URL }),
    ).toBe(true);
    try {
      expect(ssoProviderLabelOf(`oidc:${idp.url}`)).toBe("Corp");
      expect(ssoProviderLabelOf("oidc:https://gone.example.org/x")).toBe(
        "gone.example.org",
      );
      expect(ssoProviderLabelOf(null)).toBeUndefined();
      expect(ssoProviderLabelOf(undefined)).toBeUndefined();
    } finally {
      expect(Reflect.set(config, "sso", original)).toBe(true);
    }
  });
});
