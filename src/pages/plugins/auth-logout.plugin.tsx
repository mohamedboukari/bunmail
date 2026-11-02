import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { resolveClientIp } from "../../middleware/login-rate-limit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import { readSessionCookie } from "../session.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import { clearSession, revokeOnTokenReuse } from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import { userActor } from "../lib/sign-in.tsx";
import type { authTwoFactorLoginPages } from "./auth-login-two-factor.plugin.tsx";

/**
 * Sign-out (#216). Takes the instance the second login step was
 * registered on, so the route types chain exactly as in one `authPages`
 * chain.
 */
export function authLogoutPages(app: ReturnType<typeof authTwoFactorLoginPages>) {
  return (
    app
      /**
       * POST /dashboard/logout
       * Revokes the session (deletes its row) and clears the cookie (#216).
       * Same-origin only, so a third-party page cannot sign the operator out.
       * Works for missing, malformed, already revoked and legacy cookies: the
       * cookie is always cleared. A database error is logged and the cookie
       * is still cleared. Replaying the old cookie afterwards gets a 302 to
       * the login page.
       */
      .post("/logout", async ({ set, request, server }) => {
        const ip = resolveClientIp({
          socketIp: server?.requestIP(request)?.address,
          forwardedFor: request.headers.get("x-forwarded-for"),
          trustedProxyHops: config.dashboard.trustedProxyHops,
        });

        if (!isSameOrigin(request)) {
          logger.warn("Dashboard logout POST rejected: cross-origin (possible CSRF)", {
            ip,
            origin:
              request.headers.get("origin") ?? request.headers.get("referer") ?? null,
          });
          set.status = 403;
          return "Forbidden: cross-origin request rejected";
        }

        const token = readSessionCookie(request.headers.get("cookie"));
        if (token && isWellFormedToken(token)) {
          try {
            const revoked = await sessionService.revokeSessionByToken(token);
            if (!revoked) {
              /** A superseded token: someone else holds the live one. */
              const superseded = await sessionService.findSessionBySupersededToken(token);
              if (superseded) {
                await revokeOnTokenReuse(
                  superseded,
                  ip,
                  request.headers.get("user-agent"),
                );
              }
            }
            logger.info("Dashboard logout", {
              sessionId: revoked?.sessionId ?? null,
              ip,
            });
            if (revoked) {
              await recordAuditEvent({
                action: "auth.logout",
                actor: userActor(revoked.userId),
                ip,
                userAgent: request.headers.get("user-agent"),
                target: { type: "session", id: revoked.sessionId, label: null },
              });
            }
          } catch (error: unknown) {
            logger.error("Dashboard logout: session revoke failed", {
              ip,
              error: errorMessage(error),
            });
          }
        } else {
          logger.info("Dashboard logout", { sessionId: null, ip });
        }

        clearSession(set);
        return redirect(set, "/dashboard/login");
      })
  );
}
