import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { redactEmail } from "../../utils/redact.ts";
import { resolveClientIp } from "../../middleware/login-rate-limit.ts";
import {
  InviteAcceptPage,
  InviteAccountExistsPage,
  InviteInvalidPage,
} from "../routes/invite.tsx";
import { readSessionCookie } from "../session.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as inviteService from "../../modules/users/services/invite.service.ts";
import { inviteNameProblem } from "../../modules/users/services/invite-policy.service.ts";
import { setupPasswordProblem } from "../../modules/users/services/owner-setup-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import { issueSession, revokeOnTokenReuse } from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import { setAuthPageHeaders } from "../lib/sign-in.tsx";
import type { authSetupPages } from "./auth-setup.plugin.tsx";

/**
 * The invitation accept (#217): its form and its POST. Takes the instance
 * the owner setup was registered on, so the route types chain exactly as
 * in one `authPages` chain.
 */
export function authInvitePages(app: ReturnType<typeof authSetupPages>) {
  return (
    app
      /**
       * GET /dashboard/invite?token=...
       * Invitation accept form (#217). Public: the token is the authorization.
       * Mirrors the owner setup page: auth-page headers, read-only (link
       * scanners and prefetchers cannot burn the token), the format checked
       * before any database call, and one identical 400 page for every
       * unusable link (missing, malformed, unknown, expired, used, revoked).
       */
      .get(
        "/invite",
        async ({ query, set }) => {
          setAuthPageHeaders(set);
          const token = query.token ?? "";
          const target = isWellFormedToken(token)
            ? await inviteService.findLiveInvitation(token)
            : null;
          if (!target) {
            set.status = 400;
            return <InviteInvalidPage />;
          }
          return (
            <InviteAcceptPage token={token} email={target.email} role={target.role} />
          );
        },
        {
          query: t.Object({
            token: t.Optional(t.String({ maxLength: 128 })),
          }),
        },
      )

      /**
       * POST /dashboard/invite
       * Creates the invited account and signs it in (#217). Same order as the
       * owner setup POST: auth-page headers; same-origin first (the session
       * guard's CSRF check never runs on public routes); token format; an
       * indexed lookup; the name and password policy (a failure re-renders the
       * form with 200, no hashing, no write); only then argon2id inside
       * `acceptInvitation`, which creates the user, the credential and the
       * session in one transaction.
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
        "/invite",
        async ({ body, set, request, server }) => {
          setAuthPageHeaders(set);
          const ip = resolveClientIp({
            socketIp: server?.requestIP(request)?.address,
            forwardedFor: request.headers.get("x-forwarded-for"),
            trustedProxyHops: config.dashboard.trustedProxyHops,
          });

          if (!isSameOrigin(request)) {
            logger.warn("Invitation accept POST rejected: cross-origin (possible CSRF)", {
              ip,
              origin:
                request.headers.get("origin") ?? request.headers.get("referer") ?? null,
            });
            set.status = 403;
            return "Forbidden: cross-origin request rejected";
          }

          const target = isWellFormedToken(body.token)
            ? await inviteService.findLiveInvitation(body.token)
            : null;
          if (!target) {
            set.status = 400;
            return <InviteInvalidPage />;
          }

          const name = body.name.trim();
          const problem =
            inviteNameProblem(name) ?? setupPasswordProblem(body.password, body.confirm);
          if (problem) {
            return (
              <InviteAcceptPage
                token={body.token}
                email={target.email}
                role={target.role}
                name={name}
                error={problem}
              />
            );
          }

          const result = await inviteService.acceptInvitation(
            body.token,
            { name, password: body.password },
            { ip, userAgent: request.headers.get("user-agent") },
          );
          if (!result.ok) {
            if (result.reason === "account_exists") {
              logger.warn(
                "Invitation not accepted: an account already holds the address",
                {
                  invitationId: target.invitationId,
                  email: redactEmail(target.email),
                  ip,
                },
              );
              set.status = 409;
              return <InviteAccountExistsPage />;
            }
            set.status = 400;
            return <InviteInvalidPage />;
          }

          /**
           * Replace the browser's previous session, as login does. The account
           * already exists at this point, so a failure here is logged and the
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
                "Invitation accepted, but revoking the previous session failed",
                {
                  userId: result.userId,
                  ip,
                  error: errorMessage(error),
                },
              );
            }
          }

          logger.warn("Invitation accepted", {
            invitationId: target.invitationId,
            userId: result.userId,
            invitedBy: result.invitedBy,
            role: result.role,
            email: redactEmail(result.email),
            sessionId: result.sessionId,
            ip,
          });

          issueSession(set, result.sessionToken);
          return redirect(set, "/dashboard");
        },
        {
          body: t.Object({
            token: t.String({ maxLength: 128 }),
            name: t.String({ maxLength: 1024 }),
            password: t.String({ maxLength: 1024 }),
            confirm: t.String({ maxLength: 1024 }),
          }),
        },
      )
  );
}
