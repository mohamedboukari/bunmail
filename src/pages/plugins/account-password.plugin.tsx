import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import type { PasswordChangeRefusal } from "../../modules/users/types/user.types.ts";
import { resolveClientIp } from "../../middleware/login-rate-limit.ts";
import { AccountPasswordPage } from "../routes/account-password.tsx";
import { memberGuard } from "../guards.tsx";
import * as passwordChangeService from "../../modules/users/services/password-change.service.ts";
import { issueSession } from "../lib/session-helpers.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { passwordChangeLimiter } from "../lib/password-limiter.ts";
import type { accountTwoFactorManagePages } from "./account-two-factor-manage.plugin.tsx";

/* ─── Password change helpers (#279) ─── */

/** Where the form lives, and where a completed change lands. */
const PASSWORD_PAGE = "/dashboard/account/password";

/** The success flash: the user stays signed in here only. */
const CHANGED_TEXT = "Password changed. You were signed out on every other device.";

/**
 * Text and status for a refused change, re-rendered on the form. A wrong
 * current password gets one generic message. `invalid_input` carries the
 * policy's own message instead (see `answerRefusal`).
 */
const REFUSAL: Record<
  Exclude<PasswordChangeRefusal, "invalid_input">,
  { text: string; status: number }
> = {
  rate_limited: { text: "Too many attempts. Try again later.", status: 429 },
  wrong_password: { text: "Current password is incorrect.", status: 200 },
  account_inactive: {
    text: "Your account is no longer active: nothing was changed.",
    status: 409,
  },
  credential_changed: {
    text: "Your password was just changed or reset elsewhere: nothing was changed here. Sign in again.",
    status: 409,
  },
};

/**
 * The Change password page (#279) and its POST. Takes the instance the
 * two-factor routes were registered on, so the route types chain exactly
 * as in one `accountPages` chain.
 */
export function accountPasswordPages(
  app: ReturnType<typeof accountTwoFactorManagePages>,
) {
  return (
    app
      /**
       * GET /dashboard/account/password
       * The change password form, with the success flash after a change.
       */
      .get(
        "/account/password",
        ({ query, auth, set }) => {
          setNoStore(set);
          return (
            <AccountPasswordPage
              email={auth.user.email}
              flash={toFlash(query.flash, query.flashType)}
            />
          );
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
       * POST /dashboard/account/password
       * Changes the signed-in user's password (#279). The session guard has
       * already refused a cross-origin POST (403) before this runs. Then,
       * in `changePassword`: the failed-attempt budget (over budget: 429,
       * no argon2id), the policy (current password required, new one 15 to
       * 256 characters, confirmed, different from the current one: no
       * argon2id, not counted), the attempt counted before the single
       * argon2id verify, and the change itself in one locked transaction.
       * Every refusal re-renders the form with an error and changes nothing.
       *
       * On success every session of the account is gone (this one too), and
       * the fresh session opened for this browser, bound to the new
       * credential, is set as the cookie; the browser goes back to the form
       * with the success flash.
       *
       * The body schema is deliberately loose (only length caps): a schema
       * failure answers 422 JSON from the global handler, not a page.
       */
      .post(
        "/account/password",
        async ({ body, set, auth, request, server }) => {
          setNoStore(set);
          const ip = resolveClientIp({
            socketIp: server?.requestIP(request)?.address,
            forwardedFor: request.headers.get("x-forwarded-for"),
            trustedProxyHops: config.dashboard.trustedProxyHops,
          });
          const userId = auth.user.id;

          try {
            const result = await passwordChangeService.changePassword(
              {
                userId,
                assurance: auth.session.assurance,
                current: body.current,
                password: body.password,
                confirm: body.confirm,
              },
              passwordChangeLimiter(userId, ip),
              { ip, userAgent: request.headers.get("user-agent") },
            );

            if (!result.ok) {
              logger.warn("Password change refused", {
                userId,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              const { text, status } =
                result.reason === "invalid_input"
                  ? { text: result.problem, status: 200 }
                  : REFUSAL[result.reason];
              set.status = status;
              return (
                <AccountPasswordPage
                  email={auth.user.email}
                  flash={{ message: text, type: "error" }}
                />
              );
            }

            logger.warn("Password changed", {
              userId,
              sessionId: result.sessionId,
              previousSessionId: auth.session.id,
              sessionsRevoked: result.sessionsRevoked,
              resetLinksRevoked: result.resetLinksRevoked,
              ip,
            });

            issueSession(set, result.sessionToken);
            return redirect(
              set,
              `${PASSWORD_PAGE}?flash=${encodeURIComponent(CHANGED_TEXT)}&flashType=success`,
            );
          } catch (error: unknown) {
            logger.error("Password change failed", {
              userId,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            set.status = 500;
            return (
              <AccountPasswordPage
                email={auth.user.email}
                flash={{
                  message: "Failed to change the password: nothing was changed.",
                  type: "error",
                }}
              />
            );
          }
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({
            current: t.String({ maxLength: 1024 }),
            password: t.String({ maxLength: 1024 }),
            confirm: t.String({ maxLength: 1024 }),
          }),
        },
      )
  );
}
