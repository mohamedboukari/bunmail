import type { Elysia } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { setLogContextUser } from "../../utils/log-context.ts";
import { resolveClientIp } from "../../middleware/login-rate-limit.ts";
import { readSessionCookie } from "../session.ts";
import { toDashboardAuth } from "../guards.tsx";
import { setViewerRole } from "../viewer.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import {
  TWO_FACTOR_PAGE,
  isTwoFactorEnrolmentPath,
  twoFactorRequired,
} from "../../modules/users/services/two-factor-policy.service.ts";
import { redirect } from "./responses.ts";
import { errorMessage } from "./error-message.ts";
import { isSameOrigin } from "./same-origin.ts";
import {
  SESSION_STORE_DOWN,
  clearSession,
  issueSession,
  revokeOnTokenReuse,
} from "./session-helpers.ts";

/**
 * The dashboard instance the public area plugins are applied to (#291):
 * `/dashboard` routes with no session. Their handlers read only what any
 * Elysia context carries (query, body, set, request, server).
 */
export type PublicDashboard = Elysia<"/dashboard">;

/**
 * The session guard (#216): every route registered after it requires a
 * live session. In order:
 *
 * 1. No cookie: 302 to the login page.
 * 2. A cookie that is not a minted token (including a pre-#216
 *    `<ts>.<hmac>` cookie): cleared and redirected, with no database
 *    query.
 * 3. One indexed lookup (`findActiveSession`): the session must exist,
 *    be unexpired, belong to an enabled user and have `password` or
 *    `mfa` assurance. A `pending` session (#220: password passed, second
 *    factor not yet) is no session here, on every route: only the public
 *    two-factor login page opens it. No row: cookie cleared, 302. A
 *    database error: 503, never a pass-through (fail closed) and never a
 *    false logout.
 * 4. The token replaced by the last rotation, presented after the grace
 *    period, or any older superseded token (`session_token_history`):
 *    reuse detected. Two parties hold the session, so every session of
 *    the user is revoked, the cookie cleared, 302.
 * 5. A cross-origin POST: 403 (CSRF second layer, #133).
 * 6. The current token, older than a minute: rotated. The new token goes
 *    out with this response; when a parallel request rotated first, this
 *    one is served without a new cookie. A rotation error is logged and
 *    the request is served (the old token stays current).
 * 7. The `REQUIRE_2FA` policy (#220): an account whose role must have a
 *    second factor and has none (`hasTotp`, from the same lookup) is
 *    sent to its Two-factor page (302) from every route but that page
 *    and its actions, until it enrols. Logout and the assets are public
 *    routes, so they stay reachable.
 * 8. The request goes on with `auth` (#222): the account (id, email,
 *    role) and the session (id, assurance), all from the lookup in step
 *    3, so a request costs exactly one session query. Each route's own
 *    `beforeHandle` (`memberGuard`, `adminGuard`, `ownerGuard` from
 *    `guards.tsx`) then checks the role.
 *
 * It is a `resolve`, not an `onBeforeHandle`, so the type of `auth`
 * flows to every handler registered after it. A `resolve` can only stop
 * the request by returning `status()` (any other value is merged into
 * the context), so each refusal sets its headers on `set` and returns
 * `status(code, body)`. Like every local hook it applies only to routes
 * registered after it: `pagesPlugin` applies it after the public routes,
 * so they never run it.
 *
 * A functional plugin (#291): `pagesPlugin.use(withSessionGuard)` calls
 * it with the dashboard instance itself, so the `resolve` is registered
 * on that instance exactly as when it was written inline.
 */
export function withSessionGuard(app: PublicDashboard) {
  return app.resolve(async ({ request, set, path, server, status }) => {
    const token = readSessionCookie(request.headers.get("cookie"));
    if (!token) {
      redirect(set, "/dashboard/login");
      return status(302, "");
    }
    if (!isWellFormedToken(token)) {
      logger.debug("Dashboard session cookie malformed or legacy, clearing it");
      clearSession(set);
      redirect(set, "/dashboard/login");
      return status(302, "");
    }

    let session: Awaited<ReturnType<typeof sessionService.findActiveSession>>;
    try {
      session = await sessionService.findActiveSession(token);
    } catch (error: unknown) {
      logger.error("Dashboard session lookup failed", {
        path,
        error: errorMessage(error),
      });
      return status(503, SESSION_STORE_DOWN);
    }

    /**
     * Reuse: the previous token after the grace period, or (no live match)
     * an older superseded token from the session's history.
     */
    let reusedBy: { userId: string; sessionId: string } | null = null;
    if (session && session.matched === "previous" && session.graceOver) {
      reusedBy = session;
    } else if (!session) {
      try {
        reusedBy = await sessionService.findSessionBySupersededToken(token);
      } catch (error: unknown) {
        logger.error("Dashboard session lookup failed", {
          path,
          error: errorMessage(error),
        });
        return status(503, SESSION_STORE_DOWN);
      }
    }

    if (reusedBy) {
      const ip = resolveClientIp({
        socketIp: server?.requestIP(request)?.address,
        forwardedFor: request.headers.get("x-forwarded-for"),
        trustedProxyHops: config.dashboard.trustedProxyHops,
      });
      try {
        await revokeOnTokenReuse(reusedBy, ip, request.headers.get("user-agent"));
      } catch (error: unknown) {
        logger.error("Session token reuse detected, but revoking the sessions failed", {
          userId: reusedBy.userId,
          sessionId: reusedBy.sessionId,
          ip,
          error: errorMessage(error),
        });
        return status(503, SESSION_STORE_DOWN);
      }
      clearSession(set);
      redirect(set, "/dashboard/login");
      return status(302, "");
    }

    if (!session) {
      logger.debug("Dashboard session invalid, redirecting to login");
      clearSession(set);
      redirect(set, "/dashboard/login");
      return status(302, "");
    }

    /**
     * CSRF second layer (#133): every state-mutating dashboard action is a
     * POST, so require same-origin on POST. `SameSite=Lax` is the primary
     * defense; this rejects a forged cross-site form-POST that rides the
     * operator's session cookie. Returns 403 (not a redirect) so it's an
     * explicit refusal, not a silent bounce. Checked before rotation, so a
     * rejected request never carries a new token.
     */
    if (request.method === "POST" && !isSameOrigin(request)) {
      logger.warn("Dashboard POST rejected: cross-origin (possible CSRF)", {
        path,
        origin: request.headers.get("origin") ?? request.headers.get("referer") ?? null,
      });
      return status(403, "Forbidden: cross-origin request rejected");
    }

    if (session.matched === "current" && session.rotationDue) {
      try {
        const rotated = await sessionService.rotateSession(session.sessionId, token);
        if (rotated) issueSession(set, rotated.token, rotated.maxAgeSec);
      } catch (error: unknown) {
        logger.error("Dashboard session rotation failed", {
          sessionId: session.sessionId,
          error: errorMessage(error),
        });
      }
    }

    /** Every later log line of this request names the user (#222, #284). */
    setLogContextUser(session.userId);

    /**
     * `REQUIRE_2FA` (#220): no dashboard until a required second factor is
     * set up. After the rotation, so a held-back session still slides.
     */
    if (
      !session.hasTotp &&
      twoFactorRequired(config.dashboard.require2fa, session.role) &&
      !isTwoFactorEnrolmentPath(path)
    ) {
      logger.debug("Two-factor enrolment required: redirected to the Two-factor page", {
        sessionId: session.sessionId,
        role: session.role,
        path,
      });
      redirect(set, TWO_FACTOR_PAGE);
      return status(302, "");
    }

    /** The sidebar hides admin-only links from members (#218). */
    setViewerRole(session.role);
    return { auth: toDashboardAuth(session) };
  });
}

/**
 * The dashboard instance after the session guard (#291): the protected
 * area plugins take it, so `auth` is typed in every handler they register.
 * Derived from the guard itself, so it always matches what it resolves.
 */
export type GuardedDashboard = ReturnType<typeof withSessionGuard>;
