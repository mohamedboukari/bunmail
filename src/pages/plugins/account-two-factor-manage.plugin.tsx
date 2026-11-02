import { t, type Context } from "elysia";
import { logger } from "../../utils/logger.ts";
import type { DashboardAuth } from "../../modules/users/types/user.types.ts";
import { memberGuard } from "../guards.tsx";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as twoFactorService from "../../modules/users/services/two-factor.service.ts";
import { clearSession } from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import {
  twoFactorSessionLimiter,
  type TwoFactorLimiter,
} from "../lib/two-factor-limiter.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import { dashboardClient } from "../lib/audit.ts";
import { clientIp } from "../lib/client-ip.ts";
import {
  TWO_FACTOR_REFUSAL,
  alertTwoFactorChange,
  stashRecoveryCodes,
  toTwoFactorPage,
} from "../lib/account-two-factor.ts";
import type { accountTwoFactorPages } from "./account-two-factor.plugin.tsx";

/**
 * Ends this session when its own two-factor budget is spent (#220): a
 * session that keeps guessing codes (or the password on the disable form)
 * is treated as stolen. Only the session's key decides, not the address
 * key, which other accounts behind the same address share. Returns the
 * redirect to the login page, or `undefined` when the budget is not spent.
 */
async function endSessionIfBudgetSpent(
  limiter: TwoFactorLimiter,
  auth: DashboardAuth,
  set: Context["set"],
  request: Request,
  ip: string,
  action: "disable" | "recovery_codes",
): Promise<string | undefined> {
  if (!(await limiter.ownKeyLimited())) return undefined;
  await sessionService.revokeUserSession(auth.user.id, auth.session.id);
  logger.warn("Two-factor code budget spent in a session: session revoked", {
    userId: auth.user.id,
    sessionId: auth.session.id,
    action,
    ip,
  });
  await recordAuditEvent({
    action: "auth.session.revoked",
    outcome: "failure",
    actor: { type: "user", id: auth.user.id, label: auth.user.email },
    ip,
    userAgent: request.headers.get("user-agent"),
    target: { type: "session", id: auth.session.id, label: null },
    metadata: { current: true, reason: "code_budget_spent" },
  });
  clearSession(set);
  return redirect(set, "/dashboard/login");
}

/**
 * Two-factor authentication while it is on (#220): new recovery codes and
 * turning it off. Takes the instance the Two-factor page was registered
 * on, so the route types chain exactly as in one `accountPages` chain.
 */
export function accountTwoFactorManagePages(
  app: ReturnType<typeof accountTwoFactorPages>,
) {
  return (
    app
      /**
       * POST /dashboard/account/two-factor/recovery-codes
       * Replaces every recovery code with ten new ones (#220). Needs a code
       * from the authenticator app (not a recovery code), checked against
       * this session's own budget (`totp:session:<id>` and the address key,
       * never the account's login budget) before any verification; once
       * the session's budget is spent the session is revoked. The new codes
       * are revealed once, and the account is emailed.
       */
      .post(
        "/account/two-factor/recovery-codes",
        async ({ body, auth, set, request, server }) => {
          const ip = clientIp(request, server?.requestIP(request)?.address);
          const limiter = twoFactorSessionLimiter(auth.session.id, ip);
          try {
            const result = await twoFactorService.regenerateRecoveryCodes(
              auth.user.id,
              body.code,
              limiter,
              dashboardClient(request, server),
            );
            if (!result.ok) {
              logger.warn("Recovery codes not regenerated", {
                userId: auth.user.id,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              const ended = await endSessionIfBudgetSpent(
                limiter,
                auth,
                set,
                request,
                ip,
                "recovery_codes",
              );
              if (ended !== undefined) return ended;
              return toTwoFactorPage(set, TWO_FACTOR_REFUSAL[result.reason], "error");
            }
            await limiter.clear();
            logger.warn("Recovery codes regenerated", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
            });
            alertTwoFactorChange("recovery_codes_regenerated", auth, ip);
            return toTwoFactorPage(
              set,
              "New recovery codes created. The old ones no longer work.",
              "success",
              await stashRecoveryCodes(result.recoveryCodes, auth),
            );
          } catch (error: unknown) {
            logger.error("Recovery code regeneration failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toTwoFactorPage(
              set,
              "Failed to create new recovery codes: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({ code: t.String({ maxLength: 1024 }) }),
        },
      )

      /**
       * POST /dashboard/account/two-factor/disable
       * Turns two-factor authentication off (#220). An account without 2FA
       * is answered at once, before any password work. Otherwise needs the
       * current password AND a code (from the app, or a recovery code),
       * with this session's own budget (`totp:session:<id>` and the address
       * key, never the account's login budget) checked and counted before
       * the argon2id verify; once the session's budget is spent the session
       * is revoked. The `totp` credential and its recovery codes are
       * deleted; sessions are kept; the account is emailed. Under
       * `REQUIRE_2FA` the account is then sent back to this page until it
       * enrols again.
       */
      .post(
        "/account/two-factor/disable",
        async ({ body, auth, set, request, server }) => {
          const ip = clientIp(request, server?.requestIP(request)?.address);
          const limiter = twoFactorSessionLimiter(auth.session.id, ip);
          try {
            const result = await twoFactorService.disableTwoFactor(
              auth.user.id,
              body.password,
              body.code,
              limiter,
              dashboardClient(request, server),
            );
            if (!result.ok) {
              logger.warn("Two-factor disable refused", {
                userId: auth.user.id,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              const ended = await endSessionIfBudgetSpent(
                limiter,
                auth,
                set,
                request,
                ip,
                "disable",
              );
              if (ended !== undefined) return ended;
              const reason =
                result.reason === "wrong_code" ? "wrong_password" : result.reason;
              return toTwoFactorPage(set, TWO_FACTOR_REFUSAL[reason], "error");
            }
            await limiter.clear();
            logger.warn("Two-factor authentication disabled", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              method: result.method,
              ip,
            });
            alertTwoFactorChange("disabled", auth, ip);
            return toTwoFactorPage(set, "Two-factor authentication is off.", "success");
          } catch (error: unknown) {
            logger.error("Two-factor disable failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toTwoFactorPage(
              set,
              "Failed to turn off two-factor authentication: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({
            password: t.String({ maxLength: 1024 }),
            code: t.String({ maxLength: 1024 }),
          }),
        },
      )
  );
}
