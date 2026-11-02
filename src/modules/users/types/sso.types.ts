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
 * Every reason an SSO flow can fail. The callback route (a later PR)
 * records them as the `reason` of `auth.login.failed`.
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
