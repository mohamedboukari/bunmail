import type { SsoProviderSettings } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import type { SessionClient } from "../types/user.types.ts";
import type { SsoSignInCallbackOutcome } from "../types/sso.types.ts";
import { ssoProviderKey } from "./sso-link-policy.service.ts";
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
}

/** The real lookups, session write and audit record. */
const DEFAULT_DEPS: SsoSignInCallbackDeps = {
  resolve: resolveSsoSignIn,
  open: openSsoSession,
  recordFailure: recordSsoLoginFailure,
};

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
 *    `account`), against the account when one matched.
 * 4. `replacePreviousSession`: the browser's previous session is revoked,
 *    as the password login does, only now that the sign-in will go ahead.
 * 5. `openSsoSession`: the rules again under the link's lock, then the
 *    session (`pending` with a second factor, else `password`), the
 *    link's `last_used_at` and the success record, in one transaction. A
 *    refusal here (the link went meanwhile) is recorded like step 3.
 *
 * The tokens and the ID token never leave step 1; the subject goes only
 * into the lookups.
 */
export async function finishSsoSignInCallback(
  input: {
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
  },
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
