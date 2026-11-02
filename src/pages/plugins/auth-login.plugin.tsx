import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import type {
  CreatedSession,
  LoginFailureReason,
} from "../../modules/users/types/user.types.ts";
import { redactEmail } from "../../utils/redact.ts";
import { UserStoreError } from "../../modules/users/errors.ts";
import {
  resolveClientIp,
  refundLoginAttempt,
  shouldAuditLockout,
  takeLoginAttempt,
} from "../../middleware/login-rate-limit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import type { AuditLoginFailureReason } from "../../modules/audit/types/audit.types.ts";
import { LoginPage } from "../routes/login.tsx";
import { readSessionCookie } from "../session.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as loginService from "../../modules/users/services/login.service.ts";
import { TWO_FACTOR_LOGIN_PAGE } from "../../modules/users/services/two-factor-policy.service.ts";
import { relyingPartyFrom } from "../../modules/users/services/passkey-policy.service.ts";
import {
  SESSION_PENDING_SECONDS,
  loginInputTooLong,
  normalizeLoginEmail,
} from "../../modules/users/services/session-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import {
  issueSession,
  SESSION_STORE_DOWN,
  revokeOnTokenReuse,
} from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import type { PublicDashboard } from "../lib/session-guard.ts";
import type { WindowTicket } from "../../utils/shared-store.ts";
import { ssoSignInButtons } from "../lib/sso.ts";
import {
  UNKNOWN_ACCOUNT,
  completeSignIn,
  setAuthPageHeaders,
  userActor,
} from "../lib/sign-in.tsx";

/**
 * SQLSTATE of a foreign-key violation: a login's session insert naming a
 * credential that a password reset replaced meanwhile (#277).
 */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * What the login page says for each `?error=` value; anything else shows
 * nothing. A `Map`, so a query value such as `constructor` finds nothing.
 */
const LOGIN_ERRORS = new Map<string, string>([
  ["invalid", "Invalid email or password."],
  /** Too many wrong second-factor codes: the pending session was revoked (#220). */
  [
    "two_factor_locked",
    "Too many invalid codes. Wait a few minutes, then sign in again.",
  ],
  /** A passwordless passkey sign-in failed (#223): one message for every reason. */
  ["passkey", "That passkey could not sign you in. Try again, or use your password."],
  /**
   * An SSO sign-in or link callback that did not complete (#224): one
   * message for every reason but the two below (a disabled account and the
   * owner without a second factor included, so neither is told apart).
   */
  ["sso", "Single sign-on did not complete. Try again, or sign in with your password."],
  /** A proven SSO identity that no account is linked to (#224). */
  [
    "sso_unlinked",
    "This sign-in is not linked to a BunMail account. Sign in with your password and link it under Account.",
  ],
  /** The provider's discovery failed when an SSO sign-in started (#224). */
  ["sso_unavailable", "The sign-in provider could not be reached. Try again later."],
  /** An SSO callback over the per-IP login budget (#224). */
  ["rate_limited", "Too many attempts. Try again later."],
]);

/**
 * How a failed password step is recorded in the audit log (#221). The
 * reasons are never shown to the client, only to admins on that page.
 */
const LOGIN_FAILURE_AUDIT: Record<LoginFailureReason, AuditLoginFailureReason> = {
  unknown: "unknown_account",
  no_password: "no_password",
  disabled: "deactivated",
  bad_password: "wrong_password",
};

/**
 * The password login (#216): its form and its POST. The first public
 * group of `authPages` (`auth.plugin.tsx`).
 */
export function authLoginPages(app: PublicDashboard) {
  return (
    app
      /**
       * GET /dashboard/login
       * Shows the email and password form, "Sign in with a passkey" when
       * passkeys are on (#223), and one "Sign in with <label>" button per
       * SSO provider while SSO is on (#224). Gets the auth-page headers (no
       * caching, no framing). The error text is the same for every failed
       * login, so it never says whether an account exists.
       */
      .get(
        "/login",
        ({ query, set }) => {
          setAuthPageHeaders(set);
          const error =
            query.error === undefined ? undefined : LOGIN_ERRORS.get(query.error);
          return (
            <LoginPage
              error={error}
              passkey={relyingPartyFrom(config.appBaseUrl) !== null}
              sso={ssoSignInButtons()}
            />
          );
        },
        {
          query: t.Object({
            error: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/login
       * Email and password login (#216). In order: auth-page headers; a
       * same-origin check (blocks login CSRF, which would sign a victim into
       * the attacker's account); the per-IP limiter (#109), before any
       * database or argon2id work; the input bounds; then exactly one argon2id
       * verify on every branch (`verifyPasswordLogin`).
       *
       * Every failure (unknown email, no password, disabled account, wrong
       * password, over-long input) counts against the IP and gets the same
       * redirect to `?error=invalid`; the reason only reaches the server log.
       * The email never goes in the URL.
       *
       * On success a fresh session is opened (a session the browser already
       * presented is revoked first, so sessions do not stack and a planted
       * cookie cannot survive login) and the browser is sent to the fixed
       * `/dashboard`: no `next` parameter, no open redirect. The session is
       * bound to the verified credential (#277): a password reset that
       * replaced it meanwhile makes this a failed login. The IP's failures are
       * cleared only once the session exists. A successful login also sets
       * the `bm_device` cookie and starts the new-device check (#282) in the
       * background; only this route does (owner setup, invitation accept,
       * password reset and password change are link or credential flows
       * the user just performed).
       *
       * Two-factor (#220): for an account with a TOTP second factor the
       * session is opened `pending` instead (10 minutes, opens nothing but
       * the second step), and the browser goes to `/dashboard/login/two-factor`;
       * the location lookup, the new-device check and the device cookie wait
       * for the second step.
       *
       * The body schema is deliberately loose (only generous length caps): a
       * schema failure answers 422 JSON from the global handler, not a page,
       * so the real bounds are checked in the handler.
       */
      .post(
        "/login",
        async ({ body, set, request, server }) => {
          setAuthPageHeaders(set);
          const { loginRateLimit, trustedProxyHops } = config.dashboard;
          const ip = resolveClientIp({
            socketIp: server?.requestIP(request)?.address,
            forwardedFor: request.headers.get("x-forwarded-for"),
            trustedProxyHops,
          });

          if (!isSameOrigin(request)) {
            logger.warn("Dashboard login POST rejected: cross-origin (possible CSRF)", {
              ip,
              origin:
                request.headers.get("origin") ?? request.headers.get("referer") ?? null,
            });
            set.status = 403;
            return "Forbidden: cross-origin request rejected";
          }

          /**
           * Brute-force protection (#109). Lockout is checked and the attempt
           * counted in one atomic step (#185), before the password check:
           * argon2id takes tens of milliseconds, and counting only after it
           * would let a parallel burst from one IP (on any replica) pass the
           * limit, each request running a full hash. A successful login
           * gives back only its own count: earlier failures stay until the
           * window ends (#256).
           */
          /** The window this attempt was counted in, for the refund on success. */
          let attemptTicket: WindowTicket = new Map();
          if (loginRateLimit.enabled) {
            const { limited, retryAfterSec, ticket } = await takeLoginAttempt(
              [ip],
              loginRateLimit.maxAttempts,
              loginRateLimit.windowSec * 1000,
            );
            attemptTicket = ticket;
            if (limited) {
              logger.warn("Dashboard login blocked: too many attempts", {
                ip,
                retryAfterSec,
              });
              /** Once per address and window (#221): a flood records one row. */
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
              set.status = 429;
              set.headers["retry-after"] = String(retryAfterSec);
              const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
              return (
                <LoginPage
                  error={`Too many failed attempts. Try again in ${minutes} minute(s).`}
                  disabled={true}
                />
              );
            }
          }

          const email = normalizeLoginEmail(body.email);
          const tooLong = loginInputTooLong(email, body.password);
          const client = { ip, userAgent: request.headers.get("user-agent") };

          try {
            const result = tooLong
              ? null
              : await loginService.verifyPasswordLogin(email, body.password);

            if (!result?.ok) {
              /** Already counted before the password check. */
              logger.warn("Dashboard login failed", {
                ip,
                reason: result ? result.reason : "too_long",
                ...(result ? { email: redactEmail(email) } : {}),
              });
              /** An unknown email is recorded without it (#221). */
              await recordAuditEvent({
                action: "auth.login.failed",
                outcome: "failure",
                actor: result?.userId ? userActor(result.userId) : UNKNOWN_ACCOUNT,
                ...client,
                metadata: {
                  step: "password",
                  reason: result ? LOGIN_FAILURE_AUDIT[result.reason] : "input_too_long",
                },
              });
              return redirect(set, "/dashboard/login?error=invalid");
            }

            /**
             * Replace the browser's previous session. A token the session had
             * already rotated away from means a copy is in other hands (for
             * example a victim signing in again while a thief keeps the stolen
             * session alive): treat it as reuse and revoke every session of
             * that user before opening the new one.
             */
            const presented = readSessionCookie(request.headers.get("cookie"));
            if (presented && isWellFormedToken(presented)) {
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
            }

            /**
             * The session is bound to the credential just verified (#277). If a
             * password reset replaced it in the meantime, the insert fails with
             * a foreign-key violation: the old password no longer opens
             * anything, so this is a failed login (already counted), not a 503.
             */
            let created: CreatedSession;
            try {
              created = await sessionService.createSession({
                userId: result.userId,
                assurance: result.assurance,
                authMethod: "password",
                credentialId: result.credentialId,
                ip,
                userAgent: request.headers.get("user-agent"),
              });
            } catch (error: unknown) {
              if (
                error instanceof UserStoreError &&
                error.sqlState === FOREIGN_KEY_VIOLATION
              ) {
                logger.warn("Dashboard login failed", {
                  ip,
                  reason: "credential_replaced",
                  userId: result.userId,
                });
                await recordAuditEvent({
                  action: "auth.login.failed",
                  outcome: "failure",
                  actor: userActor(result.userId),
                  ...client,
                  metadata: { step: "password", reason: "credential_replaced" },
                });
                return redirect(set, "/dashboard/login?error=invalid");
              }
              throw error;
            }
            const { sessionId, token } = created;

            /**
             * Success: give back this request's own count. Earlier failures from
             * this address stay (#256), or anyone could sign in to their own
             * account between guesses at someone else's password.
             */
            if (loginRateLimit.enabled) await refundLoginAttempt(ip, attemptTicket);

            /** Second factor required (#220): only the second step opens this session. */
            if (result.assurance === "pending") {
              logger.info("Dashboard login: password accepted, second factor required", {
                userId: result.userId,
                sessionId,
                ip,
              });
              await recordAuditEvent({
                action: "auth.login.two_factor_required",
                actor: userActor(result.userId),
                ...client,
                target: { type: "session", id: sessionId, label: null },
                metadata: { method: "password" },
              });
              issueSession(set, token, SESSION_PENDING_SECONDS);
              return redirect(set, TWO_FACTOR_LOGIN_PAGE);
            }

            logger.info("Dashboard login successful", {
              userId: result.userId,
              sessionId,
              ip,
            });
            await recordAuditEvent({
              action: "auth.login.succeeded",
              actor: userActor(result.userId),
              ...client,
              target: { type: "session", id: sessionId, label: null },
              metadata: { method: "password" },
            });

            /** Location (#281) and the new-device alert (#282), in the background. */
            issueSession(set, token);
            completeSignIn(set, request, {
              userId: result.userId,
              email,
              sessionId,
              ip,
            });
            return redirect(set, "/dashboard");
          } catch (error: unknown) {
            logger.error("Dashboard login failed: session store error", {
              ip,
              error: errorMessage(error),
            });
            set.status = 503;
            return SESSION_STORE_DOWN;
          }
        },
        {
          body: t.Object({
            email: t.String({ maxLength: 320 }),
            password: t.String({ maxLength: 1024 }),
          }),
        },
      )
  );
}
