import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { redactEmail } from "../../utils/redact.ts";
import { resolveClientIp } from "../../middleware/login-rate-limit.ts";
import { PasswordResetInvalidPage, PasswordResetPage } from "../routes/reset.tsx";
import { readSessionCookie } from "../session.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as passwordResetService from "../../modules/users/services/password-reset.service.ts";
import { setupPasswordProblem } from "../../modules/users/services/owner-setup-policy.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import { issueSession, revokeOnTokenReuse } from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import { removedLinkFacts } from "../lib/sso.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { setAuthPageHeaders } from "../lib/sign-in.tsx";
import type { authInvitePages } from "./auth-invite.plugin.tsx";

/**
 * The password reset from an admin-issued link (#277): its form and its
 * POST. Takes the instance the invitation accept was registered on, so the
 * route types chain exactly as in one `authPages` chain.
 */
export function authResetPages(app: ReturnType<typeof authInvitePages>) {
  return (
    app
      /**
       * GET /dashboard/reset?token=...
       * Password reset form (#277), from the one-time link an admin issued on
       * the Users page. Public: the token is the authorization. Mirrors the
       * invitation accept page: auth-page headers, read-only (link scanners
       * and prefetchers cannot burn the token), the format checked before any
       * database call, and one identical 400 page for every unusable link
       * (missing, malformed, unknown, expired, used, revoked, account or
       * issuer no longer eligible).
       */
      .get(
        "/reset",
        async ({ query, set }) => {
          setAuthPageHeaders(set);
          const token = query.token ?? "";
          const target = isWellFormedToken(token)
            ? await passwordResetService.findLivePasswordReset(token)
            : null;
          if (!target) {
            set.status = 400;
            return <PasswordResetInvalidPage />;
          }
          return <PasswordResetPage token={token} email={target.email} />;
        },
        {
          query: t.Object({
            token: t.Optional(t.String({ maxLength: 128 })),
          }),
        },
      )

      /**
       * POST /dashboard/reset
       * Sets the new password (#277). Same order as the invitation accept
       * POST: auth-page headers; same-origin first (the session guard's CSRF
       * check never runs on public routes); token format; an indexed lookup;
       * the password policy (a failure re-renders the form with 200, no
       * hashing, no write); only then argon2id inside `completePasswordReset`,
       * which spends the token, replaces the password, revokes every session
       * and every other open token of the account and opens a new session, in
       * one transaction.
       *
       * On success the session the browser presented, if any, is revoked
       * (like login: sessions do not stack, and a superseded token is treated
       * as reuse), the new cookie is set and the browser goes to `/dashboard`,
       * which also drops the token from the address bar.
       *
       * The body schema is deliberately loose (only length caps): a schema
       * failure answers 422 JSON from the global handler, not a page.
       */
      .post(
        "/reset",
        async ({ body, set, request, server }) => {
          setAuthPageHeaders(set);
          const ip = resolveClientIp({
            socketIp: server?.requestIP(request)?.address,
            forwardedFor: request.headers.get("x-forwarded-for"),
            trustedProxyHops: config.dashboard.trustedProxyHops,
          });

          if (!isSameOrigin(request)) {
            logger.warn("Password reset POST rejected: cross-origin (possible CSRF)", {
              ip,
              origin:
                request.headers.get("origin") ?? request.headers.get("referer") ?? null,
            });
            set.status = 403;
            return "Forbidden: cross-origin request rejected";
          }

          const target = isWellFormedToken(body.token)
            ? await passwordResetService.findLivePasswordReset(body.token)
            : null;
          if (!target) {
            /** `debug`, like the invitation page: an anonymous flood must not fill `warn`. */
            logger.debug("Password reset refused: invalid link", { ip });
            set.status = 400;
            return <PasswordResetInvalidPage />;
          }

          const problem = setupPasswordProblem(body.password, body.confirm);
          if (problem) {
            return (
              <PasswordResetPage
                token={body.token}
                email={target.email}
                error={problem}
              />
            );
          }

          const result = await passwordResetService.completePasswordReset(
            body.token,
            body.password,
            { ip, userAgent: request.headers.get("user-agent") },
          );
          if (!result.ok) {
            logger.debug("Password reset refused: invalid link", {
              resetId: target.resetId,
              ip,
            });
            set.status = 400;
            return <PasswordResetInvalidPage />;
          }

          /**
           * Replace the browser's previous session, as login does. The new
           * password is set at this point, so a failure here is logged and the
           * new session is still issued.
           */
          const presented = readSessionCookie(request.headers.get("cookie"));
          if (presented && isWellFormedToken(presented)) {
            try {
              const revoked = await sessionService.revokeSessionByToken(presented);
              if (!revoked) {
                const superseded =
                  await sessionService.findSessionBySupersededToken(presented);
                if (superseded) {
                  await revokeOnTokenReuse(
                    superseded,
                    ip,
                    request.headers.get("user-agent"),
                  );
                }
              }
            } catch (error: unknown) {
              logger.error(
                "Password reset done, but revoking the previous session failed",
                {
                  userId: result.userId,
                  ip,
                  error: errorMessage(error),
                },
              );
            }
          }

          logger.warn("Password reset completed", {
            resetId: result.resetId,
            userId: result.userId,
            issuedBy: result.issuedBy,
            email: redactEmail(result.email),
            sessionsRevoked: result.sessionsRevoked,
            tokensRevoked: result.tokensRevoked,
            issuedTokensRevoked: result.issuedTokensRevoked,
            twoFactorRemoved: result.twoFactorRemoved,
            passkeysRemoved: result.secondFactorsRemoved.passkeys,
            ssoLinksRemoved: result.ssoLinksRemoved.length,
            sessionId: result.sessionId,
            ip,
          });
          /**
           * The reset removed the account's second factors (#220, #223) or
           * SSO links (#224): tell the account.
           */
          if (result.twoFactorRemoved || result.ssoLinksRemoved.length > 0) {
            void sendTwoFactorAlert({
              event: "removed_by_reset",
              userId: result.userId,
              email: result.email,
              ip: sessionIp(ip),
              removed: result.secondFactorsRemoved,
              removedSsoLinks: removedLinkFacts(result.ssoLinksRemoved),
            });
          }

          issueSession(set, result.sessionToken);
          return redirect(set, "/dashboard");
        },
        {
          body: t.Object({
            token: t.String({ maxLength: 128 }),
            password: t.String({ maxLength: 1024 }),
            confirm: t.String({ maxLength: 1024 }),
          }),
        },
      )
  );
}
