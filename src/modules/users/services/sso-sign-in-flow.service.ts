import type { SsoProviderSettings } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import type { SessionClient } from "../types/user.types.ts";
import type { SsoIdentity, SsoSignInCallbackOutcome } from "../types/sso.types.ts";
import { autoLinkSsoIdentity, resolveSsoAutoLink } from "./sso-auto-link.service.ts";
import {
  ssoAutoLinkEmail,
  ssoLinkName,
  ssoProviderKey,
} from "./sso-link-policy.service.ts";
import {
  openSsoSession,
  recordSsoLoginFailure,
  resolveSsoSignIn,
} from "./sso-sign-in.service.ts";
import { completeSsoCallback } from "./sso.service.ts";

/**
 * The sign-in half of the SSO callback (#224, part 3): what
 * `GET /dashboard/login/sso/:provider/callback` runs for a `login` flow
 * once its headers, its per-IP limiter and its provider lookup passed. The
 * route owns the HTTP side (cookies, the limiter refund, redirects, the
 * new-device check); this owns the order of the checks, so it is
 * unit-tested against the fake provider with the database work replaced.
 */

/** What the sign-in reads and writes besides the provider (tests replace them). */
export interface SsoSignInCallbackDeps {
  /** The pre-check (`resolveSsoSignIn`). */
  resolve: typeof resolveSsoSignIn;
  /** The session, decided again under the link's lock (`openSsoSession`). */
  open: typeof openSsoSession;
  /** Records a refusal (`recordSsoLoginFailure`). */
  recordFailure: typeof recordSsoLoginFailure;
  /** The pre-check of a link by verified email (`resolveSsoAutoLink`). */
  resolveAutoLink: typeof resolveSsoAutoLink;
  /** The link and the session, decided again under the account's lock (`autoLinkSsoIdentity`). */
  autoLink: typeof autoLinkSsoIdentity;
}

/** The real lookups, session write and audit record. */
const DEFAULT_DEPS: SsoSignInCallbackDeps = {
  resolve: resolveSsoSignIn,
  open: openSsoSession,
  recordFailure: recordSsoLoginFailure,
  resolveAutoLink: resolveSsoAutoLink,
  autoLink: autoLinkSsoIdentity,
};

/** What {@link finishSsoSignInCallback} takes. */
interface SsoSignInCallbackInput {
  provider: SsoProviderSettings;
  /** `config.sso.baseUrl`: the redirect URI is built on it. */
  baseUrl: string;
  /** The `bm_sso` cookie value, if any. */
  flowCookie: string | undefined;
  /** The callback's query parameters. */
  params: URLSearchParams;
  client: SessionClient;
  /** Revokes the session the browser presented, if any (the route's helper). */
  replacePreviousSession: () => Promise<void>;
}

/**
 * Finishes a sign-in callback. In order, after the route's own checks:
 *
 * 1. The flow (`completeSsoCallback`): the `bm_sso` cookie decrypts, is
 *    this provider's and unexpired; `state` matches in constant time and
 *    is consumed (one callback per flow); the RFC 9207 `iss`; only then
 *    the code exchange; then every ID token check. Any failure: stage
 *    `flow`, recorded with its reason (`auth.login.failed`, `step: "sso"`,
 *    no account named).
 * 2. The purpose: only a `login` flow signs in (stage `purpose`, nothing
 *    kept: the route sends link flows to the link half).
 * 3. The identity, by `(oidc:<issuer>, sub)` only (`resolveSsoSignIn`):
 *    no linked account (`unknown_identity`), a disabled one
 *    (`deactivated`), the owner without a BunMail second factor
 *    (`owner_second_factor_required`). Each refusal is recorded (stage
 *    `account`), against the account when one matched. An unknown
 *    identity at a provider with `SSO_<ID>_AUTO_LINK=true` goes to the
 *    link by verified email instead ({@link finishAutoLink}).
 * 4. `replacePreviousSession`: the browser's previous session is revoked,
 *    as the password login does, only now that the sign-in will go ahead.
 * 5. `openSsoSession`: the rules again under the link's lock, then the
 *    session (`pending` with a second factor, else `password`), the
 *    link's `last_used_at` and the success record, in one transaction. A
 *    refusal here (the link went meanwhile) is recorded like step 3.
 *
 * The tokens and the ID token never leave step 1; the subject and the
 * email go only into the lookups.
 */
export async function finishSsoSignInCallback(
  input: SsoSignInCallbackInput,
  deps: SsoSignInCallbackDeps = DEFAULT_DEPS,
): Promise<SsoSignInCallbackOutcome> {
  const { provider, client } = input;
  const result = await completeSsoCallback({
    provider,
    baseUrl: input.baseUrl,
    flowCookie: input.flowCookie,
    params: input.params,
  });
  if (!result.ok) {
    await deps.recordFailure(null, provider.id, result.reason, client);
    return { ok: false, stage: "flow", reason: result.reason };
  }

  if (result.purpose !== "login") {
    logger.warn("SSO callback refused: not a sign-in flow", {
      provider: provider.id,
      purpose: result.purpose,
    });
    return { ok: false, stage: "purpose" };
  }

  const identity = {
    providerKey: ssoProviderKey(provider.issuer),
    sub: result.identity.sub,
  };
  const decision = await deps.resolve(identity);
  if (!decision.ok && decision.reason === "unknown_identity" && provider.autoLink) {
    return finishAutoLink(input, result.identity, deps);
  }
  if (!decision.ok) {
    await deps.recordFailure(decision.userId, provider.id, decision.reason, client);
    return {
      ok: false,
      stage: "account",
      reason: decision.reason,
      userId: decision.userId,
    };
  }

  await input.replacePreviousSession();
  const opened = await deps.open({ ...identity, providerId: provider.id }, client);
  if (!opened.ok) {
    await deps.recordFailure(opened.userId, provider.id, opened.reason, client);
    return { ok: false, stage: "account", reason: opened.reason, userId: opened.userId };
  }
  return opened;
}

/**
 * An unknown identity at a provider with `SSO_<ID>_AUTO_LINK=true`
 * (#224, part 4). In order:
 *
 * 1. The claims (`ssoAutoLinkEmail`): `email_verified` is the boolean
 *    `true`, the email's domain is allowed, and so is Google's `hd`.
 * 2. The account (`resolveSsoAutoLink`): the address matches exactly one
 *    account: an enabled member (not the owner, not an admin) without a
 *    BunMail second factor and with no identity at this provider.
 * 3. `replacePreviousSession`, only now that the sign-in will go ahead.
 * 4. `autoLinkSsoIdentity`: the rules again under the account's lock, the
 *    link, `auth.sso.auto_linked` and the session, in one transaction.
 *
 * Every refusal is recorded with its own reason (stage `account`, against
 * the account when the address matched one) and shown like an unknown
 * identity, so the page says nothing about which accounts exist.
 */
async function finishAutoLink(
  input: SsoSignInCallbackInput,
  ssoIdentity: SsoIdentity,
  deps: SsoSignInCallbackDeps,
): Promise<SsoSignInCallbackOutcome> {
  const { provider, client } = input;
  const refuse = async (
    reason: Extract<SsoSignInCallbackOutcome, { stage: "account" }>["reason"],
    userId: string | null,
  ): Promise<SsoSignInCallbackOutcome> => {
    await deps.recordFailure(userId, provider.id, reason, client);
    return { ok: false, stage: "account", reason, userId };
  };

  const claims = ssoAutoLinkEmail(provider, ssoIdentity);
  if (!claims.ok) return refuse(claims.reason, null);
  const target = {
    providerKey: ssoProviderKey(provider.issuer),
    sub: ssoIdentity.sub,
    email: claims.email,
  };
  const decision = await deps.resolveAutoLink(target);
  if (!decision.ok) return refuse(decision.reason, decision.userId);

  await input.replacePreviousSession();
  const linked = await deps.autoLink(
    {
      ...target,
      provider: { id: provider.id, label: provider.label },
      name: ssoLinkName(ssoIdentity),
    },
    client,
  );
  if (!linked.ok) return refuse(linked.reason, linked.userId);
  return linked;
}
