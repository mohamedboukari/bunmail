import { t, type Context } from "elysia";
import { config, type SsoProviderSettings } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import {
  refundLoginAttempt,
  shouldAuditLockout,
  takeLoginAttempt,
} from "../../middleware/login-rate-limit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import type {
  AuthorizeSsoLinkResult,
  SsoLinkRefusal,
  UnlinkSsoIdentityResult,
} from "../../modules/users/types/sso.types.ts";
import {
  authorizeSsoLink,
  listSsoLinks,
  unlinkSsoIdentity,
} from "../../modules/users/services/sso-link.service.ts";
import { finishSsoLinkCallback } from "../../modules/users/services/sso-link-flow.service.ts";
import {
  auditProviderOf,
  providerOfLink,
  ssoProviderKey,
  unconfiguredLinkLabel,
} from "../../modules/users/services/sso-link-policy.service.ts";
import { startSsoFlow } from "../../modules/users/services/sso.service.ts";
import { secondFactorsOf } from "../../modules/users/services/two-factor.service.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import {
  AccountSsoPage,
  type SsoMethodRow,
  type SsoPageNotice,
} from "../routes/account-sso.tsx";
import { memberGuard } from "../guards.tsx";
import { readSessionCookie, readSsoFlowCookie } from "../session.ts";
import {
  SESSION_STORE_DOWN,
  clearSsoFlow,
  issueSsoFlowCookie,
} from "../lib/session-helpers.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { dashboardClient } from "../lib/audit.ts";
import { passwordChangeLimiter } from "../lib/password-limiter.ts";
import type { GuardedDashboard, PublicDashboard } from "../lib/session-guard.ts";
import { UNKNOWN_ACCOUNT, requestIp, setAuthPageHeaders } from "../lib/sign-in.tsx";

/**
 * Single sign-on (OpenID Connect, #224) in the dashboard: linking an
 * identity at a configured provider to the signed-in account, and
 * unlinking it.
 *
 * - Account > Sign-in methods (`/dashboard/account/sso`, after the session
 *   guard, `memberGuard`): the page, the Link form (the current password,
 *   then the browser goes to the provider) and the Unlink form.
 * - The callback (`/dashboard/login/sso/:provider/callback`, public,
 *   before the guard: the provider sends the browser back there) finishes
 *   a link. Signing in with a provider is not handled yet: a sign-in flow
 *   reaching the callback is refused.
 *
 * Redirects are fixed: the provider's authorization URL (from its
 * discovery document), the Sign-in methods page and the login page. No
 * return parameter is read.
 */

/** The Sign-in methods page. */
const SSO_PAGE = "/dashboard/account/sso";

/** Where a callback without a session lands: the login page's generic SSO message. */
const LOGIN_FAILED = "/dashboard/login?error=sso";

/** What the page says when the provider round trip failed: one message for every reason. */
const FLOW_FAILED =
  "Linking did not complete: the provider's answer was not accepted. Try again.";

/** What the page says for a refused link. */
const LINK_REFUSAL: Record<SsoLinkRefusal | "rate_limited", string> = {
  rate_limited: "Too many attempts. Try again later.",
  wrong_password: "Current password is incorrect.",
  second_factor_required:
    "As the owner, you need a second factor before you can link a single sign-on account.",
  provider_already_linked: "Your account already has an account linked at that provider.",
  already_linked:
    "That account at the provider is already linked to another BunMail account.",
  session_changed:
    "Your session changed while you were at the provider. Sign in and try again.",
};

/** What the page says for a refused unlink. */
const UNLINK_REFUSAL: Record<
  Exclude<UnlinkSsoIdentityResult, { ok: true }>["reason"],
  string
> = {
  not_found: "That link was not found: nothing was changed.",
  rate_limited: "Too many attempts. Try again later.",
  wrong_password: "Current password is incorrect.",
};

/** The configured provider with this id, or `null`. */
function providerById(id: string): SsoProviderSettings | null {
  return config.sso.providers.find((provider) => provider.id === id) ?? null;
}

/** A provider as the link service keys, records and labels it. */
function linkProviderOf(provider: SsoProviderSettings): {
  key: string;
  id: string;
  label: string;
} {
  return { key: ssoProviderKey(provider.issuer), id: provider.id, label: provider.label };
}

/** Redirects to the Sign-in methods page with a flash banner. */
function toSsoPage(
  set: Context["set"],
  message: string,
  type: "success" | "error",
): string {
  return redirect(
    set,
    `${SSO_PAGE}?flash=${encodeURIComponent(message)}&flashType=${type}`,
  );
}

/**
 * The SSO callback (#224). Public: the provider sends the browser here,
 * and it reads the browser's session itself for a link.
 */
export function ssoLoginPages(app: PublicDashboard) {
  return app.get(
    "/login/sso/:provider/callback",
    /**
     * GET /dashboard/login/sso/:provider/callback?code&state[&iss]
     * Finishes a link flow. In order:
     *
     * 1. Auth-page headers (`no-store`, no framing), with
     *    `Referrer-Policy: no-referrer`: the URL carries the one-time code,
     *    and this answer is a redirect, never a form.
     * 2. The per-IP login limiter (`DASHBOARD_LOGIN_RATE_LIMIT_*`), counted
     *    before anything else; over budget: refused, nothing called.
     * 3. The `bm_sso` cookie is read; it is cleared on every answer, this
     *    refusal included. The path's provider must be configured and SSO
     *    on.
     * 4. `finishSsoLinkCallback`: the flow cookie (this provider's,
     *    unexpired), `state` in constant time and consumed once, the
     *    RFC 9207 `iss`, only then the code exchange, every ID token check,
     *    a `link` purpose (a sign-in flow is refused), the browser's live
     *    session (the same session that started the link, so the same
     *    user), then the link (owner rule, one per provider, one account
     *    per identity).
     *
     * Success: the attempt is given back to the limiter, the account is
     * emailed (no links in it), and the browser goes to the Sign-in methods
     * page. Any failure: the Sign-in methods page with a message when the
     * browser presents a session cookie, else the login page's generic
     * message. Never logs the code, a token, the ID token or the subject.
     */
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
        presented !== undefined && isWellFormedToken(presented) ? presented : undefined;
      const fail = (message: string): string =>
        sessionToken === undefined
          ? redirect(set, LOGIN_FAILED)
          : toSsoPage(set, message, "error");

      const { loginRateLimit } = config.dashboard;
      if (loginRateLimit.enabled) {
        const { limited, retryAfterSec } = await takeLoginAttempt(
          [ip],
          loginRateLimit.maxAttempts,
          loginRateLimit.windowSec * 1000,
        );
        if (limited) {
          logger.warn("SSO callback blocked: too many attempts", { ip, retryAfterSec });
          if (await shouldAuditLockout(ip)) {
            await recordAuditEvent({
              action: "auth.login.rate_limited",
              outcome: "failure",
              actor: UNKNOWN_ACCOUNT,
              ...client,
              metadata: { retryAfterSec },
            });
          }
          return fail(LINK_REFUSAL.rate_limited);
        }
      }

      const flowCookie = readSsoFlowCookie(cookieHeader);
      const provider = providerById(params.provider);
      const baseUrl = config.sso.baseUrl;
      if (provider === null || baseUrl === null) {
        logger.warn("SSO callback refused: provider not configured or SSO off", {
          ip,
          ssoOn: baseUrl !== null,
        });
        return fail(FLOW_FAILED);
      }

      try {
        const outcome = await finishSsoLinkCallback({
          provider,
          baseUrl,
          flowCookie,
          params: new URL(request.url).searchParams,
          sessionToken,
          client,
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

        if (loginRateLimit.enabled) await refundLoginAttempt(ip);
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
  );
}

/* ─── Account: the Sign-in methods page ─── */

/** The page's rows: every configured provider, then links of providers no longer configured. */
async function methodRows(userId: string): Promise<SsoMethodRow[]> {
  const links = await listSsoLinks(userId);
  const { providers } = config.sso;
  const rows: SsoMethodRow[] = providers.map((provider) => ({
    providerId: provider.id,
    label: provider.label,
    link: links.find((link) => link.provider === ssoProviderKey(provider.issuer)) ?? null,
  }));
  for (const link of links) {
    if (providerOfLink(link.provider, providers) === null) {
      rows.push({ providerId: null, label: unconfiguredLinkLabel(link.provider), link });
    }
  }
  return rows;
}

/** Why the page offers no Link button, if anything keeps it from doing so. */
async function pageNotice(userId: string, role: string): Promise<SsoPageNotice> {
  if (config.sso.providers.length === 0) return "not_configured";
  if (config.sso.baseUrl === null) return "off";
  if (role === "owner") {
    const factors = await secondFactorsOf(userId);
    if (!factors.totp && factors.passkeys === 0) return "owner_needs_second_factor";
  }
  return "none";
}

/** The label of a stored link's provider, for the security email. */
function linkLabelOf(key: string): string {
  return providerOfLink(key, config.sso.providers)?.label ?? unconfiguredLinkLabel(key);
}

/**
 * The signed-in user's SSO links (#224): every role manages its own, like
 * its passkeys, so every route is `memberGuard` and scoped to
 * `auth.user.id` in the service. The session guard has already refused a
 * cross-origin POST.
 */
export function ssoAccountPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/account/sso
       * The Sign-in methods page: one row per configured provider (linked
       * or not), then links of providers no longer configured. Never
       * cached.
       */
      .get(
        "/account/sso",
        async ({ query, auth, set }) => {
          setNoStore(set);
          try {
            const [rows, notice] = await Promise.all([
              methodRows(auth.user.id),
              pageNotice(auth.user.id, auth.user.role),
            ]);
            return (
              <AccountSsoPage
                rows={rows}
                notice={notice}
                flash={toFlash(query.flash, query.flashType)}
              />
            );
          } catch (error: unknown) {
            logger.error("Sign-in methods page failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              error: errorMessage(error),
            });
            set.status = 500;
            return (
              <AccountSsoPage
                rows={[]}
                notice="none"
                flash={{ message: "Failed to load your sign-in methods.", type: "error" }}
              />
            );
          }
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/account/sso/:id/link (`:id`: the provider's id)
       * Starts linking an identity at a provider: the owner rule and one
       * link per provider, then the current password (form field
       * `password`) under the password change's budget
       * (`password:user:<id>`, `password:ip:<bucket>`) before the single
       * argon2id verify. Then a `link` flow bound to this session: the
       * encrypted `bm_sso` cookie and a redirect to the provider's
       * authorization endpoint. The link itself is written by the callback.
       */
      .post(
        "/account/sso/:id/link",
        async ({ params, body, auth, set, request, server }) => {
          setNoStore(set);
          const ip = requestIp(request, server?.requestIP(request)?.address);
          const ids = { userId: auth.user.id, sessionId: auth.session.id, ip };
          const provider = providerById(params.id);
          const baseUrl = config.sso.baseUrl;
          if (provider === null || baseUrl === null) {
            logger.warn("SSO link refused", { ...ids, reason: "provider_unavailable" });
            return toSsoPage(set, "That sign-in provider is not available.", "error");
          }
          try {
            const authorized: AuthorizeSsoLinkResult = await authorizeSsoLink(
              {
                userId: auth.user.id,
                provider: linkProviderOf(provider),
                password: body.password,
              },
              passwordChangeLimiter(auth.user.id, ip),
              dashboardClient(request, server),
            );
            if (!authorized.ok) {
              logger.warn("SSO link refused", {
                ...ids,
                provider: provider.id,
                reason: authorized.reason,
              });
              return toSsoPage(set, LINK_REFUSAL[authorized.reason], "error");
            }
            const started = await startSsoFlow({
              provider,
              baseUrl,
              purpose: "link",
              sessionId: auth.session.id,
            });
            if (!started.ok) {
              logger.warn("SSO link not started", {
                ...ids,
                provider: provider.id,
                reason: started.reason,
              });
              return toSsoPage(
                set,
                `${provider.label} could not be reached. Try again later.`,
                "error",
              );
            }
            issueSsoFlowCookie(set, started.flowCookie);
            logger.info("SSO link started", { ...ids, provider: provider.id });
            return redirect(set, started.authorizationUrl);
          } catch (error: unknown) {
            logger.error("SSO link start failed", {
              ...ids,
              provider: provider.id,
              error: errorMessage(error),
            });
            return toSsoPage(
              set,
              "Failed to start linking: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
          body: t.Object({ password: t.String({ maxLength: 1024 }) }),
        },
      )

      /**
       * POST /dashboard/account/sso/:id/unlink (`:id`: the link's id)
       * Removes one of the user's links after the current password (the
       * password change's budget). Every session the identity opened is
       * signed out with it. The account is emailed and the change recorded
       * (`auth.sso.unlinked`).
       */
      .post(
        "/account/sso/:id/unlink",
        async ({ params, body, auth, set, request, server }) => {
          const ip = requestIp(request, server?.requestIP(request)?.address);
          const ids = { userId: auth.user.id, sessionId: auth.session.id, ip };
          try {
            const result = await unlinkSsoIdentity(
              { userId: auth.user.id, linkId: params.id, password: body.password },
              passwordChangeLimiter(auth.user.id, ip),
              dashboardClient(request, server),
              (key) => auditProviderOf(key, config.sso.providers),
            );
            if (!result.ok) {
              logger.warn("SSO unlink refused", {
                ...ids,
                linkId: params.id,
                reason: result.reason,
              });
              return toSsoPage(set, UNLINK_REFUSAL[result.reason], "error");
            }
            logger.warn("SSO identity unlinked", {
              ...ids,
              linkId: params.id,
              sessionsRevoked: result.sessionsRevoked,
            });
            void sendTwoFactorAlert({
              event: "sso_unlinked",
              userId: auth.user.id,
              email: auth.user.email,
              ip: sessionIp(ip),
              sso: { provider: linkLabelOf(result.provider), account: result.name },
            });
            return toSsoPage(set, "Account unlinked.", "success");
          } catch (error: unknown) {
            logger.error("SSO unlink failed", {
              ...ids,
              linkId: params.id,
              error: errorMessage(error),
            });
            return toSsoPage(set, "Failed to unlink: nothing was changed.", "error");
          }
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
          body: t.Object({ password: t.String({ maxLength: 1024 }) }),
        },
      )
  );
}
