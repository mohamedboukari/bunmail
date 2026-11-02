import { t, type Context } from "elysia";
import { logger } from "../../utils/logger.ts";
import { AccountSessionsPage } from "../routes/account-sessions.tsx";
import { memberGuard } from "../guards.tsx";
import * as sessionService from "../../modules/users/services/session.service.ts";
import { clearSession } from "../lib/session-helpers.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { clientIp } from "../lib/client-ip.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import { dashboardAudit } from "../lib/audit.ts";

/* ─── Active sessions helpers (#281) ─── */

/** The Active sessions page, where its actions land. */
const SESSIONS_PAGE = "/dashboard/account/sessions";

/** Redirects to the sessions page with a flash banner. */
function toSessionsPage(
  set: Context["set"],
  message: string,
  type: "success" | "error",
): string {
  return redirect(
    set,
    `${SESSIONS_PAGE}?flash=${encodeURIComponent(message)}&flashType=${type}`,
  );
}

/**
 * The Active sessions page (#281) and its actions. The first group of
 * `accountPages` (`account.plugin.tsx`).
 */
export function accountSessionPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/account/sessions
       * The signed-in user's live sessions (#281), the current one marked.
       * Only the user's own: the query is scoped to `auth.user.id`.
       */
      .get(
        "/account/sessions",
        async ({ query, auth, set }) => {
          setNoStore(set);
          try {
            const sessions = await sessionService.listUserSessions(auth.user.id);
            return (
              <AccountSessionsPage
                sessions={sessions}
                currentSessionId={auth.session.id}
                flash={toFlash(query.flash, query.flashType)}
              />
            );
          } catch (error: unknown) {
            logger.error("Active sessions list failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              error: errorMessage(error),
            });
            set.status = 500;
            return (
              <AccountSessionsPage
                sessions={[]}
                currentSessionId={auth.session.id}
                flash={{ message: "Failed to load your sessions.", type: "error" }}
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
       * POST /dashboard/account/sessions/revoke-others
       * Signs out every other session of the user (#281): all but the
       * session of this request. Registered before `/:id/revoke` only for
       * reading order; the paths cannot collide.
       */
      .post(
        "/account/sessions/revoke-others",
        async ({ auth, set, request, server }) => {
          const ip = clientIp(request, server?.requestIP(request)?.address);
          const userId = auth.user.id;
          try {
            const revoked = await sessionService.revokeOtherUserSessions(
              userId,
              auth.session.id,
            );
            logger.warn("Other sessions revoked by their user", {
              userId,
              sessionId: auth.session.id,
              sessionsRevoked: revoked,
              ip,
            });
            await recordAuditEvent({
              ...dashboardAudit(auth, request, server),
              action: "auth.session.others_revoked",
              target: { type: "user", id: userId, label: auth.user.email },
              metadata: { sessionsRevoked: revoked },
            });
            return toSessionsPage(
              set,
              revoked === 0
                ? "No other device was signed in."
                : `Signed out ${revoked} other ${revoked === 1 ? "device" : "devices"}.`,
              "success",
            );
          } catch (error: unknown) {
            logger.error("Revoking other sessions failed", {
              userId,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toSessionsPage(
              set,
              "Failed to sign out the other devices: nothing was changed.",
              "error",
            );
          }
        },
        { beforeHandle: memberGuard },
      )

      /**
       * POST /dashboard/account/sessions/:id/revoke
       * Signs out one session of the user (#281). The delete is scoped to
       * `auth.user.id` in the service, so another user's session id, or an
       * unknown one, changes nothing (404 with an error flash). Revoking the
       * session of this request signs this browser out: the cookie is
       * cleared and the browser goes to the login page.
       */
      .post(
        "/account/sessions/:id/revoke",
        async ({ params, auth, set, request, server }) => {
          const ip = clientIp(request, server?.requestIP(request)?.address);
          const userId = auth.user.id;
          const isCurrent = params.id === auth.session.id;
          try {
            const revoked = await sessionService.revokeUserSession(userId, params.id);
            if (!revoked) {
              logger.warn("Session revoke refused: not one of the user's sessions", {
                userId,
                sessionId: params.id,
                currentSessionId: auth.session.id,
                ip,
              });
              set.status = 404;
              const sessions = await sessionService.listUserSessions(userId);
              return (
                <AccountSessionsPage
                  sessions={sessions}
                  currentSessionId={auth.session.id}
                  flash={{
                    message: "That session was not found: nothing was changed.",
                    type: "error",
                  }}
                />
              );
            }
            logger.warn("Session revoked by its user", {
              userId,
              sessionId: params.id,
              currentSessionId: auth.session.id,
              current: isCurrent,
              ip,
            });
            await recordAuditEvent({
              ...dashboardAudit(auth, request, server),
              action: "auth.session.revoked",
              target: { type: "session", id: params.id, label: null },
              metadata: { current: isCurrent, reason: "user" },
            });
            if (isCurrent) {
              clearSession(set);
              return redirect(set, "/dashboard/login");
            }
            return toSessionsPage(set, "Signed out that device.", "success");
          } catch (error: unknown) {
            logger.error("Session revoke failed", {
              userId,
              sessionId: params.id,
              currentSessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toSessionsPage(
              set,
              "Failed to sign out the device: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
        },
      )
  );
}
