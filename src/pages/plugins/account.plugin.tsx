import { t, type Context } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import type {
  AttemptLimiter,
  DashboardAuth,
  PasswordChangeRefusal,
  TwoFactorRefusal,
} from "../../modules/users/types/user.types.ts";
import {
  resolveClientIp,
  isLoginRateLimited,
  recordFailedLogin,
  clearLoginAttempts,
  rateLimitBucket,
} from "../../middleware/login-rate-limit.ts";
import { AccountPasswordPage } from "../routes/account-password.tsx";
import { AccountSessionsPage } from "../routes/account-sessions.tsx";
import { AccountTwoFactorPage } from "../routes/account-two-factor.tsx";
import { memberGuard } from "../guards.tsx";
import { consumeRevealSecret, stashRevealSecret } from "../reveal-store.ts";
import * as passwordChangeService from "../../modules/users/services/password-change.service.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as twoFactorService from "../../modules/users/services/two-factor.service.ts";
import {
  TWO_FACTOR_PAGE,
  twoFactorRequired,
} from "../../modules/users/services/two-factor-policy.service.ts";
import { clearSession, issueSession } from "../lib/session-helpers.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import {
  twoFactorSessionLimiter,
  type TwoFactorLimiter,
} from "../lib/two-factor-limiter.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";

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
 * Failed-attempt budget for the current password check (#279): the login
 * limiter's primitives and settings (`DASHBOARD_LOGIN_RATE_LIMIT_*`), like
 * the ownership transfer's `transferLimiter`, with keys of its own, one
 * per account and one per client IP, so neither a stolen session nor one
 * address can guess faster than a login could. The `password:` prefix
 * keeps them apart from the login and transfer keys. No-op when the
 * limiter is off.
 */
function passwordChangeLimiter(userId: string, ip: string): AttemptLimiter {
  const { enabled, maxAttempts, windowSec } = config.dashboard.loginRateLimit;
  const windowMs = windowSec * 1000;
  /** IPv6 clients by /64, like the login (#256). */
  const keys = [`password:user:${userId}`, `password:ip:${rateLimitBucket(ip)}`];
  return {
    isLimited: () =>
      enabled &&
      keys.some((key) => isLoginRateLimited(key, maxAttempts, windowMs).limited),
    record: () => {
      if (enabled) for (const key of keys) recordFailedLogin(key, windowMs);
    },
    clear: () => {
      for (const key of keys) clearLoginAttempts(key);
    },
  };
}

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

/** The client IP of a request, for the log lines (the login limiter's resolution). */
function clientIp(request: Request, socketIp: string | undefined): string {
  return resolveClientIp({
    socketIp,
    forwardedFor: request.headers.get("x-forwarded-for"),
    trustedProxyHops: config.dashboard.trustedProxyHops,
  });
}

/* ─── Two-factor helpers (#220) ─── */

/**
 * What the Two-factor page says for a refused action. A wrong code and a
 * wrong password get one message where both are asked for, so the page
 * never says which of the two was wrong.
 */
const TWO_FACTOR_REFUSAL: Record<TwoFactorRefusal, string> = {
  rate_limited: "Too many attempts. Try again later.",
  no_pending: "Start the setup again: no setup was in progress in this browser.",
  already_enabled: "Two-factor authentication is already on.",
  not_enabled: "Two-factor authentication is off.",
  wrong_code: "Invalid code. Try again.",
  wrong_password: "The password or the code is incorrect.",
};

/** Redirects to the Two-factor page with a flash banner (and a reveal token). */
function toTwoFactorPage(
  set: Context["set"],
  message: string,
  type: "success" | "error",
  reveal?: string,
): string {
  const query = `flash=${encodeURIComponent(message)}&flashType=${type}`;
  return redirect(
    set,
    `${TWO_FACTOR_PAGE}?${query}${reveal === undefined ? "" : `&reveal=${reveal}`}`,
  );
}

/**
 * Ends this session when its own two-factor budget is spent (#220): a
 * session that keeps guessing codes (or the password on the disable form)
 * is treated as stolen. Only the session's key decides, not the address
 * key, which other accounts behind the same address share. Returns the
 * redirect to the login page, or `undefined` when the budget is not spent.
 */
async function endSessionIfBudgetSpent(
  limiter: TwoFactorLimiter,
  auth: DashboardAuth,
  set: Context["set"],
  ip: string,
  action: "disable" | "recovery_codes",
): Promise<string | undefined> {
  if (!limiter.ownKeyLimited()) return undefined;
  await sessionService.revokeUserSession(auth.user.id, auth.session.id);
  logger.warn("Two-factor code budget spent in a session: session revoked", {
    userId: auth.user.id,
    sessionId: auth.session.id,
    action,
    ip,
  });
  clearSession(set);
  return redirect(set, "/dashboard/login");
}

/**
 * Emails the account about a change to its two-factor authentication
 * (#220), in the background: never awaited, never fails the action.
 */
function alertTwoFactorChange(
  event: "enabled" | "disabled" | "recovery_codes_regenerated",
  auth: DashboardAuth,
  ip: string,
): void {
  void sendTwoFactorAlert({
    event,
    userId: auth.user.id,
    email: auth.user.email,
    ip: sessionIp(ip),
  });
}

/**
 * Stashes fresh recovery codes in the one-time reveal store (#280), bound
 * to this user and session, and returns the reveal token for the
 * redirect: the codes never go into a URL, a flash or a log.
 */
function stashRecoveryCodes(codes: string[], auth: DashboardAuth): string {
  return stashRevealSecret(codes.join("\n"), "recovery_codes", revealOwnerOf(auth));
}

/**
 * The signed-in user's own account: the Change password page (#279), the
 * Active sessions page (#281) and the Two-factor page (#220). Every role,
 * the owner included.
 */
export function accountPages(app: GuardedDashboard) {
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

      /**
       * GET /dashboard/account/two-factor
       * The Two-factor page (#220): status and recovery codes left when on;
       * the QR code and key of an enrolment started in this session; the
       * recovery codes once, when `reveal` is a live token this user and
       * session stashed (#280). Never cached. Also where `REQUIRE_2FA` sends
       * an account that must enrol (the guard lets this path through).
       */
      .get(
        "/account/two-factor",
        async ({ query, auth, set }) => {
          setNoStore(set);
          const recoveryCodes = consumeRevealSecret(
            query.reveal,
            "recovery_codes",
            revealOwnerOf(auth),
          )?.split("\n");
          try {
            const status = await twoFactorService.twoFactorStatus(auth.user.id);
            const pending = status.enabled
              ? null
              : await twoFactorService.pendingEnrolment(
                  auth.user.id,
                  auth.session.id,
                  auth.user.email,
                );
            return (
              <AccountTwoFactorPage
                status={status}
                pending={pending}
                required={
                  !status.enabled &&
                  twoFactorRequired(config.dashboard.require2fa, auth.user.role)
                }
                recoveryCodes={recoveryCodes}
                flash={toFlash(query.flash, query.flashType)}
              />
            );
          } catch (error: unknown) {
            logger.error("Two-factor page failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              error: errorMessage(error),
            });
            set.status = 500;
            return (
              <AccountTwoFactorPage
                status={{ enabled: false, enabledAt: null, recoveryCodesLeft: 0 }}
                pending={null}
                required={false}
                flash={{
                  message: "Failed to load your two-factor settings.",
                  type: "error",
                }}
              />
            );
          }
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
            reveal: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/account/two-factor/start
       * Starts an enrolment (#220), only after the current password
       * (form field `password`): a stolen session cookie alone cannot turn
       * 2FA on and lock the owner out. The check uses the password change's
       * budget (`password:user:<id>`, `password:ip:<bucket>`, #279), counted
       * before the single argon2id verify. Then a new secret, encrypted and
       * kept on this session's row until confirmed (a restart or another
       * replica keeps it; logout or expiry drops it); confirming needs it,
       * so it cannot happen without a start that passed the password.
       * Starting again (password again) replaces it. The page then shows
       * the QR code and the key; nothing secret goes in the redirect.
       */
      .post(
        "/account/two-factor/start",
        async ({ body, auth, set, request, server }) => {
          const ip = clientIp(request, server?.requestIP(request)?.address);
          try {
            const result = await twoFactorService.startEnrolment(
              auth.user.id,
              auth.session.id,
              body.password,
              passwordChangeLimiter(auth.user.id, ip),
            );
            if (!result.ok) {
              logger.warn("Two-factor enrolment start refused", {
                userId: auth.user.id,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              const message =
                result.reason === "wrong_password"
                  ? "Current password is incorrect."
                  : TWO_FACTOR_REFUSAL[result.reason];
              return toTwoFactorPage(set, message, "error");
            }
            logger.info("Two-factor enrolment started", {
              userId: auth.user.id,
              sessionId: auth.session.id,
            });
            return redirect(set, TWO_FACTOR_PAGE);
          } catch (error: unknown) {
            logger.error("Two-factor enrolment start failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              error: errorMessage(error),
            });
            return toTwoFactorPage(
              set,
              "Failed to start the setup: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({ password: t.String({ maxLength: 1024 }) }),
        },
      )

      /**
       * POST /dashboard/account/two-factor/confirm
       * Confirms the enrolment with a first code (#220). On success, in one
       * transaction: the `totp` credential is stored, ten recovery codes are
       * created (hashes only), every other session of the account is signed
       * out and this one becomes `mfa`. The recovery codes are revealed once
       * on the page (one-time reveal bound to this user and session). A
       * wrong code keeps the enrolment so the user can retry.
       */
      .post(
        "/account/two-factor/confirm",
        async ({ body, auth, set, request, server }) => {
          const ip = clientIp(request, server?.requestIP(request)?.address);
          try {
            const result = await twoFactorService.confirmEnrolment(
              auth.user.id,
              auth.session.id,
              body.code,
            );
            if (!result.ok) {
              logger.warn("Two-factor enrolment refused", {
                userId: auth.user.id,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              return toTwoFactorPage(set, TWO_FACTOR_REFUSAL[result.reason], "error");
            }
            logger.warn("Two-factor authentication enabled", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              sessionsRevoked: result.sessionsRevoked,
              ip,
            });
            alertTwoFactorChange("enabled", auth, ip);
            return toTwoFactorPage(
              set,
              "Two-factor authentication is on. You were signed out on every other device.",
              "success",
              stashRecoveryCodes(result.recoveryCodes, auth),
            );
          } catch (error: unknown) {
            logger.error("Two-factor enrolment failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toTwoFactorPage(
              set,
              "Failed to turn on two-factor authentication: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({ code: t.String({ maxLength: 1024 }) }),
        },
      )

      /**
       * POST /dashboard/account/two-factor/recovery-codes
       * Replaces every recovery code with ten new ones (#220). Needs a code
       * from the authenticator app (not a recovery code), checked against
       * this session's own budget (`totp:session:<id>` and the address key,
       * never the account's login budget) before any verification; once
       * the session's budget is spent the session is revoked. The new codes
       * are revealed once, and the account is emailed.
       */
      .post(
        "/account/two-factor/recovery-codes",
        async ({ body, auth, set, request, server }) => {
          const ip = clientIp(request, server?.requestIP(request)?.address);
          const limiter = twoFactorSessionLimiter(auth.session.id, ip);
          try {
            const result = await twoFactorService.regenerateRecoveryCodes(
              auth.user.id,
              body.code,
              limiter,
            );
            if (!result.ok) {
              logger.warn("Recovery codes not regenerated", {
                userId: auth.user.id,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              const ended = await endSessionIfBudgetSpent(
                limiter,
                auth,
                set,
                ip,
                "recovery_codes",
              );
              if (ended !== undefined) return ended;
              return toTwoFactorPage(set, TWO_FACTOR_REFUSAL[result.reason], "error");
            }
            limiter.clear();
            logger.warn("Recovery codes regenerated", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
            });
            alertTwoFactorChange("recovery_codes_regenerated", auth, ip);
            return toTwoFactorPage(
              set,
              "New recovery codes created. The old ones no longer work.",
              "success",
              stashRecoveryCodes(result.recoveryCodes, auth),
            );
          } catch (error: unknown) {
            logger.error("Recovery code regeneration failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toTwoFactorPage(
              set,
              "Failed to create new recovery codes: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({ code: t.String({ maxLength: 1024 }) }),
        },
      )

      /**
       * POST /dashboard/account/two-factor/disable
       * Turns two-factor authentication off (#220). An account without 2FA
       * is answered at once, before any password work. Otherwise needs the
       * current password AND a code (from the app, or a recovery code),
       * with this session's own budget (`totp:session:<id>` and the address
       * key, never the account's login budget) checked and counted before
       * the argon2id verify; once the session's budget is spent the session
       * is revoked. The `totp` credential and its recovery codes are
       * deleted; sessions are kept; the account is emailed. Under
       * `REQUIRE_2FA` the account is then sent back to this page until it
       * enrols again.
       */
      .post(
        "/account/two-factor/disable",
        async ({ body, auth, set, request, server }) => {
          const ip = clientIp(request, server?.requestIP(request)?.address);
          const limiter = twoFactorSessionLimiter(auth.session.id, ip);
          try {
            const result = await twoFactorService.disableTwoFactor(
              auth.user.id,
              body.password,
              body.code,
              limiter,
            );
            if (!result.ok) {
              logger.warn("Two-factor disable refused", {
                userId: auth.user.id,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              const ended = await endSessionIfBudgetSpent(
                limiter,
                auth,
                set,
                ip,
                "disable",
              );
              if (ended !== undefined) return ended;
              const reason =
                result.reason === "wrong_code" ? "wrong_password" : result.reason;
              return toTwoFactorPage(set, TWO_FACTOR_REFUSAL[reason], "error");
            }
            limiter.clear();
            logger.warn("Two-factor authentication disabled", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              method: result.method,
              ip,
            });
            alertTwoFactorChange("disabled", auth, ip);
            return toTwoFactorPage(set, "Two-factor authentication is off.", "success");
          } catch (error: unknown) {
            logger.error("Two-factor disable failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toTwoFactorPage(
              set,
              "Failed to turn off two-factor authentication: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({
            password: t.String({ maxLength: 1024 }),
            code: t.String({ maxLength: 1024 }),
          }),
        },
      )

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
