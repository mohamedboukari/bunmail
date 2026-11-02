import type { SsoProviderSettings } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import type { ActiveSession, SessionClient } from "../types/user.types.ts";
import type { SsoLinkCallbackOutcome } from "../types/sso.types.ts";
import { findActiveSession } from "./session.service.ts";
import { linkSsoIdentity, recordSsoLinkRefusal } from "./sso-link.service.ts";
import { ssoLinkName, ssoProviderKey } from "./sso-link-policy.service.ts";
import { completeSsoCallback } from "./sso.service.ts";

/**
 * The link half of the SSO callback (#224): what
 * `GET /dashboard/login/sso/:provider/callback` runs once its headers, its
 * per-IP limiter and its provider lookup passed. The route owns the HTTP
 * side (cookies, redirects, the security email); this owns the order of
 * the checks, so it is unit-tested against the fake provider with the
 * session lookup and the link write replaced.
 */

/** What the callback reads and writes besides the provider (tests replace them). */
export interface SsoLinkCallbackDeps {
  /** The browser's live session for its `bm_session` token (`findActiveSession`). */
  findSession: (token: string) => Promise<ActiveSession | null>;
  /** Writes the link (`linkSsoIdentity`). */
  link: typeof linkSsoIdentity;
  /** Records a refused link (`recordSsoLinkRefusal`): here, a failed round trip. */
  refuse: typeof recordSsoLinkRefusal;
}

/** The real session lookup, link write and audit record. */
const DEFAULT_DEPS: SsoLinkCallbackDeps = {
  findSession: findActiveSession,
  link: linkSsoIdentity,
  refuse: recordSsoLinkRefusal,
};

/**
 * Finishes a link callback. In order, after the route's own checks:
 *
 * 1. The flow (`completeSsoCallback`): the `bm_sso` cookie decrypts, is
 *    this provider's and unexpired; `state` matches in constant time and
 *    is consumed (one callback per flow); the RFC 9207 `iss`; only then
 *    the code exchange; then every ID token check. Any failure: stage
 *    `flow`, and the provider was called at most once per started flow.
 *    When the browser presents a live session, the failure is recorded
 *    against that account (`auth.sso.link_refused`, `flow_failed`, no value
 *    of the flow); without one, only the service's log line remains.
 * 2. The purpose: only a `link` flow is finished here (the route sends
 *    sign-in flows to `finishSsoSignInCallback`); anything else is refused
 *    (stage `purpose`) with nothing kept.
 * 3. The browser's live session is read again (`findActiveSession` on its
 *    `bm_session` token, which must be well-formed; the caller passes
 *    `undefined` otherwise).
 * 4. `linkSsoIdentity`: the same live session that started the flow, then
 *    the owner rule and the two unique rules, in one transaction.
 *
 * The tokens and the ID token never leave step 1; the subject goes only
 * into the link row.
 */
export async function finishSsoLinkCallback(
  input: {
    provider: SsoProviderSettings;
    /** `config.sso.baseUrl`: the redirect URI is built on it. */
    baseUrl: string;
    /** The `bm_sso` cookie value, if any. */
    flowCookie: string | undefined;
    /** The callback's query parameters. */
    params: URLSearchParams;
    /** The well-formed `bm_session` token, or `undefined`. */
    sessionToken: string | undefined;
    client: SessionClient;
  },
  deps: SsoLinkCallbackDeps = DEFAULT_DEPS,
): Promise<SsoLinkCallbackOutcome> {
  const { provider } = input;
  const result = await completeSsoCallback({
    provider,
    baseUrl: input.baseUrl,
    flowCookie: input.flowCookie,
    params: input.params,
  });
  if (!result.ok) {
    const session =
      input.sessionToken === undefined
        ? null
        : await deps.findSession(input.sessionToken);
    if (session !== null) {
      await deps.refuse(session.userId, provider, "flow_failed", input.client);
    }
    return { ok: false, stage: "flow", reason: result.reason };
  }

  if (result.purpose !== "link" || result.sessionId === null) {
    logger.warn("SSO callback refused: not a link flow", {
      provider: provider.id,
      purpose: result.purpose,
    });
    return { ok: false, stage: "purpose" };
  }

  const session =
    input.sessionToken === undefined ? null : await deps.findSession(input.sessionToken);
  const linked = await deps.link(
    {
      flowSessionId: result.sessionId,
      session,
      provider: {
        key: ssoProviderKey(provider.issuer),
        id: provider.id,
        label: provider.label,
      },
      sub: result.identity.sub,
      name: ssoLinkName(result.identity),
    },
    input.client,
  );
  if (!linked.ok || session === null) {
    return {
      ok: false,
      stage: "link",
      reason: linked.ok ? "session_changed" : linked.reason,
      userId: linked.ok ? null : linked.userId,
    };
  }
  return {
    ok: true,
    userId: session.userId,
    email: session.email,
    sessionId: session.sessionId,
    linkId: linked.linkId,
    name: linked.name,
  };
}
