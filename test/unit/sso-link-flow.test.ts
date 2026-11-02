import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SsoProviderSettings } from "../../src/config.ts";
import { clearSsoDiscoveryCache } from "../../src/modules/users/services/sso-discovery.service.ts";
import {
  finishSsoLinkCallback,
  type SsoLinkCallbackDeps,
} from "../../src/modules/users/services/sso-link-flow.service.ts";
import {
  auditProviderOf,
  ownerNeedsSecondFactor,
  providerOfLink,
  ssoLinkName,
  ssoProviderKey,
  unconfiguredLinkLabel,
} from "../../src/modules/users/services/sso-link-policy.service.ts";
import { startSsoFlow } from "../../src/modules/users/services/sso.service.ts";
import type { ActiveSession } from "../../src/modules/users/types/user.types.ts";
import { FakeOidcProvider } from "../fixtures/fake-oidc-provider.ts";

/**
 * The link callback of SSO (#224, part 2) against the in-process provider
 * (`test/fixtures/fake-oidc-provider.ts`), through the real flow checks of
 * `completeSsoCallback`, with the session lookup and the link write
 * replaced: which checks run, in which order, and what reaches the link.
 * Also the pure link rules (`sso-link-policy.service.ts`).
 */

const BASE_URL = "https://mail.example.com";
const CLIENT = { ip: "203.0.113.7", userAgent: "test" };
const TOKEN = "a".repeat(43);

let idp: FakeOidcProvider;

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

/** The browser's live session the fake lookup returns. */
const SESSION: ActiveSession = {
  sessionId: "ses_start",
  userId: "usr_1",
  email: "member@example.com",
  role: "member",
  assurance: "password",
  hasSecondFactor: false,
  hasSsoLink: false,
  matched: "current",
  rotationDue: false,
  graceOver: false,
};

/** Fake deps recording what they were asked. */
function fakeDeps(
  options: {
    session?: ActiveSession | null;
    refuse?: "already_linked" | "session_changed";
  } = {},
): SsoLinkCallbackDeps & {
  lookups: string[];
  links: Array<Parameters<SsoLinkCallbackDeps["link"]>[0]>;
  refusals: Array<[string | null, string, string]>;
} {
  const lookups: string[] = [];
  const links: Array<Parameters<SsoLinkCallbackDeps["link"]>[0]> = [];
  const refusals: Array<[string | null, string, string]> = [];
  return {
    lookups,
    links,
    refusals,
    refuse: (userId, refusedAt, reason) => {
      refusals.push([userId, refusedAt.id, reason]);
      return Promise.resolve();
    },
    findSession: (token) => {
      lookups.push(token);
      return Promise.resolve(options.session === undefined ? SESSION : options.session);
    },
    link: (input) => {
      links.push(input);
      if (input.session === null || input.session.sessionId !== input.flowSessionId) {
        return Promise.resolve({
          ok: false,
          reason: "session_changed",
          userId: input.session?.userId ?? null,
        });
      }
      if (options.refuse) {
        return Promise.resolve({ ok: false, reason: options.refuse, userId: "usr_1" });
      }
      return Promise.resolve({ ok: true, linkId: "crd_new", name: input.name });
    },
  };
}

/** Starts a flow with BunMail's own start, as the Link button does. */
async function started(
  purpose: "link" | "login" = "link",
): Promise<{ authorizationUrl: string; flowCookie: string }> {
  const result = await startSsoFlow(
    purpose === "link"
      ? { provider: provider(), baseUrl: BASE_URL, purpose, sessionId: SESSION.sessionId }
      : { provider: provider(), baseUrl: BASE_URL, purpose },
  );
  if (!result.ok) throw new Error(result.reason);
  return result;
}

/** Runs the callback for a started flow. */
function finish(
  flow: { authorizationUrl: string; flowCookie: string | undefined },
  deps: SsoLinkCallbackDeps,
  options: { params?: URLSearchParams; sessionToken?: string | undefined } = {},
): ReturnType<typeof finishSsoLinkCallback> {
  return finishSsoLinkCallback(
    {
      provider: provider(),
      baseUrl: BASE_URL,
      flowCookie: flow.flowCookie,
      params: options.params ?? idp.issueCode(flow.authorizationUrl),
      sessionToken: "sessionToken" in options ? options.sessionToken : TOKEN,
      client: CLIENT,
    },
    deps,
  );
}

describe("finishSsoLinkCallback", () => {
  test("a valid link flow: the live session is read, then the identity is linked to it", async () => {
    const deps = fakeDeps();
    const outcome = await finish(await started(), deps);
    expect(outcome).toEqual({
      ok: true,
      userId: "usr_1",
      email: "member@example.com",
      sessionId: "ses_start",
      linkId: "crd_new",
      name: "alice@example.com",
    });
    expect(deps.lookups).toEqual([TOKEN]);
    expect(deps.links).toEqual([
      {
        flowSessionId: "ses_start",
        session: SESSION,
        provider: { key: `oidc:${idp.url}`, id: "corp", label: "Corp" },
        sub: "user-123",
        name: "alice@example.com",
      },
    ]);
  });

  test("a failed flow check stops before the link; with a live session it is recorded as flow_failed", async () => {
    const flow = await started();
    const params = idp.issueCode(flow.authorizationUrl);
    params.set("state", "forged");
    const deps = fakeDeps();
    expect(await finish(flow, deps, { params })).toEqual({
      ok: false,
      stage: "flow",
      reason: "state_mismatch",
    });
    expect(idp.hitCount("/token")).toBe(0);
    expect(deps.lookups).toEqual([TOKEN]);
    expect(deps.links).toEqual([]);
    expect(deps.refusals).toEqual([["usr_1", "corp", "flow_failed"]]);
  });

  test("a failed flow check without a known user: no record, only the log", async () => {
    const flow = await started();
    const params = idp.issueCode(flow.authorizationUrl);
    params.set("state", "forged");
    const noCookie = fakeDeps();
    await finish(flow, noCookie, { params, sessionToken: undefined });
    expect(noCookie.lookups).toEqual([]);
    expect(noCookie.refusals).toEqual([]);

    const deadSession = fakeDeps({ session: null });
    await finish(await started(), deadSession, {
      params: new URLSearchParams({ state: "forged", code: "x" }),
    });
    expect(deadSession.lookups).toEqual([TOKEN]);
    expect(deadSession.refusals).toEqual([]);
  });

  test("no flow cookie: refused before any provider call", async () => {
    const deps = fakeDeps();
    const flow = await started();
    expect(await finish({ ...flow, flowCookie: undefined }, deps)).toMatchObject({
      stage: "flow",
      reason: "flow_missing",
    });
    expect(idp.hitCount("/token")).toBe(0);
  });

  test("a replayed callback is refused at the flow stage, the link written once", async () => {
    const flow = await started();
    const params = idp.issueCode(flow.authorizationUrl);
    const deps = fakeDeps();
    expect((await finish(flow, deps, { params })).ok).toBe(true);
    expect(await finish(flow, deps, { params })).toEqual({
      ok: false,
      stage: "flow",
      reason: "flow_replayed",
    });
    expect(deps.links).toHaveLength(1);
    expect(deps.refusals).toEqual([["usr_1", "corp", "flow_failed"]]);
    expect(idp.hitCount("/token")).toBe(1);
  });

  test("a sign-in flow is refused (purpose), nothing read or linked", async () => {
    const deps = fakeDeps();
    expect(await finish(await started("login"), deps)).toEqual({
      ok: false,
      stage: "purpose",
    });
    expect(deps.lookups).toEqual([]);
    expect(deps.links).toEqual([]);
  });

  test("no session cookie: no lookup, and the link is refused as session_changed", async () => {
    const deps = fakeDeps();
    expect(await finish(await started(), deps, { sessionToken: undefined })).toEqual({
      ok: false,
      stage: "link",
      reason: "session_changed",
      userId: null,
    });
    expect(deps.lookups).toEqual([]);
    expect(deps.links.map((l) => l.session)).toEqual([null]);
  });

  test("another live session than the one that started the link: session_changed", async () => {
    const deps = fakeDeps({ session: { ...SESSION, sessionId: "ses_other" } });
    expect(await finish(await started(), deps)).toEqual({
      ok: false,
      stage: "link",
      reason: "session_changed",
      userId: "usr_1",
    });
  });

  test("a refusal of the link is passed on", async () => {
    const deps = fakeDeps({ refuse: "already_linked" });
    expect(await finish(await started(), deps)).toEqual({
      ok: false,
      stage: "link",
      reason: "already_linked",
      userId: "usr_1",
    });
  });

  test("without an email claim, the name claim labels the link", async () => {
    idp.claimOverrides = { email: undefined };
    const deps = fakeDeps();
    await finish(await started(), deps);
    expect(deps.links.map((l) => l.name)).toEqual(["Alice Example"]);
  });
});

describe("sso-link-policy", () => {
  test("a link is keyed by the issuer, never by the provider id", () => {
    expect(ssoProviderKey("https://idp.example.com/realms/x")).toBe(
      "oidc:https://idp.example.com/realms/x",
    );
  });

  test("the link's name: the email, else the name claim, when it fits 100 characters", () => {
    const long = `${"a".repeat(60)}@${"b".repeat(50)}.example`;
    expect(ssoLinkName({ email: "a@example.com", name: "A" })).toBe("a@example.com");
    expect(ssoLinkName({ email: long, name: "A" })).toBe("A");
    expect(ssoLinkName({ email: null, name: "x".repeat(101) })).toBeNull();
    expect(ssoLinkName({ email: null, name: null })).toBeNull();
  });

  test("control and format characters are removed from the link's name", () => {
    expect(ssoLinkName({ email: null, name: "Ali\u202Eecia\u200B\u0007 " })).toBe(
      "Aliecia",
    );
    expect(ssoLinkName({ email: null, name: "\u200B\u202E" })).toBeNull();
    /** Counted in characters, as Postgres does. */
    expect(ssoLinkName({ email: null, name: "\u{1F511}".repeat(100) })).toBe(
      "\u{1F511}".repeat(100),
    );
  });

  test("a stored link maps back to its configured provider, or to its issuer's host", () => {
    const providers = [provider()];
    const key = ssoProviderKey(idp.url);
    expect(providerOfLink(key, providers)?.id).toBe("corp");
    expect(providerOfLink("oidc:https://gone.example.org", providers)).toBeNull();
    expect(auditProviderOf(key, providers)).toEqual({ id: "corp", label: "Corp" });
    expect(auditProviderOf("oidc:https://gone.example.org/realm", providers)).toEqual({
      id: "oidc:https://gone.example.org/realm",
      label: "gone.example.org",
    });
    expect(unconfiguredLinkLabel("oidc:not a url")).toBe("not a url");
  });

  test("the owner needs a second factor to link; other roles do not", () => {
    expect(ownerNeedsSecondFactor("owner", false)).toBe(true);
    expect(ownerNeedsSecondFactor("owner", true)).toBe(false);
    expect(ownerNeedsSecondFactor("admin", false)).toBe(false);
    expect(ownerNeedsSecondFactor("member", false)).toBe(false);
  });
});
