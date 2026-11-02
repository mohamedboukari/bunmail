import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import type { WindowTicket } from "../../utils/shared-store.ts";
import { UserStoreError } from "../../modules/users/errors.ts";
import {
  refundLoginAttempt,
  shouldAuditLockout,
  takeLoginAttempt,
} from "../../middleware/login-rate-limit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import type { PasskeySignInResult } from "../../modules/users/types/user.types.ts";
import * as passkeyService from "../../modules/users/services/passkey.service.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import {
  PASSKEY_CHALLENGE_TTL_SECONDS,
  parseAuthenticationResponse,
} from "../../modules/users/services/passkey-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import { readSessionCookie, readWebAuthnCookie } from "../session.ts";
import {
  SESSION_STORE_DOWN,
  clearWebAuthnCookie,
  issueSession,
  issueWebAuthnCookie,
  revokeOnTokenReuse,
} from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import type { PublicDashboard } from "../lib/session-guard.ts";
import {
  UNKNOWN_ACCOUNT,
  completeSignIn,
  requestIp,
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

/** SQLSTATE of a foreign-key violation: a passkey removed between its check and the new session. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * The passwordless passkey sign-in (#223): its options request and its
 * finish. The first group of `passkeyLoginPages` (`passkeys.plugin.tsx`).
 */
export function passkeySignInPages(app: PublicDashboard) {
  return (
    app
      /**
       * POST /dashboard/login/passkey/options
       * Starts a passwordless sign-in: discoverable-credential request
       * options (no account named, so no email is typed and nothing says
       * whether an account exists) and a challenge bound to a new `bm_wa`
       * cookie (`HttpOnly`, `SameSite=Strict`, `Secure` in production,
       * `Path=/dashboard`, 5 minutes). Each start counts one attempt
       * against the client's login budget (the password login's limiter,
       * #109), checked first: over budget is 429. A successful sign-in
       * gives that attempt back.
       */
      .post("/login/passkey/options", async ({ set, request, server }) => {
        setAuthPageHeaders(set);
        const ip = requestIp(request, server?.requestIP(request)?.address);
        if (!isSameOrigin(request)) {
          crossOrigin(set, request, ip, "Passkey sign-in options POST");
          return { error: "Forbidden: cross-origin request rejected" };
        }
        const rp = currentRelyingParty();
        if (!rp) return refuseOptions(set, 404, { error: PASSKEYS_OFF });

        const { loginRateLimit } = config.dashboard;
        /** The window this attempt was counted in, kept with the challenge (#185). */
        let loginTicket: WindowTicket | undefined;
        if (loginRateLimit.enabled) {
          /** Checked and counted in one atomic step, like the password login. */
          const { limited, retryAfterSec, ticket } = await takeLoginAttempt(
            [ip],
            loginRateLimit.maxAttempts,
            loginRateLimit.windowSec * 1000,
          );
          loginTicket = ticket;
          if (limited) {
            logger.warn("Passkey sign-in blocked: too many attempts", {
              ip,
              retryAfterSec,
            });
            if (await shouldAuditLockout(ip)) {
              await recordAuditEvent({
                action: "auth.login.rate_limited",
                outcome: "failure",
                actor: UNKNOWN_ACCOUNT,
                ip,
                userAgent: request.headers.get("user-agent"),
                metadata: { retryAfterSec },
              });
            }
            set.headers["retry-after"] = String(retryAfterSec);
            const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
            return refuseOptions(set, 429, {
              error: `Too many failed attempts. Try again in ${minutes} minute(s).`,
            });
          }
        }

        const { binding, options } = await passkeyService.startPasskeySignIn(
          rp,
          loginTicket,
        );
        issueWebAuthnCookie(set, binding, PASSKEY_CHALLENGE_TTL_SECONDS);
        logger.debug("Passkey sign-in started", { ip });
        return { options };
      })

      /**
       * POST /dashboard/login/passkey
       * Finishes a passwordless sign-in with the browser's assertion
       * (form field `credential`, JSON). In order: auth-page headers;
       * same-origin; the `bm_wa` challenge (taken, so spent, whatever
       * follows; the cookie is cleared); then `completePasskeySignIn`:
       * the passkey by its id, the exact origin and RP ID, user
       * verification, the signature, the owner's user handle and a
       * growing signature counter; a deactivated account is refused.
       *
       * Every failure gets one generic message (`?error=passkey`) and is
       * logged at `warn` with the IP; an unknown passkey id never says
       * whether an account exists. A counter regression also emails the
       * account (it was recorded in the audit log by the service).
       *
       * On success, as after a password: the browser's previous session
       * is replaced (a superseded token is treated as reuse), an `mfa`
       * session bound to the passkey is opened (it satisfies
       * `REQUIRE_2FA`), the attempt is given back to the login budget, and
       * the location lookup and the new-device check run.
       */
      .post(
        "/login/passkey",
        async ({ body, set, request, server }) => {
          setAuthPageHeaders(set);
          const ip = requestIp(request, server?.requestIP(request)?.address);
          if (!isSameOrigin(request)) {
            return crossOrigin(set, request, ip, "Passkey sign-in POST");
          }
          const client = { ip, userAgent: request.headers.get("user-agent") };
          const binding = readWebAuthnCookie(request.headers.get("cookie"));
          clearWebAuthnCookie(set);
          const rp = currentRelyingParty();

          try {
            const result: PasskeySignInResult =
              rp && binding && isWellFormedToken(binding)
                ? await passkeyService.completePasskeySignIn(
                    binding,
                    parseAuthenticationResponse(body.credential),
                    rp,
                    client,
                  )
                : { ok: false, reason: "no_challenge" };

            if (!result.ok) {
              logger.warn("Passkey sign-in failed", {
                ip,
                reason: result.reason,
                ...(result.userId ? { userId: result.userId } : {}),
              });
              await recordAuditEvent({
                action: "auth.login.failed",
                outcome: "failure",
                actor: result.userId ? userActor(result.userId) : UNKNOWN_ACCOUNT,
                ...client,
                metadata: { step: "passkey", reason: auditReason(result.reason) },
              });
              if (result.reason === "counter_regressed") {
                reportCounterRegression(result.passkey, ip);
              }
              return redirect(set, "/dashboard/login?error=passkey");
            }

            /** Replace the browser's previous session, as the password login does. */
            const presented = readSessionCookie(request.headers.get("cookie"));
            if (presented && isWellFormedToken(presented)) {
              const revoked = await sessionService.revokeSessionByToken(presented);
              if (!revoked) {
                const superseded =
                  await sessionService.findSessionBySupersededToken(presented);
                if (superseded) {
                  await revokeOnTokenReuse(superseded, ip, client.userAgent);
                }
              }
            }

            let session: { sessionId: string; token: string };
            try {
              session = await passkeyService.openPasskeySession(
                result.userId,
                result.credentialId,
                client,
              );
            } catch (error: unknown) {
              if (
                error instanceof UserStoreError &&
                error.sqlState === FOREIGN_KEY_VIOLATION
              ) {
                logger.warn("Passkey sign-in failed", {
                  ip,
                  reason: "passkey_removed",
                  userId: result.userId,
                });
                await recordAuditEvent({
                  action: "auth.login.failed",
                  outcome: "failure",
                  actor: userActor(result.userId),
                  ...client,
                  metadata: { step: "passkey", reason: "credential_replaced" },
                });
                return redirect(set, "/dashboard/login?error=passkey");
              }
              throw error;
            }

            const { loginRateLimit } = config.dashboard;
            if (loginRateLimit.enabled && result.loginTicket) {
              await refundLoginAttempt(ip, result.loginTicket);
            }
            logger.info("Dashboard login successful", {
              userId: result.userId,
              sessionId: session.sessionId,
              method: "passkey",
              passkeyId: result.credentialId,
              ip,
            });
            await recordAuditEvent({
              action: "auth.login.succeeded",
              actor: userActor(result.userId),
              ...client,
              target: { type: "session", id: session.sessionId, label: null },
              metadata: { method: "passkey" },
            });
            issueSession(set, session.token);
            clearWebAuthnCookie(set);
            completeSignIn(set, request, {
              userId: result.userId,
              email: result.email,
              sessionId: session.sessionId,
              ip,
            });
            return redirect(set, "/dashboard");
          } catch (error: unknown) {
            logger.error("Passkey sign-in failed: session store error", {
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
