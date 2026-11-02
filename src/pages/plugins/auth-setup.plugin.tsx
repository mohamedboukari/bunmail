import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { redactEmail } from "../../utils/redact.ts";
import { resolveClientIp } from "../../middleware/login-rate-limit.ts";
import { OwnerSetupPage, OwnerSetupInvalidPage } from "../routes/setup.tsx";
import * as ownerService from "../../modules/users/services/owner.service.ts";
import {
  isWellFormedSetupToken,
  setupPasswordProblem,
} from "../../modules/users/services/owner-setup-policy.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";
import { issueSession } from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import { removedLinkFacts } from "../lib/sso.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { setAuthPageHeaders } from "../lib/sign-in.tsx";
import type { authLogoutPages } from "./auth-logout.plugin.tsx";

/**
 * The owner setup from the one-time link logged on first boot (#215): its
 * form and its POST. Takes the instance sign-out was registered on, so the
 * route types chain exactly as in one `authPages` chain.
 */
export function authSetupPages(app: ReturnType<typeof authLogoutPages>) {
  return (
    app
      /**
       * GET /dashboard/setup?token=...
       * Owner setup form from the one-time link logged on first boot (#215).
       * Public: the token is the authorization. Read-only, so link scanners
       * and prefetchers cannot burn it. The format is checked before any
       * database call, and every unusable link (missing, malformed, unknown,
       * expired, used, replaced) gets the same 400 page: no oracle, and the
       * token is never echoed.
       */
      .get(
        "/setup",
        async ({ query, set }) => {
          setAuthPageHeaders(set);
          const token = query.token ?? "";
          const setup = isWellFormedSetupToken(token)
            ? await ownerService.findLiveOwnerSetup(token)
            : null;
          if (!setup) {
            set.status = 400;
            return <OwnerSetupInvalidPage />;
          }
          return <OwnerSetupPage token={token} email={setup.email} />;
        },
        {
          query: t.Object({
            token: t.Optional(t.String({ maxLength: 128 })),
          }),
        },
      )

      /**
       * POST /dashboard/setup
       * Sets the owner password and spends the token (#215). The session
       * guard's CSRF check never runs for public routes, so same-origin is
       * checked here, first, before any work. Then cheap checks before
       * expensive ones: token format, an indexed lookup, the password policy
       * (a failure re-renders the form with 200, no hashing, no write), and
       * only then argon2id inside `completeOwnerSetup`.
       *
       * On success `completeOwnerSetup` has, in one transaction, deleted every
       * session of the owner and opened a new one (#216); its token is set as
       * the cookie and the browser is redirected to `/dashboard`, which also
       * drops the setup token from the address bar.
       *
       * The body schema is deliberately loose (only length caps): a schema
       * failure answers 422 JSON from the global handler, not a page, so the
       * policy is enforced in the handler instead.
       */
      .post(
        "/setup",
        async ({ body, set, request, server }) => {
          setAuthPageHeaders(set);
          const ip = resolveClientIp({
            socketIp: server?.requestIP(request)?.address,
            forwardedFor: request.headers.get("x-forwarded-for"),
            trustedProxyHops: config.dashboard.trustedProxyHops,
          });

          if (!isSameOrigin(request)) {
            logger.warn("Owner setup POST rejected: cross-origin (possible CSRF)", {
              ip,
              origin:
                request.headers.get("origin") ?? request.headers.get("referer") ?? null,
            });
            set.status = 403;
            return "Forbidden: cross-origin request rejected";
          }

          const setup = isWellFormedSetupToken(body.token)
            ? await ownerService.findLiveOwnerSetup(body.token)
            : null;
          if (!setup) {
            set.status = 400;
            return <OwnerSetupInvalidPage />;
          }

          const problem = setupPasswordProblem(body.password, body.confirm);
          if (problem) {
            return (
              <OwnerSetupPage token={body.token} email={setup.email} error={problem} />
            );
          }

          const owner = await ownerService.completeOwnerSetup(body.token, body.password, {
            ip,
            userAgent: request.headers.get("user-agent"),
          });
          if (!owner) {
            set.status = 400;
            return <OwnerSetupInvalidPage />;
          }

          logger.warn("Owner setup completed", {
            owner: redactEmail(owner.email),
            twoFactorRemoved: owner.twoFactorRemoved,
            passkeysRemoved: owner.secondFactorsRemoved.passkeys,
            ssoLinksRemoved: owner.ssoLinksRemoved.length,
            ip,
          });
          /**
           * A `reset-owner` link removed the owner's second factors (#220,
           * #223) or SSO links (#224): tell the owner.
           */
          if (owner.twoFactorRemoved || owner.ssoLinksRemoved.length > 0) {
            void sendTwoFactorAlert({
              event: "removed_by_reset",
              userId: owner.userId,
              email: owner.email,
              ip: sessionIp(ip),
              removed: owner.secondFactorsRemoved,
              removedSsoLinks: removedLinkFacts(owner.ssoLinksRemoved),
            });
          }

          issueSession(set, owner.sessionToken);
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
