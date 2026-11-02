import { t } from "elysia";
import { config, type SsoProviderSettings } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import type {
  AuthorizeSsoLinkResult,
  UnlinkSsoIdentityResult,
} from "../../modules/users/types/sso.types.ts";
import {
  authorizeSsoLink,
  listSsoLinks,
  unlinkSsoIdentity,
} from "../../modules/users/services/sso-link.service.ts";
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
import {
  AccountSsoPage,
  type SsoMethodRow,
  type SsoPageNotice,
} from "../routes/account-sso.tsx";
import { memberGuard } from "../guards.tsx";
import { issueSsoFlowCookie } from "../lib/session-helpers.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { dashboardClient } from "../lib/audit.ts";
import { passwordChangeLimiter } from "../lib/password-limiter.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { requestIp } from "../lib/sign-in.tsx";
import { LINK_REFUSAL, providerById, toSsoPage } from "../lib/sso.ts";

/**
 * Single sign-on (OpenID Connect, #224) on Account > Sign-in methods
 * (`/dashboard/account/sso`, after the session guard, `memberGuard`): the
 * page, the Link form (the current password, then the browser goes to the
 * provider) and the Unlink form. The provider sends the browser back to
 * the public callback (`sso-login.plugin.tsx`), which finishes the link.
 *
 * Redirects are fixed: the provider's authorization URL (from its
 * discovery document) and the Sign-in methods page. No return parameter
 * is read.
 */

/** What the page says for a refused unlink. */
const UNLINK_REFUSAL: Record<
  Exclude<UnlinkSsoIdentityResult, { ok: true }>["reason"],
  string
> = {
  not_found: "That link was not found: nothing was changed.",
  rate_limited: "Too many attempts. Try again later.",
  wrong_password: "Current password is incorrect.",
};

/** A provider as the link service keys, records and labels it. */
function linkProviderOf(provider: SsoProviderSettings): {
  key: string;
  id: string;
  label: string;
} {
  return { key: ssoProviderKey(provider.issuer), id: provider.id, label: provider.label };
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
