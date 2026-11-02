/**
 * Types of OpenID Connect single sign-on (#224). The provider settings
 * themselves live in `src/config.ts` (`SsoProviderSettings`).
 */

/** Why a flow was started: to sign in, or to link an identity while signed in. */
export const SSO_FLOW_PURPOSES = ["login", "link"] as const;
export type SsoFlowPurpose = (typeof SSO_FLOW_PURPOSES)[number];

/**
 * What the encrypted `bm_sso` flow cookie carries between the start of a
 * flow and its callback. Never stored server-side, never logged.
 */
export interface SsoFlowPayload {
  /** Payload version: bumped when the shape changes. */
  v: 1;
  /** The provider id the flow was started for (the path's provider must match). */
  provider: string;
  purpose: SsoFlowPurpose;
  /** The session that started a `link` flow; absent for `login`. */
  sessionId?: string;
  /** The `state` sent to the provider, compared in constant time. */
  state: string;
  /** The `nonce` sent to the provider, which the ID token must echo. */
  nonce: string;
  /** The PKCE code verifier whose S256 challenge was sent. */
  codeVerifier: string;
  /** When the flow stops being accepted, in Unix seconds. */
  exp: number;
}

/**
 * Every reason an SSO flow can fail. A sign-in callback records them as
 * the `reason` of `auth.login.failed` (`step: "sso"`); a link callback as
 * `flow_failed` of `auth.sso.link_refused`.
 *
 * - `discovery_failed`: the provider's discovery document could not be
 *   fetched or did not pass its checks.
 * - `flow_missing`: the callback came without a `bm_sso` cookie.
 * - `flow_invalid`: the cookie does not decrypt or does not parse
 *   (tampered, another key, another version).
 * - `flow_expired`: the cookie is past its 10 minutes.
 * - `provider_mismatch`: the cookie was made for another provider.
 * - `state_mismatch`: `state` is missing or differs from the cookie's.
 * - `flow_replayed`: this flow already had a callback (its `state` was
 *   consumed); refused before any network call.
 * - `issuer_mismatch`: the RFC 9207 `iss` parameter is missing (when the
 *   provider promises it) or names another issuer.
 * - `provider_error`: the provider answered with an error (an `error`
 *   parameter, a failed code exchange) or could not be reached.
 * - `id_token_invalid`: the ID token is missing, or fails a claim or
 *   signature check.
 */
export const SSO_FAILURE_REASONS = [
  "discovery_failed",
  "flow_missing",
  "flow_invalid",
  "flow_expired",
  "provider_mismatch",
  "state_mismatch",
  "flow_replayed",
  "issuer_mismatch",
  "provider_error",
  "id_token_invalid",
] as const;
export type SsoFailureReason = (typeof SSO_FAILURE_REASONS)[number];

/**
 * The identity a valid callback proves, with no token kept. The link is
 * keyed by `(issuer, sub)`, never by the email: the email only feeds the
 * optional link by verified email and the label shown on the account page.
 */
export interface SsoIdentity {
  /** The issuer, exactly as configured (and as the ID token's `iss`). */
  issuer: string;
  /** The subject: the account's stable id at that issuer. */
  sub: string;
  /**
   * The `email` claim with its ASCII letters lower-cased; `null` when it
   * is absent or not a plain ASCII address (see `emailClaim`).
   */
  email: string | null;
  /** True only when `email` is kept and the `email_verified` claim is the boolean `true`. */
  emailVerified: boolean;
  /** The `name` claim, trimmed; `null` when absent. */
  name: string | null;
  /** Google's `hd` claim (Workspace domain), lower-cased; `null` when absent or not a domain. */
  hostedDomain: string | null;
}

/** What starting a flow gives: where to send the browser and the cookie to set. */
export type SsoStartResult =
  | {
      ok: true;
      /** The provider's authorization endpoint with every request parameter. */
      authorizationUrl: string;
      /** The encrypted `bm_sso` value; set it with `ssoFlowSetCookie`. */
      flowCookie: string;
    }
  | { ok: false; reason: "discovery_failed" };

/** What validating a callback gives. The caller clears the `bm_sso` cookie either way. */
export type SsoCallbackResult =
  | {
      ok: true;
      identity: SsoIdentity;
      purpose: SsoFlowPurpose;
      /** The session that started a `link` flow; `null` for `login`. */
      sessionId: string | null;
    }
  | { ok: false; reason: SsoFailureReason };

/**
 * Why linking an SSO identity to an account was refused (#224). Each one
 * is recorded as the `reason` of `auth.sso.link_refused`:
 *
 * - `wrong_password`: the current password, asked before the redirect to
 *   the provider, was wrong;
 * - `second_factor_required`: the owner has no BunMail second factor;
 * - `provider_already_linked`: the account already has an identity at this
 *   provider (one per provider, `user_credentials_one_oauth_per_provider`);
 * - `already_linked`: the identity is linked to another account
 *   (`user_credentials_provider_account_unique`);
 * - `session_changed`: at the callback, the browser's live session is not
 *   the one that started the link (signed out, expired, revoked, replaced).
 *
 * A failed provider round trip is recorded too, as `flow_failed`, when the
 * browser's live session names the account (`finishSsoLinkCallback`).
 */
export type SsoLinkRefusal =
  | "wrong_password"
  | "second_factor_required"
  | "provider_already_linked"
  | "already_linked"
  | "session_changed";

/**
 * A linked identity, as the Sign-in methods page lists it. Never the
 * subject: some providers use the email as the subject, and the page has
 * no use for it.
 */
export interface SsoLinkSummary {
  /** `user_credentials.id` of the link. */
  id: string;
  /** The stored `oidc:<issuer>`. */
  provider: string;
  /** The provider email (or name) at link time; `null` when none fitted. */
  name: string | null;
  /** When it was linked. */
  createdAt: Date;
  /** Its last sign-in; `null` until it signs in. */
  lastUsedAt: Date | null;
}

/** What the checks before the redirect to the provider give (`authorizeSsoLink`). */
export type AuthorizeSsoLinkResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "rate_limited"
        | "wrong_password"
        | "second_factor_required"
        | "provider_already_linked";
    };

/**
 * An SSO link a completed reset removed (#224): an admin-issued reset link
 * or `reset-owner`, which take the account's second factors away too.
 * Never the subject.
 */
export interface RemovedSsoLink {
  /** `user_credentials.id` of the removed link. */
  id: string;
  /** The stored `oidc:<issuer>`. */
  provider: string;
  /** Its label (the provider email at link time), or `null`. */
  name: string | null;
}

/** What writing a link gives (`linkSsoIdentity`). */
export type LinkSsoIdentityResult =
  | {
      ok: true;
      /** `user_credentials.id` of the new link. */
      linkId: string;
      /** The label stored with it. */
      name: string | null;
    }
  | {
      ok: false;
      reason: SsoLinkRefusal;
      /** The account the refusal is recorded against; `null` when no live session named one. */
      userId: string | null;
    };

/** What removing a link gives (`unlinkSsoIdentity`). */
export type UnlinkSsoIdentityResult =
  | {
      ok: true;
      /** The stored `oidc:<issuer>` of the removed link. */
      provider: string;
      /** Its label. */
      name: string | null;
      /** Sessions opened with the identity, signed out with it. */
      sessionsRevoked: number;
    }
  | { ok: false; reason: "not_found" | "rate_limited" | "wrong_password" };

/**
 * Why a proven identity may not sign in (#224, part 3). Each one is
 * recorded as the `reason` of `auth.login.failed` (`step: "sso"`):
 *
 * - `unknown_identity`: no account is linked to `(issuer, sub)`; never
 *   matched by email, never created, never an invitation accepted;
 * - `deactivated`: the linked account is disabled;
 * - `owner_second_factor_required`: the linked account is the owner and has
 *   no BunMail second factor, so SSO would be a one-factor way into it
 *   (the link rules keep this from happening; a reset removing the owner's
 *   factors before its links, or any future path, would break it).
 */
export type SsoSignInRefusal =
  "unknown_identity" | "deactivated" | "owner_second_factor_required";

/**
 * Why an unknown identity was not linked by its verified email (#224,
 * part 4: `SSO_<ID>_AUTO_LINK=true`). The sign-in is then refused like an
 * unknown identity (same message, same counting); each one is recorded as
 * the `reason` of `auth.login.failed` (`step: "sso"`):
 *
 * - `email_unverified`: no usable `email` claim, or `email_verified` is
 *   not the boolean `true` (the string `"true"` does not count);
 * - `domain_not_allowed`: the email's domain is not in
 *   `SSO_<ID>_ALLOWED_DOMAINS`;
 * - `hosted_domain_not_allowed`: Google's `hd` claim (the Workspace
 *   domain) is not in the allowed domains, or a Google account outside
 *   `gmail.com` has none (Google is then not authoritative for the
 *   address);
 * - `no_account_for_email`: no account has that address;
 * - `deactivated`: the account is disabled;
 * - `owner_not_auto_linked`: the account is the owner, which is never
 *   linked automatically;
 * - `admin_not_auto_linked`: the account is an admin, never linked
 *   automatically either (only members are);
 * - `second_factor_enrolled`: the account has a BunMail second factor: a
 *   link written before that factor is passed would outlive it, so these
 *   accounts link explicitly (Account > Sign-in methods, password asked);
 * - `provider_already_linked`: the account already has an identity at this
 *   provider (possibly linked a moment ago by a racing link);
 * - `already_linked`: the identity was linked to another account a moment
 *   ago (a racing explicit link).
 */
export type SsoAutoLinkRefusal =
  | "email_unverified"
  | "domain_not_allowed"
  | "hosted_domain_not_allowed"
  | "no_account_for_email"
  | "deactivated"
  | "owner_not_auto_linked"
  | "admin_not_auto_linked"
  | "second_factor_enrolled"
  | "provider_already_linked"
  | "already_linked";

/** Whether an unknown identity may be linked by its email (`resolveSsoAutoLink`). */
export type SsoAutoLinkDecision =
  | { ok: true; userId: string }
  | {
      ok: false;
      reason: SsoAutoLinkRefusal;
      /** The account the address matched; `null` when none did. */
      userId: string | null;
    };

/** Whether a proven identity may sign in, and with which assurance (`resolveSsoSignIn`). */
export type SsoSignInDecision =
  | {
      ok: true;
      userId: string;
      /** The account's address, for the new-device check. PII: never logged raw. */
      email: string;
      /** `user_credentials.id` of the link: the session is bound to it. */
      linkId: string;
      /** `pending` with a BunMail second factor (the second step follows), else `password`. */
      assurance: "pending" | "password";
    }
  | {
      ok: false;
      reason: SsoSignInRefusal;
      /** The linked account; `null` for an unknown identity. */
      userId: string | null;
    };

/** What opening the session of an SSO sign-in gives (`openSsoSession`). */
export type OpenSsoSessionResult =
  | (Extract<SsoSignInDecision, { ok: true }> & {
      sessionId: string;
      /** The raw session token for the cookie. Never logged. */
      token: string;
    })
  | Extract<SsoSignInDecision, { ok: false }>;

/**
 * What linking an identity by its email and opening its session gives
 * (`autoLinkSsoIdentity`): the session, with the new link, or the refusal.
 */
export type AutoLinkSsoResult =
  | (Extract<OpenSsoSessionResult, { ok: true }> & {
      /** The link just written: its label (the provider email), for the security email. */
      autoLinked: { name: string | null };
    })
  | Extract<SsoAutoLinkDecision, { ok: false }>;

/**
 * The outcome of a sign-in callback (`finishSsoSignInCallback`): the new
 * session, or the stage that refused it.
 *
 * - `flow`: the flow itself failed (cookie, state, replay, provider, ID
 *   token), see {@link SsoFailureReason};
 * - `purpose`: a valid flow that was not started to sign in;
 * - `account`: the identity is proven but may not sign in, see
 *   {@link SsoSignInRefusal}, or an unknown identity could not be linked
 *   by its email, see {@link SsoAutoLinkRefusal}.
 *
 * A success carries `autoLinked` when the identity was linked by its
 * email on the way (the account is emailed about it).
 */
export type SsoSignInCallbackOutcome =
  | (Extract<OpenSsoSessionResult, { ok: true }> & {
      autoLinked?: { name: string | null };
    })
  | { ok: false; stage: "flow"; reason: SsoFailureReason }
  | { ok: false; stage: "purpose" }
  | {
      ok: false;
      stage: "account";
      reason: SsoSignInRefusal | SsoAutoLinkRefusal;
      userId: string | null;
    };

/**
 * The outcome of a link callback (`finishSsoLinkCallback`): the link, or
 * the stage that refused it.
 *
 * - `flow`: the flow itself failed (cookie, state, replay, provider, ID
 *   token), see {@link SsoFailureReason};
 * - `purpose`: a valid flow that was not started to link (the callback
 *   sends sign-in flows to `finishSsoSignInCallback` instead);
 * - `link`: the identity is proven but may not be linked, see
 *   {@link SsoLinkRefusal}.
 */
export type SsoLinkCallbackOutcome =
  | {
      ok: true;
      userId: string;
      /** The account's address, for the security email. PII: never logged raw. */
      email: string;
      sessionId: string;
      linkId: string;
      name: string | null;
    }
  | { ok: false; stage: "flow"; reason: SsoFailureReason }
  | { ok: false; stage: "purpose" }
  | { ok: false; stage: "link"; reason: SsoLinkRefusal; userId: string | null };
