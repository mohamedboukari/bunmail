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
  isLoginRateLimited,
  recordFailedLogin,
  refundLoginAttempt,
  shouldAuditLockout,
} from "../../middleware/login-rate-limit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import type { AuditLoginFailureReason } from "../../modules/audit/types/audit.types.ts";
import { LoginPage } from "../routes/login.tsx";
import { OwnerSetupPage, OwnerSetupInvalidPage } from "../routes/setup.tsx";
import {
  InviteAcceptPage,
  InviteAccountExistsPage,
  InviteInvalidPage,
} from "../routes/invite.tsx";
import { PasswordResetInvalidPage, PasswordResetPage } from "../routes/reset.tsx";
import { readSessionCookie } from "../session.ts";
import * as ownerService from "../../modules/users/services/owner.service.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as loginService from "../../modules/users/services/login.service.ts";
import * as inviteService from "../../modules/users/services/invite.service.ts";
import * as passwordResetService from "../../modules/users/services/password-reset.service.ts";
import * as twoFactorService from "../../modules/users/services/two-factor.service.ts";
import { TWO_FACTOR_LOGIN_PAGE } from "../../modules/users/services/two-factor-policy.service.ts";
import { relyingPartyFrom } from "../../modules/users/services/passkey-policy.service.ts";
import { inviteNameProblem } from "../../modules/users/services/invite-policy.service.ts";
import {
  isWellFormedSetupToken,
  setupPasswordProblem,
} from "../../modules/users/services/owner-setup-policy.service.ts";
import {
  SESSION_PENDING_SECONDS,
  loginInputTooLong,
  normalizeLoginEmail,
  sessionIp,
} from "../../modules/users/services/session-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import {
  issueSession,
  clearSession,
  SESSION_STORE_DOWN,
  revokeOnTokenReuse,
} from "../lib/session-helpers.ts";
import { redirect } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import type { PublicDashboard } from "../lib/session-guard.ts";
import { twoFactorLoginLimiter } from "../lib/two-factor-limiter.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import {
  UNKNOWN_ACCOUNT,
  completeSignIn,
  endLockedSecondStep,
  requestIp,
  secondStepPage,
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
 * Public dashboard pages (#291): login (both steps, #220), logout, owner
 * setup, invitation accept and password reset. Mounted before the session
 * guard, so none of these routes runs it; each checks same-origin and its
 * token itself.
 */
export function authPages(app: PublicDashboard) {
  return (
    app
      /**
       * GET /dashboard/login
       * Shows the email and password form, and "Sign in with a passkey"
       * when passkeys are on (#223). Gets the auth-page headers (no
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
           * Brute-force protection (#109). Lockout is checked first, then the
           * attempt is counted right away, before any await: the password
           * check (argon2id) takes tens of milliseconds, and counting only
           * after it would let a parallel burst from one IP pass the limit,
           * each request running a full hash. A successful login gives back
           * only its own count: earlier failures stay until the window ends
           * (#256).
           */
          const windowMs = loginRateLimit.windowSec * 1000;
          if (loginRateLimit.enabled) {
            const { limited, retryAfterSec } = isLoginRateLimited(
              ip,
              loginRateLimit.maxAttempts,
              windowMs,
            );
            if (limited) {
              logger.warn("Dashboard login blocked: too many attempts", {
                ip,
                retryAfterSec,
              });
              /** Once per address and window (#221): a flood records one row. */
              if (shouldAuditLockout(ip, windowMs)) {
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
            recordFailedLogin(ip, windowMs);
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
            if (loginRateLimit.enabled) refundLoginAttempt(ip, windowMs);

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

      /**
       * GET /dashboard/login/two-factor
       * The second login step (#220): the code form, for a browser holding
       * a `pending` session (the password was right, a second factor is
       * required). Auth-page headers. Anything else (no cookie, a full
       * session, an expired or revoked pending one) is sent to `/dashboard`,
       * where the session guard lets a live session in and sends everything
       * else to the login page; the cookie is not touched here.
       */
      .get("/login/two-factor", async ({ set, request }) => {
        setAuthPageHeaders(set);
        const token = readSessionCookie(request.headers.get("cookie"));
        try {
          const pending =
            token && isWellFormedToken(token)
              ? await sessionService.findPendingSession(token)
              : null;
          if (!pending) return redirect(set, "/dashboard");
          return await secondStepPage(pending.userId);
        } catch (error: unknown) {
          logger.error("Two-factor sign-in page: session lookup failed", {
            error: errorMessage(error),
          });
          set.status = 503;
          return SESSION_STORE_DOWN;
        }
      })

      /**
       * POST /dashboard/login/two-factor
       * Checks the second factor (#220): a 6-digit code from the
       * authenticator app, or a recovery code. In order: auth-page headers;
       * same-origin; the pending session (none: to `/dashboard`, cookie
       * untouched, see below); then `completeTwoFactorLogin`, which checks the
       * failed-attempt budget (`totp:user:<id>` and `totp:ip:<bucket>`) and
       * counts the attempt before any verification, and in one transaction
       * spends the code (replay-proof) and turns the session into an `mfa`
       * session with a fresh token (the pending one dies).
       *
       * A wrong, expired or reused code gets one generic message. Once the
       * budget is spent the pending session is revoked and the browser is
       * sent back to the login page. On success the budget is cleared, the
       * new cookie is set, and the post-login steps run: the location
       * lookup (#281) and the new-device check (#282), only now that the
       * sign-in is complete. A recovery code is logged at `warn` with the
       * codes left.
       */
      .post(
        "/login/two-factor",
        async ({ body, set, request, server }) => {
          setAuthPageHeaders(set);
          const ip = requestIp(request, server?.requestIP(request)?.address);

          if (!isSameOrigin(request)) {
            logger.warn(
              "Two-factor sign-in POST rejected: cross-origin (possible CSRF)",
              {
                ip,
                origin:
                  request.headers.get("origin") ?? request.headers.get("referer") ?? null,
              },
            );
            set.status = 403;
            return "Forbidden: cross-origin request rejected";
          }

          const token = readSessionCookie(request.headers.get("cookie"));
          try {
            const pending =
              token && isWellFormedToken(token)
                ? await sessionService.findPendingSession(token)
                : null;
            /**
             * No pending session: expired, revoked, or already completed by a
             * parallel submission (a double click). The cookie is left alone,
             * since it may be the fresh one that submission just set: the
             * guard behind `/dashboard` lets a live session in and sends
             * anything else to the login page.
             */
            if (!token || !pending) {
              logger.debug("Two-factor sign-in refused: no pending session", { ip });
              return redirect(set, "/dashboard");
            }

            const limiter = twoFactorLoginLimiter(pending.userId, ip);
            const audit = {
              actor: userActor(pending.userId),
              ip,
              userAgent: request.headers.get("user-agent"),
              target: { type: "session" as const, id: pending.sessionId, label: null },
            };
            const result = await twoFactorService.completeTwoFactorLogin(
              pending,
              token,
              body.code,
              limiter,
            );

            if (!result.ok) {
              if (result.reason === "session_gone") {
                logger.debug("Two-factor sign-in refused: pending session gone", {
                  userId: pending.userId,
                  sessionId: pending.sessionId,
                  ip,
                });
                return redirect(set, "/dashboard");
              }
              if (result.reason === "wrong_code") {
                logger.warn("Two-factor sign-in failed: invalid code", {
                  userId: pending.userId,
                  sessionId: pending.sessionId,
                  ip,
                });
                /** Bounded by the code budget: 5 per account per 15 minutes. */
                await recordAuditEvent({
                  ...audit,
                  action: "auth.login.failed",
                  outcome: "failure",
                  metadata: { step: "two_factor", reason: "wrong_code" },
                });
              }
              /** Budget spent (now or before): the pending session ends here. */
              if (result.reason === "rate_limited" || limiter.isLimited()) {
                return endLockedSecondStep(set, request, { token, pending, ip, limiter });
              }
              return await secondStepPage(pending.userId, "Invalid code. Try again.");
            }

            limiter.clear();
            issueSession(set, result.token, result.maxAgeSec);
            logger.info("Dashboard login successful", {
              userId: pending.userId,
              sessionId: pending.sessionId,
              method: result.method,
              ip,
            });
            if (result.method === "recovery_code") {
              logger.warn("Recovery code used", {
                userId: pending.userId,
                sessionId: pending.sessionId,
                recoveryCodesLeft: result.recoveryCodesLeft,
                ip,
              });
            }
            await recordAuditEvent({
              ...audit,
              action: "auth.login.succeeded",
              metadata:
                result.recoveryCodesLeft === null
                  ? { method: result.method }
                  : {
                      method: result.method,
                      recoveryCodesLeft: result.recoveryCodesLeft,
                    },
            });

            completeSignIn(set, request, {
              userId: pending.userId,
              email: pending.email,
              sessionId: pending.sessionId,
              ip,
            });
            return redirect(set, "/dashboard");
          } catch (error: unknown) {
            logger.error("Two-factor sign-in failed: session store error", {
              ip,
              error: errorMessage(error),
            });
            set.status = 503;
            return SESSION_STORE_DOWN;
          }
        },
        {
          /** Loose on purpose (a schema failure is 422 JSON, not a page); the service checks the shape. */
          body: t.Object({
            code: t.String({ maxLength: 1024 }),
          }),
        },
      )

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
            ip,
          });
          /** A `reset-owner` link removed the owner's second factors (#220, #223): tell the owner. */
          if (owner.twoFactorRemoved) {
            void sendTwoFactorAlert({
              event: "removed_by_reset",
              userId: owner.userId,
              email: owner.email,
              ip: sessionIp(ip),
              removed: owner.secondFactorsRemoved,
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
            sessionId: result.sessionId,
            ip,
          });
          /** The reset removed the account's second factors (#220, #223): tell the account. */
          if (result.twoFactorRemoved) {
            void sendTwoFactorAlert({
              event: "removed_by_reset",
              userId: result.userId,
              email: result.email,
              ip: sessionIp(ip),
              removed: result.secondFactorsRemoved,
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
