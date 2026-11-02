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
  ssoAutoLinkEmail,
  ssoAutoLinkRefusal,
} from "../../src/modules/users/services/sso-link-policy.service.ts";
import {
  finishSsoSignInCallback,
  type SsoSignInCallbackDeps,
} from "../../src/modules/users/services/sso-sign-in-flow.service.ts";
import { startSsoFlow } from "../../src/modules/users/services/sso.service.ts";
import type {
  AutoLinkSsoResult,
  SsoAutoLinkDecision,
  SsoAutoLinkRefusal,
  SsoSignInDecision,
} from "../../src/modules/users/types/sso.types.ts";
import { FakeOidcProvider } from "../fixtures/fake-oidc-provider.ts";

/**
 * Linking by verified email at sign-in (#224, part 4), through the real
 * flow checks of `completeSsoCallback` against the in-process provider
 * (`test/fixtures/fake-oidc-provider.ts`), with the lookups, the writes and
 * the audit record replaced: which claims let an unknown identity be
 * linked (`email_verified` must be the boolean `true`, allowed domains,
 * Google's `hd`), in which order the steps run, what is recorded, that
 * auto-link off and linked identities behave as before, and that nothing
 * secret reaches the log. Also the pure rules (`ssoAutoLinkEmail`,
 * `ssoAutoLinkRefusal`). The provider's default ID token says
 * `Alice@Example.com`, verified.
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

/** The fake provider with auto-link on for `example.com` (or as overridden). */
function provider(overrides: Partial<SsoProviderSettings> = {}): SsoProviderSettings {
  return {
    id: "corp",
    issuer: idp.url,
    clientId: idp.clientId,
    clientSecret: idp.clientSecret,
    label: "Corp",
    scopes: "openid email profile",
    allowedDomains: ["example.com"],
    autoLink: true,
    ...overrides,
  };
}

/** Fake deps recording every call, in order, in one list. */
function fakeDeps(
  options: {
    decision?: SsoSignInDecision;
    autoLinkDecision?: SsoAutoLinkDecision;
    linked?: AutoLinkSsoResult;
  } = {},
): SsoSignInCallbackDeps & {
  calls: string[];
  inputs: unknown[];
  failures: Array<[string | null, string, string]>;
} {
  const calls: string[] = [];
  const inputs: unknown[] = [];
  const failures: Array<[string | null, string, string]> = [];
  return {
    calls,
    inputs,
    failures,
    resolve: () => {
      calls.push("resolve");
      return Promise.resolve(
        options.decision ?? { ok: false, reason: "unknown_identity", userId: null },
      );
    },
    open: () => {
      calls.push("open");
      return Promise.resolve({
        ok: true,
        userId: "usr_1",
        email: "alice@example.com",
        linkId: "crd_link",
        assurance: "password",
        sessionId: "ses_new",
        token: "t".repeat(43),
      });
    },
    recordFailure: (userId, providerId, reason) => {
      calls.push("recordFailure");
      failures.push([userId, providerId, reason]);
      return Promise.resolve();
    },
    resolveAutoLink: (target) => {
      calls.push("resolveAutoLink");
      inputs.push(target);
      return Promise.resolve(options.autoLinkDecision ?? { ok: true, userId: "usr_1" });
    },
    autoLink: (input) => {
      calls.push("autoLink");
      inputs.push(input);
      return Promise.resolve(
        options.linked ?? {
          ok: true,
          userId: "usr_1",
          email: "alice@example.com",
          linkId: "crd_auto",
          assurance: "password",
          sessionId: "ses_new",
          token: "t".repeat(43),
          autoLinked: { name: input.name },
        },
      );
    },
  };
}

/** A full sign-in callback with BunMail's own start; `replace` marks the previous-session step. */
async function signIn(
  deps: ReturnType<typeof fakeDeps>,
  settings: SsoProviderSettings = provider(),
): ReturnType<typeof finishSsoSignInCallback> {
  const started = await startSsoFlow({
    provider: settings,
    baseUrl: BASE_URL,
    purpose: "login",
  });
  if (!started.ok) throw new Error(started.reason);
  return finishSsoSignInCallback(
    {
      provider: settings,
      baseUrl: BASE_URL,
      flowCookie: started.flowCookie,
      params: idp.issueCode(started.authorizationUrl),
      client: CLIENT,
      replacePreviousSession: () => {
        deps.calls.push("replace");
        return Promise.resolve();
      },
    },
    deps,
  );
}

describe("auto-link: success", () => {
  test("an unknown identity with a verified, allowed email: checked, the previous session replaced, then linked and signed in", async () => {
    const deps = fakeDeps();
    const outcome = await signIn(deps);
    expect(outcome).toEqual({
      ok: true,
      userId: "usr_1",
      email: "alice@example.com",
      linkId: "crd_auto",
      assurance: "password",
      sessionId: "ses_new",
      token: "t".repeat(43),
      autoLinked: { name: "alice@example.com" },
    });
    expect(deps.calls).toEqual(["resolve", "resolveAutoLink", "replace", "autoLink"]);
    const target = {
      providerKey: `oidc:${idp.url}`,
      sub: "user-123",
      email: "alice@example.com",
    };
    expect(deps.inputs).toEqual([
      target,
      { ...target, provider: { id: "corp", label: "Corp" }, name: "alice@example.com" },
    ]);
    expect(deps.failures).toEqual([]);
  });

  test("an account with a second factor is refused (it links explicitly), recorded, nothing linked or replaced", async () => {
    const deps = fakeDeps({
      autoLinkDecision: { ok: false, reason: "second_factor_enrolled", userId: "usr_1" },
    });
    expect(await signIn(deps)).toEqual({
      ok: false,
      stage: "account",
      reason: "second_factor_enrolled",
      userId: "usr_1",
    });
    expect(deps.calls).toEqual(["resolve", "resolveAutoLink", "recordFailure"]);
    expect(deps.failures).toEqual([["usr_1", "corp", "second_factor_enrolled"]]);
  });
});

describe("auto-link: the claims", () => {
  const cases: Array<[string, Record<string, unknown>, SsoAutoLinkRefusal]> = [
    ["email_verified false", { email_verified: false }, "email_unverified"],
    ["email_verified missing", { email_verified: undefined }, "email_unverified"],
    ['email_verified the string "true"', { email_verified: "true" }, "email_unverified"],
    ["no email claim", { email: undefined }, "email_unverified"],
    ["a non-ASCII email", { email: "alice@examplе.com" }, "email_unverified"],
    ["a domain not allowed", { email: "alice@other.example" }, "domain_not_allowed"],
    [
      "a subdomain of an allowed one",
      { email: "alice@eu.example.com" },
      "domain_not_allowed",
    ],
    ["an hd claim not allowed", { hd: "other.example" }, "hosted_domain_not_allowed"],
  ];
  for (const [name, claims, reason] of cases) {
    test(`${name}: ${reason}, recorded with no account, refused like an unknown identity, nothing looked up by email`, async () => {
      idp.claimOverrides = claims;
      const deps = fakeDeps();
      expect(await signIn(deps)).toEqual({
        ok: false,
        stage: "account",
        reason,
        userId: null,
      });
      expect(deps.calls).toEqual(["resolve", "recordFailure"]);
      expect(deps.failures).toEqual([[null, "corp", reason]]);
    });
  }

  test("an allowed hd claim (a secondary Workspace domain): linked", async () => {
    idp.claimOverrides = { email: "alice@example.org", hd: "example.com" };
    const deps = fakeDeps();
    expect(
      (await signIn(deps, provider({ allowedDomains: ["example.com", "example.org"] })))
        .ok,
    ).toBe(true);
  });
});

describe("auto-link: the account", () => {
  const refusals: Array<[SsoAutoLinkRefusal, string | null]> = [
    ["no_account_for_email", null],
    ["deactivated", "usr_1"],
    ["owner_not_auto_linked", "usr_1"],
    ["admin_not_auto_linked", "usr_1"],
    ["second_factor_enrolled", "usr_1"],
    ["provider_already_linked", "usr_1"],
    ["already_linked", "usr_1"],
  ];
  for (const [reason, userId] of refusals) {
    test(`${reason}: recorded, the previous session kept, nothing linked`, async () => {
      const deps = fakeDeps({ autoLinkDecision: { ok: false, reason, userId } });
      expect(await signIn(deps)).toEqual({ ok: false, stage: "account", reason, userId });
      expect(deps.calls).toEqual(["resolve", "resolveAutoLink", "recordFailure"]);
      expect(deps.failures).toEqual([[userId, "corp", reason]]);
    });
  }

  test("decided again under the lock: a link that raced in is refused and recorded", async () => {
    const deps = fakeDeps({
      linked: { ok: false, reason: "provider_already_linked", userId: "usr_1" },
    });
    expect(await signIn(deps)).toEqual({
      ok: false,
      stage: "account",
      reason: "provider_already_linked",
      userId: "usr_1",
    });
    expect(deps.calls).toEqual([
      "resolve",
      "resolveAutoLink",
      "replace",
      "autoLink",
      "recordFailure",
    ]);
  });
});

describe("auto-link: what it does not touch", () => {
  test("auto-link off: an unknown identity with a verified, allowed email is refused as before", async () => {
    const deps = fakeDeps();
    expect(await signIn(deps, provider({ autoLink: false }))).toEqual({
      ok: false,
      stage: "account",
      reason: "unknown_identity",
      userId: null,
    });
    expect(deps.calls).toEqual(["resolve", "recordFailure"]);
  });

  test("a linked identity signs in through its link, whatever its email", async () => {
    idp.claimOverrides = { email: "someone@other.example", email_verified: false };
    const deps = fakeDeps({
      decision: {
        ok: true,
        userId: "usr_1",
        email: "alice@example.com",
        linkId: "crd_link",
        assurance: "password",
      },
    });
    expect(await signIn(deps)).toMatchObject({ ok: true, linkId: "crd_link" });
    expect(deps.calls).toEqual(["resolve", "replace", "open"]);
  });

  test("a linked identity refused (disabled, owner without a second factor) is never re-linked by email", async () => {
    const deps = fakeDeps({
      decision: { ok: false, reason: "deactivated", userId: "usr_1" },
    });
    expect(await signIn(deps)).toMatchObject({ ok: false, reason: "deactivated" });
    expect(deps.calls).toEqual(["resolve", "recordFailure"]);
  });

  test("no code, state, subject, email or token reaches the log", async () => {
    await signIn(fakeDeps());
    await signIn(
      fakeDeps({
        autoLinkDecision: { ok: false, reason: "owner_not_auto_linked", userId: "usr_1" },
      }),
    );
    const text = JSON.stringify(logged);
    for (const secret of [
      "user-123",
      "alice@example.com",
      "Alice@Example.com",
      "fake-access-token",
      idp.clientSecret,
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("ssoAutoLinkEmail", () => {
  const verified = {
    email: "alice@example.com",
    emailVerified: true,
    hostedDomain: null,
  };
  const corp = { issuer: "https://idp.example.com", allowedDomains: ["example.com"] };

  test("in order: verified, the domain exactly, then hd", () => {
    expect(ssoAutoLinkEmail(corp, verified)).toEqual({
      ok: true,
      email: "alice@example.com",
    });
    expect(ssoAutoLinkEmail(corp, { ...verified, emailVerified: false })).toEqual({
      ok: false,
      reason: "email_unverified",
    });
    expect(
      ssoAutoLinkEmail(corp, { ...verified, email: null, emailVerified: true }),
    ).toEqual({ ok: false, reason: "email_unverified" });
    expect(
      ssoAutoLinkEmail(corp, { ...verified, email: "alice@notexample.com" }),
    ).toMatchObject({ reason: "domain_not_allowed" });
    expect(
      ssoAutoLinkEmail(corp, { ...verified, hostedDomain: "other.example" }),
    ).toMatchObject({ reason: "hosted_domain_not_allowed" });
    expect(ssoAutoLinkEmail({ ...corp, allowedDomains: [] }, verified)).toMatchObject({
      reason: "domain_not_allowed",
    });
  });

  test("Google: hd is required (Google is not authoritative for an address without it), except gmail.com", () => {
    const google = {
      issuer: "https://accounts.google.com",
      allowedDomains: ["example.com", "gmail.com"],
    };
    expect(ssoAutoLinkEmail(google, verified)).toMatchObject({
      reason: "hosted_domain_not_allowed",
    });
    expect(
      ssoAutoLinkEmail(google, { ...verified, hostedDomain: "example.com" }),
    ).toMatchObject({ ok: true });
    expect(
      ssoAutoLinkEmail(google, { ...verified, email: "alice@gmail.com" }),
    ).toMatchObject({ ok: true });
  });
});

describe("ssoAutoLinkRefusal", () => {
  const none = { providerLinked: false, identityLinkedElsewhere: false };
  const member = { disabled: false, role: "member", hasSecondFactor: false };

  test("in order: exactly one account, enabled, a member, no second factor, no link at the provider, the identity free", () => {
    expect(ssoAutoLinkRefusal([], none)).toBe("no_account_for_email");
    expect(ssoAutoLinkRefusal([member, member], none)).toBe("no_account_for_email");
    expect(
      ssoAutoLinkRefusal([{ ...member, disabled: true, role: "owner" }], {
        ...none,
        providerLinked: true,
      }),
    ).toBe("deactivated");
    expect(
      ssoAutoLinkRefusal([{ ...member, role: "owner", hasSecondFactor: true }], none),
    ).toBe("owner_not_auto_linked");
    expect(
      ssoAutoLinkRefusal([{ ...member, role: "admin", hasSecondFactor: true }], none),
    ).toBe("admin_not_auto_linked");
    expect(
      ssoAutoLinkRefusal([{ ...member, hasSecondFactor: true }], {
        ...none,
        providerLinked: true,
      }),
    ).toBe("second_factor_enrolled");
    expect(
      ssoAutoLinkRefusal([member], {
        providerLinked: true,
        identityLinkedElsewhere: true,
      }),
    ).toBe("provider_already_linked");
    expect(ssoAutoLinkRefusal([member], { ...none, identityLinkedElsewhere: true })).toBe(
      "already_linked",
    );
    expect(ssoAutoLinkRefusal([member], none)).toBeNull();
  });
});
