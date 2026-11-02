import { logger } from "../../utils/logger.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import * as passkeyService from "../../modules/users/services/passkey.service.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import { parseAuthenticationResponse } from "../../modules/users/services/passkey-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import { readSessionCookie } from "../session.ts";
import { SESSION_STORE_DOWN, issueSession } from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import { ssoProviderLabelOf } from "../lib/sso.ts";
import { twoFactorLoginLimiter } from "../lib/two-factor-limiter.ts";
import {
  completeSignIn,
  endLockedSecondStep,
  requestIp,
  secondStepPage,
  setAuthPageHeaders,
  userActor,
} from "../lib/sign-in.tsx";
import {
  FINISH_BODY,
  PASSKEYS_OFF,
  auditReason,
  crossOrigin,
  currentRelyingParty,
  refuseOptions,
  reportCounterRegression,
} from "../lib/passkeys.ts";
import type { passkeySignInPages } from "./passkey-sign-in.plugin.tsx";

/**
 * The second login step with a passkey (#223): its options request and
 * its finish. Takes the instance the passwordless sign-in was registered
 * on, so the route types chain exactly as in one `passkeyLoginPages` chain.
 */
export function passkeySecondStepPages(app: ReturnType<typeof passkeySignInPages>) {
  return (
    app
      /**
       * POST /dashboard/login/two-factor/passkey/options
       * Request options for the second login step with a passkey: the
       * account's passkeys allowed, user verification required, and a
       * challenge bound to the `pending` session. No pending session:
       * JSON telling the browser to go to `/dashboard` (the guard there
       * sorts it out). Issuing options checks nothing an attacker could
       * guess, so it costs no budget; the finish does.
       */
      .post("/login/two-factor/passkey/options", async ({ set, request, server }) => {
        setAuthPageHeaders(set);
        const ip = requestIp(request, server?.requestIP(request)?.address);
        if (!isSameOrigin(request)) {
          crossOrigin(set, request, ip, "Two-factor passkey options POST");
          return { error: "Forbidden: cross-origin request rejected" };
        }
        const rp = currentRelyingParty();
        if (!rp) return refuseOptions(set, 404, { error: PASSKEYS_OFF });
        const token = readSessionCookie(request.headers.get("cookie"));
        try {
          const pending =
            token && isWellFormedToken(token)
              ? await sessionService.findPendingSession(token)
              : null;
          if (!pending) {
            logger.debug("Two-factor passkey options refused: no pending session", {
              ip,
            });
            return refuseOptions(set, 401, {
              error: "Your sign-in expired. Sign in again.",
              redirect: "/dashboard",
            });
          }
          const options = await passkeyService.startPasskeyTwoFactor(pending, rp);
          if (!options) {
            return refuseOptions(set, 400, { error: "This account has no passkey." });
          }
          return { options };
        } catch (error: unknown) {
          logger.error("Two-factor passkey options failed: session store error", {
            ip,
            error: errorMessage(error),
          });
          return refuseOptions(set, 503, { error: SESSION_STORE_DOWN });
        }
      })

      /**
       * POST /dashboard/login/two-factor/passkey
       * The second login step with a passkey (#223): completes a `pending`
       * session exactly like a valid TOTP code (#220). In order: auth-page
       * headers; same-origin; the pending session (none: to `/dashboard`,
       * cookie untouched); then `completePasskeyTwoFactor`, which checks
       * and counts the second-factor budget (`totp:user:<id>` and
       * `totp:ip:<bucket>`, shared with the codes) before anything else,
       * spends this session's challenge, and in one transaction verifies
       * the assertion against the account's own passkeys and turns the
       * session into an `mfa` session with a fresh token.
       *
       * A refused assertion gets one generic message; once the budget is
       * spent the pending session is revoked, as for wrong codes. On
       * success the budget is cleared, the new cookie set, and the
       * location lookup and the new-device check run.
       */
      .post(
        "/login/two-factor/passkey",
        async ({ body, set, request, server }) => {
          setAuthPageHeaders(set);
          const ip = requestIp(request, server?.requestIP(request)?.address);
          if (!isSameOrigin(request)) {
            return crossOrigin(set, request, ip, "Two-factor passkey POST");
          }
          const token = readSessionCookie(request.headers.get("cookie"));
          try {
            const pending =
              token && isWellFormedToken(token)
                ? await sessionService.findPendingSession(token)
                : null;
            if (!token || !pending) {
              logger.debug("Two-factor passkey refused: no pending session", { ip });
              return redirect(set, "/dashboard");
            }
            const rp = currentRelyingParty();
            if (!rp) {
              return await secondStepPage(pending.userId, PASSKEYS_OFF);
            }

            const limiter = twoFactorLoginLimiter(pending.userId, ip);
            const client = { ip, userAgent: request.headers.get("user-agent") };
            const audit = {
              actor: userActor(pending.userId),
              ...client,
              target: { type: "session" as const, id: pending.sessionId, label: null },
            };
            const result = await passkeyService.completePasskeyTwoFactor(
              pending,
              token,
              parseAuthenticationResponse(body.credential),
              limiter,
              rp,
              client,
            );

            if (!result.ok) {
              if (result.reason === "session_gone") {
                logger.debug("Two-factor passkey refused: pending session gone", {
                  userId: pending.userId,
                  sessionId: pending.sessionId,
                  ip,
                });
                return redirect(set, "/dashboard");
              }
              if (result.reason !== "rate_limited") {
                logger.warn("Two-factor sign-in failed: passkey not accepted", {
                  userId: pending.userId,
                  sessionId: pending.sessionId,
                  reason: result.reason,
                  ip,
                });
                await recordAuditEvent({
                  ...audit,
                  action: "auth.login.failed",
                  outcome: "failure",
                  metadata: { step: "two_factor", reason: auditReason(result.reason) },
                });
                if (result.reason === "counter_regressed") {
                  reportCounterRegression(result.passkey, ip);
                }
              }
              if (result.reason === "rate_limited" || (await limiter.isLimited())) {
                return await endLockedSecondStep(set, request, {
                  token,
                  pending,
                  ip,
                  limiter,
                });
              }
              return await secondStepPage(
                pending.userId,
                "That passkey was not accepted. Try again.",
              );
            }

            await limiter.clear();
            issueSession(set, result.token, result.maxAgeSec);
            logger.info("Dashboard login successful", {
              userId: pending.userId,
              sessionId: pending.sessionId,
              method: "passkey",
              passkeyId: result.credentialId,
              ip,
            });
            await recordAuditEvent({
              ...audit,
              action: "auth.login.succeeded",
              metadata: { method: "passkey" },
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
            logger.error("Two-factor passkey sign-in failed: session store error", {
              ip,
              error: errorMessage(error),
            });
            set.status = 503;
            return SESSION_STORE_DOWN;
          }
        },
        { body: FINISH_BODY },
      )
  );
}
