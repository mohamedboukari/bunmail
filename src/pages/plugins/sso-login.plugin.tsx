import { t, type Context } from "elysia";
import { config, type SsoProviderSettings } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import {
  isLoginRateLimited,
  refundLoginAttempt,
  shouldAuditLockout,
  takeLoginAttempt,
} from "../../middleware/login-rate-limit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import type { WindowTicket } from "../../utils/shared-store.ts";
import type { SessionClient } from "../../modules/users/types/user.types.ts";
import type { SsoSignInCallbackOutcome } from "../../modules/users/types/sso.types.ts";
import { finishSsoLinkCallback } from "../../modules/users/services/sso-link-flow.service.ts";
import { finishSsoSignInCallback } from "../../modules/users/services/sso-sign-in-flow.service.ts";
import { ssoFlowPurposeOf } from "../../modules/users/services/sso-flow-cookie.service.ts";
import { startSsoFlow } from "../../modules/users/services/sso.service.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { TWO_FACTOR_LOGIN_PAGE } from "../../modules/users/services/two-factor-policy.service.ts";
import {
  SESSION_PENDING_SECONDS,
  sessionIp,
} from "../../modules/users/services/session-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import { LoginPage } from "../routes/login.tsx";
import { SsoHandoffPage } from "../routes/sso-handoff.tsx";
import { readSessionCookie, readSsoFlowCookie } from "../session.ts";
import {
  SESSION_STORE_DOWN,
  clearSsoFlow,
  issueSession,
  issueSsoFlowCookie,
} from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import type { PublicDashboard } from "../lib/session-guard.ts";
import {
  UNKNOWN_ACCOUNT,
  completeSignIn,
  replacePresentedSession,
  requestIp,
  setAuthPageHeaders,
} from "../lib/sign-in.tsx";
import {
  LINK_REFUSAL,
  SSO_START_MAX,
  SSO_START_WINDOW_MS,
  providerById,
  ssoStartKey,
  toSsoPage,
  uncountedCallbackRefusal,
} from "../lib/sso.ts";

/**
 * The public single sign-on routes (OpenID Connect, #224), mounted before
 * the session guard like the other sign-in routes: the start of a sign-in
 * (a "Sign in with <label>" button on the login page) and the callback the
 * provider sends the browser back to, which finishes a sign-in or a link
 * (the link is started on Account > Sign-in methods, `sso.plugin.tsx`).
 *
 * Destinations are fixed: the provider's authorization URL (from its
 * discovery document, through the hand-off page `SsoHandoffPage`, #409),
 * `/dashboard`, the second login step, the login
 * page and the Sign-in methods page. No return parameter is read, so
 * there is no open redirect.
 */

/** Where a failed sign-in, or a link callback without a session, lands: one generic message. */
const LOGIN_FAILED = "/dashboard/login?error=sso";

/** What the Sign-in methods page says when a link's provider round trip failed. */
const FLOW_FAILED =
  "Linking did not complete: the provider's answer was not accepted. Try again.";

/**
 * The redirect of a refused sign-in. Every refusal of a proven identity
 * (unknown, a disabled account, the owner without a second factor, a link
 * by verified email that did not hold) gets
 * the same message, so the page tells the identity's holder nothing about
 * the account behind it; the audit row keeps the real reason. A failed
 * flow gets the generic one.
 */
function signInFailedUrl(
  outcome: Extract<SsoSignInCallbackOutcome, { ok: false }>,
): string {
  return outcome.stage === "account"
    ? "/dashboard/login?error=sso_unlinked"
    : LOGIN_FAILED;
}

/** What both halves of the callback take. */
interface CallbackContext {
  provider: SsoProviderSettings;
  baseUrl: string;
  flowCookie: string | undefined;
  params: URLSearchParams;
  /** The well-formed `bm_session` token the browser presents, or `undefined`. */
  sessionToken: string | undefined;
  ip: string;
  client: SessionClient;
  /** The windows the callback's attempt was counted in, so a success refunds only into them. */
  attemptTicket: WindowTicket;
}

/**
 * The sign-in half of the callback (`finishSsoSignInCallback` for the
 * checks). On success the attempt is given back to the limiter; a
 * `pending` session (the account has a BunMail second factor) goes to the
 * second login step, which completes it to `mfa` and runs the location
 * lookup and the new-device check then; a `password`-level one goes to
 * `/dashboard`, with the location lookup and the new-device check now
 * (`completeSignIn`). An identity linked on the way by its verified email
 * (`SSO_<ID>_AUTO_LINK=true`) is logged and the account emailed (no links
 * in it). A refusal keeps its counted attempt and
 * goes to the login page.
 */
async function finishSignIn(
  set: Context["set"],
  request: Request,
  context: CallbackContext,
): Promise<string> {
  const { provider, ip } = context;
  const outcome = await finishSsoSignInCallback({
    provider,
    baseUrl: context.baseUrl,
    flowCookie: context.flowCookie,
    params: context.params,
    client: context.client,
    replacePreviousSession: () => replacePresentedSession(request, ip),
  });
  if (!outcome.ok) {
    logger.warn("SSO sign-in failed", {
      provider: provider.id,
      stage: outcome.stage,
      ...(outcome.stage === "purpose" ? {} : { reason: outcome.reason }),
      ...(outcome.stage === "account" && outcome.userId !== null
        ? { userId: outcome.userId }
        : {}),
      ip,
    });
    return redirect(set, signInFailedUrl(outcome));
  }

  if (config.dashboard.loginRateLimit.enabled) {
    await refundLoginAttempt(ip, context.attemptTicket);
  }
  const ids = {
    userId: outcome.userId,
    sessionId: outcome.sessionId,
    provider: provider.id,
    ip,
  };
  if (outcome.autoLinked) {
    logger.warn("SSO identity auto-linked by verified email", {
      ...ids,
      linkId: outcome.linkId,
    });
    void sendTwoFactorAlert({
      event: "sso_auto_linked",
      userId: outcome.userId,
      email: outcome.email,
      ip: sessionIp(ip),
      sso: { provider: provider.label, account: outcome.autoLinked.name },
    });
  }
  if (outcome.assurance === "pending") {
    logger.info("Dashboard login: SSO accepted, second factor required", ids);
    issueSession(set, outcome.token, SESSION_PENDING_SECONDS);
    /** `issueSession` replaced the response's cookies: clear the flow cookie again. */
    clearSsoFlow(set);
    return redirect(set, TWO_FACTOR_LOGIN_PAGE);
  }
  logger.info("Dashboard login successful", { ...ids, method: "oauth" });
  issueSession(set, outcome.token);
  clearSsoFlow(set);
  completeSignIn(set, request, {
    userId: outcome.userId,
    email: outcome.email,
    sessionId: outcome.sessionId,
    ip,
    ssoProvider: provider.label,
  });
  return redirect(set, "/dashboard");
}

/**
 * The link half of the callback (`finishSsoLinkCallback` for the checks).
 * Success: the attempt is given back to the limiter, the account is
 * emailed (no links in it), and the browser goes to the Sign-in methods
 * page. Any failure: the Sign-in methods page with a message when the
 * browser presents a session cookie, else the login page's generic
 * message.
 */
async function finishLink(
  set: Context["set"],
  context: CallbackContext,
): Promise<string> {
  const { provider, ip, sessionToken } = context;
  const fail = (message: string): string =>
    sessionToken === undefined
      ? redirect(set, LOGIN_FAILED)
      : toSsoPage(set, message, "error");
  const outcome = await finishSsoLinkCallback({
    provider,
    baseUrl: context.baseUrl,
    flowCookie: context.flowCookie,
    params: context.params,
    sessionToken,
    client: context.client,
  });
  if (!outcome.ok) {
    if (outcome.stage === "purpose") return redirect(set, LOGIN_FAILED);
    if (outcome.stage === "flow") return fail(FLOW_FAILED);
    logger.warn("SSO link refused", {
      provider: provider.id,
      reason: outcome.reason,
      ...(outcome.userId === null ? {} : { userId: outcome.userId }),
      ip,
    });
    return fail(LINK_REFUSAL[outcome.reason]);
  }

  if (config.dashboard.loginRateLimit.enabled) {
    await refundLoginAttempt(ip, context.attemptTicket);
  }
  logger.warn("SSO identity linked", {
    userId: outcome.userId,
    sessionId: outcome.sessionId,
    linkId: outcome.linkId,
    provider: provider.id,
    ip,
  });
  void sendTwoFactorAlert({
    event: "sso_linked",
    userId: outcome.userId,
    email: outcome.email,
    ip: sessionIp(ip),
    sso: { provider: provider.label, account: outcome.name },
  });
  return toSsoPage(set, `${provider.label} linked.`, "success");
}

export function ssoLoginPages(app: PublicDashboard) {
  return (
    app
      /**
       * POST /dashboard/login/sso/:provider
       * Starts a sign-in with a provider (a "Sign in with <label>" button).
       * In order: auth-page headers; same-origin (blocks login CSRF: a
       * third-party page starting a flow in the victim's browser); the
       * per-IP login limiter (`DASHBOARD_LOGIN_RATE_LIMIT_*`), checked but
       * not counted, before any network call (over budget: 429, the login
       * page disabled); the start's own budget (`SSO_START_MAX` starts per
       * address bucket per 15 minutes, counted, never given back: 429); the
       * provider (configured, SSO on); then discovery
       * (usually cached), `state`, `nonce` and a PKCE verifier sealed in
       * the `bm_sso` cookie (`purpose=login`), and the hand-off page to the
       * provider's authorization endpoint with the fixed redirect URI: a
       * `302` there would be blocked by CSP `form-action 'self'` (#409).
       *
       * The attempt is counted at the callback: a flow that never comes
       * back costs nothing, one that fails costs one, one that succeeds is
       * given back. So a sign-in nets zero against an address shared by a
       * whole office, and a started flow can only reach the provider's
       * token endpoint through a counted callback.
       */
      .post(
        "/login/sso/:provider",
        async ({ params, set, request, server }) => {
          setAuthPageHeaders(set);
          const ip = requestIp(request, server?.requestIP(request)?.address);
          if (!isSameOrigin(request)) {
            logger.warn("SSO sign-in POST rejected: cross-origin (possible CSRF)", {
              ip,
              origin:
                request.headers.get("origin") ?? request.headers.get("referer") ?? null,
            });
            set.status = 403;
            return "Forbidden: cross-origin request rejected";
          }

          const { loginRateLimit } = config.dashboard;
          if (loginRateLimit.enabled) {
            const { limited, retryAfterSec } = await isLoginRateLimited(
              ip,
              loginRateLimit.maxAttempts,
            );
            if (limited) {
              logger.warn("SSO sign-in blocked: too many attempts", {
                ip,
                retryAfterSec,
              });
              if (await shouldAuditLockout(ip)) {
                await recordAuditEvent({
                  action: "auth.login.rate_limited",
                  outcome: "failure",
                  actor: UNKNOWN_ACCOUNT,
                  ip,
                  userAgent: request.headers.get("user-agent"),
                  metadata: { retryAfterSec },
                });
              }
              set.status = 429;
              set.headers["retry-after"] = String(retryAfterSec);
              const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
              return (
                <LoginPage
                  error={`Too many failed attempts. Try again in ${minutes} minute(s).`}
                  disabled={true}
                />
              );
            }
          }

          /**
           * The start's own budget, counted and never given back: every
           * start may end in a consumed `state` in the replay store, which
           * holds 10 000 in memory without `REDIS_URL`.
           */
          const startKey = ssoStartKey(ip);
          const startBudget = await takeLoginAttempt(
            [startKey],
            SSO_START_MAX,
            SSO_START_WINDOW_MS,
          );
          if (startBudget.limited) {
            logger.warn("SSO sign-in blocked: too many starts", {
              ip,
              retryAfterSec: startBudget.retryAfterSec,
            });
            if (await shouldAuditLockout(startKey)) {
              await recordAuditEvent({
                action: "auth.login.rate_limited",
                outcome: "failure",
                actor: UNKNOWN_ACCOUNT,
                ip,
                userAgent: request.headers.get("user-agent"),
                metadata: { retryAfterSec: startBudget.retryAfterSec },
              });
            }
            set.status = 429;
            set.headers["retry-after"] = String(startBudget.retryAfterSec);
            const minutes = Math.max(1, Math.ceil(startBudget.retryAfterSec / 60));
            return (
              <LoginPage
                error={`Too many sign-in attempts. Try again in ${minutes} minute(s).`}
                disabled={true}
              />
            );
          }

          const provider = providerById(params.provider);
          const baseUrl = config.sso.baseUrl;
          if (provider === null || baseUrl === null) {
            logger.warn("SSO sign-in refused: provider not configured or SSO off", {
              ip,
              ssoOn: baseUrl !== null,
            });
            return redirect(set, LOGIN_FAILED);
          }

          try {
            const started = await startSsoFlow({ provider, baseUrl, purpose: "login" });
            if (!started.ok) {
              logger.warn("SSO sign-in not started", {
                provider: provider.id,
                reason: started.reason,
                ip,
              });
              return redirect(set, "/dashboard/login?error=sso_unavailable");
            }
            issueSsoFlowCookie(set, started.flowCookie);
            /** `debug`: one line per click; the callback logs the outcome. */
            logger.debug("SSO sign-in started", { provider: provider.id, ip });
            /** A hand-off page, not a `302`: CSP `form-action 'self'` blocks that redirect (#409). */
            setAuthPageHeaders(set);
            return (
              <SsoHandoffPage
                label={provider.label}
                authorizationUrl={started.authorizationUrl}
              />
            );
          } catch (error: unknown) {
            logger.error("SSO sign-in start failed", {
              provider: provider.id,
              ip,
              error: errorMessage(error),
            });
            return redirect(set, LOGIN_FAILED);
          }
        },
        { params: t.Object({ provider: t.String({ maxLength: 64 }) }) },
      )

      /**
       * GET /dashboard/login/sso/:provider/callback?code&state[&iss]
       * The provider's answer, for a sign-in or a link. In order:
       *
       * 1. Auth-page headers (`no-store`, no framing), with
       *    `Referrer-Policy: no-referrer`: the URL carries the one-time code,
       *    and this answer is a redirect, never a form.
       * 2. Refused without counting or recording anything
       *    (`uncountedCallbackRefusal`): a `Sec-Fetch-Dest` other than
       *    `document` (an embedded request from another site), or no
       *    `bm_sso` cookie (no flow); otherwise any page could spend a
       *    visitor's sign-in budget with a few `<img>` tags. The `bm_sso`
       *    cookie is cleared on every answer, this refusal included.
       * 3. The per-IP login limiter (`DASHBOARD_LOGIN_RATE_LIMIT_*`), checked
       *    and counted before any other work; over budget: refused, nothing
       *    called. The path's provider must be configured and SSO on.
       * 4. The flow's purpose, from the cookie: `login` signs in
       *    (`finishSignIn`), `link` finishes a link (`finishLink`). A cookie
       *    that does not open is a sign-in attempt, unless the browser
       *    presents a session cookie (then it is treated as a link, as
       *    before sign-in existed); either way it fails the flow checks.
       * 5. The half's own checks, in order: the flow (cookie, `state` in
       *    constant time and consumed once, the RFC 9207 `iss`, only then
       *    the code exchange, every ID token check), then the identity.
       *
       * Never logs the code, a token, the ID token or the subject.
       */
      .get(
        "/login/sso/:provider/callback",
        async ({ params, request, set, server }) => {
          setAuthPageHeaders(set);
          set.headers["referrer-policy"] = "no-referrer";
          const ip = requestIp(request, server?.requestIP(request)?.address);
          const client = { ip, userAgent: request.headers.get("user-agent") };
          const cookieHeader = request.headers.get("cookie");
          /** Every answer clears the flow cookie: a flow gets one callback. */
          clearSsoFlow(set);
          const presented = readSessionCookie(cookieHeader);
          const sessionToken =
            presented !== undefined && isWellFormedToken(presented)
              ? presented
              : undefined;
          const refuse = (linkMessage: string, loginUrl: string): string =>
            sessionToken === undefined
              ? redirect(set, loginUrl)
              : toSsoPage(set, linkMessage, "error");

          const flowCookie = readSsoFlowCookie(cookieHeader);
          const uncounted = uncountedCallbackRefusal(request.headers, flowCookie);
          if (uncounted !== null) {
            /** `debug`: anyone can send these, and they cost nothing. */
            logger.debug("SSO callback refused before counting", {
              reason: uncounted,
              ip,
            });
            return refuse(FLOW_FAILED, LOGIN_FAILED);
          }

          const { loginRateLimit } = config.dashboard;
          /** The take's window ids, so a success refunds only into that window. */
          let attemptTicket: WindowTicket = new Map();
          if (loginRateLimit.enabled) {
            const { limited, retryAfterSec, ticket } = await takeLoginAttempt(
              [ip],
              loginRateLimit.maxAttempts,
              loginRateLimit.windowSec * 1000,
            );
            if (limited) {
              logger.warn("SSO callback blocked: too many attempts", {
                ip,
                retryAfterSec,
              });
              if (await shouldAuditLockout(ip)) {
                await recordAuditEvent({
                  action: "auth.login.rate_limited",
                  outcome: "failure",
                  actor: UNKNOWN_ACCOUNT,
                  ...client,
                  metadata: { retryAfterSec },
                });
              }
              return refuse(
                LINK_REFUSAL.rate_limited,
                "/dashboard/login?error=rate_limited",
              );
            }
            attemptTicket = ticket;
          }

          const provider = providerById(params.provider);
          const baseUrl = config.sso.baseUrl;
          if (provider === null || baseUrl === null) {
            logger.warn("SSO callback refused: provider not configured or SSO off", {
              ip,
              ssoOn: baseUrl !== null,
            });
            return refuse(FLOW_FAILED, LOGIN_FAILED);
          }

          const context: CallbackContext = {
            provider,
            baseUrl,
            flowCookie,
            params: new URL(request.url).searchParams,
            sessionToken,
            ip,
            client,
            attemptTicket,
          };
          const purpose = ssoFlowPurposeOf(flowCookie);
          try {
            return purpose === "login" || (purpose === null && sessionToken === undefined)
              ? await finishSignIn(set, request, context)
              : await finishLink(set, context);
          } catch (error: unknown) {
            logger.error("SSO callback failed: store error", {
              provider: provider.id,
              ip,
              error: errorMessage(error),
            });
            set.status = 503;
            return SESSION_STORE_DOWN;
          }
        },
        { params: t.Object({ provider: t.String({ maxLength: 64 }) }) },
      )
  );
}
