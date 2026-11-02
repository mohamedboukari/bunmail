import { createHash, timingSafeEqual } from "crypto";
import * as oauth from "oauth4webapi";
import {
  asciiLowerCase,
  isLowerAsciiDomain,
  type SsoProviderSettings,
} from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import type {
  SsoCallbackResult,
  SsoFailureReason,
  SsoFlowPayload,
  SsoFlowPurpose,
  SsoIdentity,
  SsoStartResult,
} from "../types/sso.types.ts";
import {
  getSsoProviderMetadata,
  SsoHttpError,
  ssoHttpOptions,
  type SsoHttpSettings,
} from "./sso-discovery.service.ts";
import {
  defaultSsoFlowKey,
  openSsoFlow,
  sealSsoFlow,
  SSO_FLOW_TTL_SECONDS,
} from "./sso-flow-cookie.service.ts";
import {
  defaultSsoReplayStore,
  ssoReplayKey,
  type SsoReplayStore,
} from "./sso-replay.service.ts";

/**
 * The OpenID Connect authorization code flow of SSO (#224), on
 * `oauth4webapi`: building the authorization request and validating the
 * callback. No route, no session, no database: the sign-in and link
 * routes of later PRs call these two functions and decide what the
 * proven identity may do.
 *
 * Nothing secret is kept or logged: the code, the tokens and the ID token
 * are dropped once checked, and failures are logged with the provider id,
 * the reason and a short code from `oauth4webapi`, never its `cause`
 * (which can hold the token response or the ID token claims).
 */

/**
 * Clock tolerance for the ID token's `exp`, `iat` and `nbf`, in seconds:
 * small, but enough for an ordinary drift between BunMail and the provider.
 */
export const SSO_CLOCK_TOLERANCE_SECONDS = 30;

/**
 * A `sub` accepted: 1 to 255 printable ASCII characters (OpenID Connect
 * Core section 2), so it can be stored and compared without any Unicode
 * normalisation question.
 */
const SUB_RE = /^[\x20-\x7e]{1,255}$/;

/** Longest email kept from the ID token, in characters. */
const MAX_EMAIL_LENGTH = 254;

/** An email local part: printable ASCII without a space or `@`. */
const EMAIL_LOCAL_RE = /^[\x21-\x3f\x41-\x7e]{1,64}$/;

/** Longest name kept from the ID token, in characters. */
const MAX_NAME_LENGTH = 200;

/** What both entry points take besides the provider. */
interface SsoFlowContext {
  /** The provider, from `config.sso.providers`. */
  provider: SsoProviderSettings;
  /** `config.sso.baseUrl`: the redirect URI is built on it. */
  baseUrl: string;
  /** The flow-cookie key; `DKIM_ENCRYPTION_KEY`'s derived key by default. */
  key?: Buffer;
  /** The current time in epoch milliseconds (tests). */
  now?: number;
  /** HTTP settings of the provider requests (tests shorten the timeout). */
  http?: SsoHttpSettings;
  /** Where consumed flow states are kept; the shared one-time store by default (#185). */
  replayStore?: SsoReplayStore;
}

/**
 * The redirect URI registered at the provider: one per provider,
 * `<APP_BASE_URL>/dashboard/login/sso/<id>/callback`. A distinct URI per
 * provider is part of the mix-up defence: a code sent back to one
 * provider's URI is only ever exchanged with that provider.
 */
export function ssoRedirectUri(baseUrl: string, providerId: string): string {
  return `${baseUrl}/dashboard/login/sso/${providerId}/callback`;
}

/** The `oauth4webapi` client of a provider. */
function clientOf(provider: SsoProviderSettings): oauth.Client {
  return {
    client_id: provider.clientId,
    [oauth.clockTolerance]: SSO_CLOCK_TOLERANCE_SECONDS,
  };
}

/**
 * Starts a flow: generates `state`, `nonce` and a PKCE verifier, seals
 * them in the flow cookie value, and builds the authorization URL
 * (`response_type=code`, S256 challenge, the configured scopes, the fixed
 * redirect URI). Only discovery can fail. The caller sets the cookie with
 * `ssoFlowSetCookie` and redirects the browser to the URL.
 */
export async function startSsoFlow(
  context: SsoFlowContext &
    ({ purpose: "login" } | { purpose: "link"; sessionId: string }),
): Promise<SsoStartResult> {
  const { provider } = context;
  const as = await getSsoProviderMetadata(provider, {
    ...context.http,
    ...(context.now === undefined ? {} : { now: context.now }),
  });
  if (as === null || as.authorization_endpoint === undefined) {
    return { ok: false, reason: "discovery_failed" };
  }

  const state = oauth.generateRandomState();
  const nonce = oauth.generateRandomNonce();
  const codeVerifier = oauth.generateRandomCodeVerifier();
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
  const nowSec = Math.floor((context.now ?? Date.now()) / 1000);
  const payload: SsoFlowPayload = {
    v: 1,
    provider: provider.id,
    purpose: context.purpose,
    ...(context.purpose === "link" ? { sessionId: context.sessionId } : {}),
    state,
    nonce,
    codeVerifier,
    exp: nowSec + SSO_FLOW_TTL_SECONDS,
  };

  const url = new URL(as.authorization_endpoint);
  url.searchParams.set("client_id", provider.clientId);
  url.searchParams.set("redirect_uri", ssoRedirectUri(context.baseUrl, provider.id));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", provider.scopes);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return {
    ok: true,
    authorizationUrl: url.href,
    flowCookie: sealSsoFlow(payload, context.key ?? defaultSsoFlowKey()),
  };
}

/** Constant-time string equality: both sides are hashed first, so lengths never leak. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** A refused callback, with a short code for the log line. */
interface Refusal {
  reason: SsoFailureReason;
  /** An `oauth4webapi` error code, a provider `error` value or a claim name; never a value. */
  detail?: string;
}

/** A provider-sent `error` value, kept for the log only when it looks like one. */
function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value)
    ? value
    : undefined;
}

/**
 * Sorts an error thrown while exchanging the code or checking the ID token
 * into a refusal. A provider-side failure (an error body, a challenge, an
 * unreachable or malformed endpoint) is `provider_error`; anything about
 * the ID token (a claim, a timestamp, the algorithm, the signature) is
 * `id_token_invalid`. `oauth4webapi` reports both through the same error
 * classes, so the ID token cases are told apart by their codes and by
 * messages that name the JWT or the ID token.
 */
function classifyExchangeError(error: unknown): Refusal {
  if (error instanceof SsoHttpError)
    return { reason: "provider_error", detail: error.kind };
  if (error instanceof oauth.ResponseBodyError) {
    const code = safeErrorCode(error.error);
    return { reason: "provider_error", ...(code ? { detail: code } : {}) };
  }
  if (error instanceof oauth.WWWAuthenticateChallengeError) {
    return { reason: "provider_error", detail: error.code };
  }
  if (error instanceof oauth.UnsupportedOperationError) {
    return { reason: "id_token_invalid", detail: error.code };
  }
  if (error instanceof oauth.OperationProcessingError) {
    const aboutIdToken =
      error.code === oauth.JWT_CLAIM_COMPARISON ||
      error.code === oauth.JWT_TIMESTAMP_CHECK ||
      error.code === oauth.KEY_SELECTION ||
      /JWT|ID Token|id_token/.test(error.message);
    return {
      reason: aboutIdToken ? "id_token_invalid" : "provider_error",
      ...(error.code ? { detail: error.code } : {}),
    };
  }
  return { reason: "provider_error", detail: "unexpected" };
}

/**
 * The `email` claim when it is an address BunMail can compare safely, or
 * `null`: printable ASCII only, exactly one `@`, a local part of 1 to 64
 * characters, and a domain that passes the same rule as
 * `SSO_<ID>_ALLOWED_DOMAINS`, at most 254 characters in all. ASCII
 * letters are lower-cased and nothing else: Unicode case folding would
 * turn a look-alike (the Kelvin sign in `Kate@corp.com`) into a real
 * address, and the link by email (a later PR) matches on this value.
 */
function emailClaim(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_EMAIL_LENGTH) return null;
  const at = value.indexOf("@");
  if (at < 0 || at !== value.lastIndexOf("@")) return null;
  const local = value.slice(0, at);
  const domain = asciiLowerCase(value.slice(at + 1));
  if (!EMAIL_LOCAL_RE.test(local) || !isLowerAsciiDomain(domain)) return null;
  return `${asciiLowerCase(local)}@${domain}`;
}

/** Google's `hd` claim (the Workspace domain) when it is a valid domain, lower-cased; else `null`. */
function hostedDomainClaim(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = asciiLowerCase(value);
  return isLowerAsciiDomain(domain) ? domain : null;
}

/** A claim as a trimmed string of at most `max` characters, or `null`. */
function stringClaim(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" || trimmed.length > max ? null : trimmed;
}

/**
 * The checks `oauth4webapi` leaves out: `iat` not in the future (beyond
 * the tolerance), `azp` equal to our client id whenever it is present (it
 * checks it only when `aud` lists several audiences), and a `sub` of
 * printable ASCII within OpenID Connect's length.
 */
function extraClaimProblem(
  claims: oauth.IDToken,
  provider: SsoProviderSettings,
  nowSec: number,
): string | null {
  if (claims.iat > nowSec + SSO_CLOCK_TOLERANCE_SECONDS) return "iat";
  if (claims.azp !== undefined && claims.azp !== provider.clientId) return "azp";
  if (!SUB_RE.test(claims.sub)) return "sub";
  return null;
}

/**
 * Validates a callback and returns the identity it proves, or why not.
 * The checks run in this order. Nothing reaches the network before steps
 * 1 to 3 pass, so a request reaches a provider only with the cookie of a
 * flow that was started (which itself only calls discovery), and only
 * once per flow; the per-IP rate limits on the start and callback routes
 * come with the sign-in routes (a later PR).
 *
 * 1. The flow cookie is present, decrypts, parses, was made for this
 *    provider and has not expired.
 * 2. `state` equals the cookie's, compared in constant time.
 * 3. The flow's `state` is consumed ({@link SsoReplayStore}): a second
 *    callback for the same flow is refused (`flow_replayed`).
 * 4. Discovery (usually cached).
 * 5. RFC 9207: an `iss` parameter must equal the issuer, and must be
 *    present when the provider advertises it.
 * 6. An `error` parameter from the provider is refused.
 * 7. The code is exchanged with the verifier and `client_secret_basic`.
 * 8. The ID token: `iss` exact, `aud` contains our client id, `azp`,
 *    `exp`/`iat` within {@link SSO_CLOCK_TOLERANCE_SECONDS}, `nonce`, `sub`,
 *    then its signature against the provider's JWKS.
 *
 * The tokens are dropped; only the identity comes back. The caller clears
 * the `bm_sso` cookie whatever the result.
 */
export async function completeSsoCallback(
  context: SsoFlowContext & {
    /** The `bm_sso` cookie value, from `readSsoFlowCookie`. */
    flowCookie: string | undefined;
    /** The callback's query parameters. */
    params: URLSearchParams;
  },
): Promise<SsoCallbackResult> {
  const result = await validateCallback(context);
  if ("refusal" in result) {
    logger.warn("SSO callback refused", {
      provider: context.provider.id,
      reason: result.refusal.reason,
      ...(result.refusal.detail ? { detail: result.refusal.detail } : {}),
    });
    return { ok: false, reason: result.refusal.reason };
  }
  return { ok: true, ...result };
}

/** The body of {@link completeSsoCallback}, returning a refusal instead of logging it. */
async function validateCallback(
  context: SsoFlowContext & { flowCookie: string | undefined; params: URLSearchParams },
): Promise<
  | { identity: SsoIdentity; purpose: SsoFlowPurpose; sessionId: string | null }
  | { refusal: Refusal }
> {
  const { provider, params } = context;
  const nowMs = context.now ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  if (context.flowCookie === undefined) return { refusal: { reason: "flow_missing" } };
  const flow = openSsoFlow(context.flowCookie, context.key ?? defaultSsoFlowKey());
  if (flow === null) return { refusal: { reason: "flow_invalid" } };
  if (flow.provider !== provider.id) return { refusal: { reason: "provider_mismatch" } };
  if (flow.exp <= nowSec) return { refusal: { reason: "flow_expired" } };
  const state = params.get("state");
  if (state === null || !constantTimeEqual(state, flow.state)) {
    return { refusal: { reason: "state_mismatch" } };
  }
  const replayStore = context.replayStore ?? defaultSsoReplayStore;
  if (!(await replayStore.consume(ssoReplayKey(flow.state), flow.exp, nowSec))) {
    return { refusal: { reason: "flow_replayed" } };
  }

  const as = await getSsoProviderMetadata(provider, { ...context.http, now: nowMs });
  if (as === null) return { refusal: { reason: "discovery_failed" } };

  const iss = params.get("iss");
  if (
    iss === null
      ? as.authorization_response_iss_parameter_supported === true
      : iss !== as.issuer
  ) {
    return { refusal: { reason: "issuer_mismatch" } };
  }

  const client = clientOf(provider);
  let callbackParams: URLSearchParams;
  try {
    /** `state` was compared above in constant time; skip the plain comparison here. */
    callbackParams = oauth.validateAuthResponse(as, client, params, oauth.skipStateCheck);
  } catch (error: unknown) {
    const code =
      error instanceof oauth.AuthorizationResponseError
        ? safeErrorCode(error.error)
        : undefined;
    return { refusal: { reason: "provider_error", detail: code ?? "invalid_response" } };
  }

  const http = ssoHttpOptions(provider, context.http);
  let claims: oauth.IDToken | undefined;
  try {
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretBasic(provider.clientSecret),
      callbackParams,
      ssoRedirectUri(context.baseUrl, provider.id),
      flow.codeVerifier,
      http,
    );
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, response, {
      expectedNonce: flow.nonce,
      requireIdToken: true,
    });
    /**
     * `oauth4webapi` does not check the ID token signature on this flow:
     * OpenID Connect Core 3.1.3.7 lets a client trust the TLS connection
     * to the token endpoint instead. It is checked anyway, as defence in
     * depth against a compromised or misrouted token endpoint; the JWKS
     * is cached (about 5 minutes) on the metadata object.
     */
    await oauth.validateApplicationLevelSignature(as, response, http);
    claims = oauth.getValidatedIdTokenClaims(tokens);
  } catch (error: unknown) {
    return { refusal: classifyExchangeError(error) };
  }

  if (claims === undefined)
    return { refusal: { reason: "id_token_invalid", detail: "missing" } };
  const problem = extraClaimProblem(claims, provider, nowSec);
  if (problem !== null)
    return { refusal: { reason: "id_token_invalid", detail: problem } };

  const email = emailClaim(claims["email"]);
  return {
    identity: {
      issuer: provider.issuer,
      sub: claims.sub,
      email,
      /** A verified flag means nothing for an address that was refused. */
      emailVerified: email !== null && claims["email_verified"] === true,
      name: stringClaim(claims["name"], MAX_NAME_LENGTH),
      hostedDomain: hostedDomainClaim(claims["hd"]),
    },
    purpose: flow.purpose,
    sessionId: flow.purpose === "link" ? (flow.sessionId ?? null) : null,
  };
}
