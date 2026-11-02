import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import { readSessionCookie } from "../session.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as twoFactorService from "../../modules/users/services/two-factor.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import { issueSession, SESSION_STORE_DOWN } from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import { twoFactorLoginLimiter } from "../lib/two-factor-limiter.ts";
import { ssoProviderLabelOf } from "../lib/sso.ts";
import {
  completeSignIn,
  endLockedSecondStep,
  requestIp,
  secondStepPage,
  setAuthPageHeaders,
  userActor,
} from "../lib/sign-in.tsx";
import type { authLoginPages } from "./auth-login.plugin.tsx";

/**
 * The second login step with a TOTP or recovery code (#220): its form and
 * its POST. Takes the instance the login routes were registered on, so
 * the route types chain exactly as in one `authPages` chain.
 */
export function authTwoFactorLoginPages(app: ReturnType<typeof authLoginPages>) {
  return (
    app
      /**
       * GET /dashboard/login/two-factor
       * The second login step (#220): the code form, for a browser holding
       * a `pending` session (the password was right, a second factor is
       * required). Auth-page headers. Anything else (no cookie, a full
       * session, an expired or revoked pending one) is sent to `/dashboard`,
       * where the session guard lets a live session in and sends everything
       * else to the login page; the cookie is not touched here.
       */
      .get("/login/two-factor", async ({ set, request }) => {
        setAuthPageHeaders(set);
        const token = readSessionCookie(request.headers.get("cookie"));
        try {
          const pending =
            token && isWellFormedToken(token)
              ? await sessionService.findPendingSession(token)
              : null;
          if (!pending) return redirect(set, "/dashboard");
          return await secondStepPage(pending.userId);
        } catch (error: unknown) {
          logger.error("Two-factor sign-in page: session lookup failed", {
            error: errorMessage(error),
          });
          set.status = 503;
          return SESSION_STORE_DOWN;
        }
      })

      /**
       * POST /dashboard/login/two-factor
       * Checks the second factor (#220): a 6-digit code from the
       * authenticator app, or a recovery code. In order: auth-page headers;
       * same-origin; the pending session (none: to `/dashboard`, cookie
       * untouched, see below); then `completeTwoFactorLogin`, which checks the
       * failed-attempt budget (`totp:user:<id>` and `totp:ip:<bucket>`) and
       * counts the attempt before any verification, and in one transaction
       * spends the code (replay-proof) and turns the session into an `mfa`
       * session with a fresh token (the pending one dies).
       *
       * A wrong, expired or reused code gets one generic message. Once the
       * budget is spent the pending session is revoked and the browser is
       * sent back to the login page. On success the budget is cleared, the
       * new cookie is set, and the post-login steps run: the location
       * lookup (#281) and the new-device check (#282), only now that the
       * sign-in is complete. A recovery code is logged at `warn` with the
       * codes left.
       */
      .post(
        "/login/two-factor",
        async ({ body, set, request, server }) => {
          setAuthPageHeaders(set);
          const ip = requestIp(request, server?.requestIP(request)?.address);

          if (!isSameOrigin(request)) {
            logger.warn(
              "Two-factor sign-in POST rejected: cross-origin (possible CSRF)",
              {
                ip,
                origin:
                  request.headers.get("origin") ?? request.headers.get("referer") ?? null,
              },
            );
            set.status = 403;
            return "Forbidden: cross-origin request rejected";
          }

          const token = readSessionCookie(request.headers.get("cookie"));
          try {
            const pending =
              token && isWellFormedToken(token)
                ? await sessionService.findPendingSession(token)
                : null;
            /**
             * No pending session: expired, revoked, or already completed by a
             * parallel submission (a double click). The cookie is left alone,
             * since it may be the fresh one that submission just set: the
             * guard behind `/dashboard` lets a live session in and sends
             * anything else to the login page.
             */
            if (!token || !pending) {
              logger.debug("Two-factor sign-in refused: no pending session", { ip });
              return redirect(set, "/dashboard");
            }

            const limiter = twoFactorLoginLimiter(pending.userId, ip);
            const audit = {
              actor: userActor(pending.userId),
              ip,
              userAgent: request.headers.get("user-agent"),
              target: { type: "session" as const, id: pending.sessionId, label: null },
            };
            const result = await twoFactorService.completeTwoFactorLogin(
              pending,
              token,
              body.code,
              limiter,
            );

            if (!result.ok) {
              if (result.reason === "session_gone") {
                logger.debug("Two-factor sign-in refused: pending session gone", {
                  userId: pending.userId,
                  sessionId: pending.sessionId,
                  ip,
                });
                return redirect(set, "/dashboard");
              }
              if (result.reason === "wrong_code") {
                logger.warn("Two-factor sign-in failed: invalid code", {
                  userId: pending.userId,
                  sessionId: pending.sessionId,
                  ip,
                });
                /** Bounded by the code budget: 5 per account per 15 minutes. */
                await recordAuditEvent({
                  ...audit,
                  action: "auth.login.failed",
                  outcome: "failure",
                  metadata: { step: "two_factor", reason: "wrong_code" },
                });
              }
              /** Budget spent (now or before): the pending session ends here. */
              if (result.reason === "rate_limited" || (await limiter.isLimited())) {
                return endLockedSecondStep(set, request, { token, pending, ip, limiter });
              }
              return await secondStepPage(pending.userId, "Invalid code. Try again.");
            }

            await limiter.clear();
            issueSession(set, result.token, result.maxAgeSec);
            logger.info("Dashboard login successful", {
              userId: pending.userId,
              sessionId: pending.sessionId,
              method: result.method,
              ip,
            });
            if (result.method === "recovery_code") {
              logger.warn("Recovery code used", {
                userId: pending.userId,
                sessionId: pending.sessionId,
                recoveryCodesLeft: result.recoveryCodesLeft,
                ip,
              });
            }
            await recordAuditEvent({
              ...audit,
              action: "auth.login.succeeded",
              metadata:
                result.recoveryCodesLeft === null
                  ? { method: result.method }
                  : {
                      method: result.method,
                      recoveryCodesLeft: result.recoveryCodesLeft,
                    },
            });

            completeSignIn(set, request, {
              userId: pending.userId,
              email: pending.email,
              sessionId: pending.sessionId,
              ip,
              /** An SSO first factor (#224) is named in the new-device alert. */
              ssoProvider: ssoProviderLabelOf(pending.ssoProvider),
            });
            return redirect(set, "/dashboard");
          } catch (error: unknown) {
            logger.error("Two-factor sign-in failed: session store error", {
              ip,
              error: errorMessage(error),
            });
            set.status = 503;
            return SESSION_STORE_DOWN;
          }
        },
        {
          /** Loose on purpose (a schema failure is 422 JSON, not a page); the service checks the shape. */
          body: t.Object({
            code: t.String({ maxLength: 1024 }),
          }),
        },
      )
  );
}
