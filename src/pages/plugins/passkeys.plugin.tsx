import { t, type Context } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { UserStoreError } from "../../modules/users/errors.ts";
import {
  isLoginRateLimited,
  recordFailedLogin,
  refundLoginAttempt,
  shouldAuditLockout,
} from "../../middleware/login-rate-limit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import type { AuditLoginFailureReason } from "../../modules/audit/types/audit.types.ts";
import type {
  DashboardAuth,
  PasskeyRefusal,
  PasskeySignInResult,
  RelyingParty,
} from "../../modules/users/types/user.types.ts";
import * as passkeyService from "../../modules/users/services/passkey.service.ts";
import * as sessionService from "../../modules/users/services/session.service.ts";
import * as twoFactorService from "../../modules/users/services/two-factor.service.ts";
import {
  PASSKEY_CHALLENGE_TTL_SECONDS,
  PASSKEY_RESPONSE_MAX_LENGTH,
  parseAuthenticationResponse,
  parseRegistrationResponse,
  relyingPartyFrom,
} from "../../modules/users/services/passkey-policy.service.ts";
import {
  PASSKEYS_PAGE,
  twoFactorRequired,
} from "../../modules/users/services/two-factor-policy.service.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";
import { isWellFormedToken } from "../../modules/users/services/token.service.ts";
import { AccountPasskeysPage } from "../routes/account-passkeys.tsx";
import { memberGuard } from "../guards.tsx";
import { readSessionCookie, readWebAuthnCookie } from "../session.ts";
import {
  SESSION_STORE_DOWN,
  clearWebAuthnCookie,
  issueSession,
  issueWebAuthnCookie,
  revokeOnTokenReuse,
} from "../lib/session-helpers.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { isSameOrigin } from "../lib/same-origin.ts";
import { dashboardClient } from "../lib/audit.ts";
import { passwordChangeLimiter } from "../lib/password-limiter.ts";
import type { GuardedDashboard, PublicDashboard } from "../lib/session-guard.ts";
import { twoFactorLoginLimiter } from "../lib/two-factor-limiter.ts";
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
 * Passkeys (WebAuthn, #223) in the dashboard: the passwordless sign-in
 * and the second login step (public, before the session guard), and the
 * Passkeys page with its actions (after it). The ceremonies themselves run
 * in the browser (`dashboard.js`); each one is an options request (a
 * same-origin `fetch` POST answering JSON) and a finish form (a normal
 * POST answering a redirect).
 *
 * Every route works only when `APP_BASE_URL` gives a relying party
 * (`relyingPartyFrom`); otherwise passkeys are off and the routes say so.
 */

/** SQLSTATE of a foreign-key violation: a passkey removed between its check and the new session. */
const FOREIGN_KEY_VIOLATION = "23503";

/** The JSON answer of an options request that cannot go on. */
interface OptionsRefusal {
  error: string;
  /** Where the browser should go instead (the pending session is gone). */
  redirect?: string;
}

/** What the browser is told when passkeys are off. */
const PASSKEYS_OFF = "Passkeys are switched off on this server.";

/** The relying party now: `APP_BASE_URL` is read on every request (tests change it). */
function currentRelyingParty(): RelyingParty | null {
  return relyingPartyFrom(config.appBaseUrl);
}

/** Answers an options request with an error status and JSON. */
function refuseOptions(
  set: Context["set"],
  status: number,
  body: OptionsRefusal,
): OptionsRefusal {
  set.status = status;
  return body;
}

/** The cross-origin refusal every POST here gives, logged at `warn`. */
function crossOrigin(
  set: Context["set"],
  request: Request,
  ip: string,
  what: string,
): string {
  logger.warn(`${what} rejected: cross-origin (possible CSRF)`, {
    ip,
    origin: request.headers.get("origin") ?? request.headers.get("referer") ?? null,
  });
  set.status = 403;
  return "Forbidden: cross-origin request rejected";
}

/** How a refused passkey sign-in step is recorded in the audit log (#221). */
function auditReason(reason: PasskeyRefusal): AuditLoginFailureReason {
  if (reason === "unknown_credential") return "unknown_passkey";
  if (reason === "counter_regressed") return "passkey_counter_regressed";
  if (reason === "account_disabled") return "deactivated";
  return "passkey_rejected";
}

/**
 * A possible cloned authenticator (#223): the assertion was refused and
 * recorded by the service; here it is logged and the account emailed, in
 * the background.
 */
function reportCounterRegression(
  passkey: { id: string; name: string; userId: string; email: string } | undefined,
  ip: string,
): void {
  if (!passkey) return;
  logger.warn("Passkey refused: signature counter did not increase (possible clone)", {
    userId: passkey.userId,
    passkeyId: passkey.id,
    ip,
  });
  if (passkey.email === "") return;
  void sendTwoFactorAlert({
    event: "passkey_counter_regressed",
    userId: passkey.userId,
    email: passkey.email,
    ip: sessionIp(ip),
    passkeyName: passkey.name,
  });
}

/** The credential field of a finish form: loose on purpose (the parser checks the shape). */
const FINISH_BODY = t.Object({
  credential: t.String({ maxLength: PASSKEY_RESPONSE_MAX_LENGTH }),
});

/**
 * Public passkey routes (#223): the passwordless sign-in and the passkey
 * second login step. Mounted before the session guard; each checks
 * same-origin itself and is authorized by what it binds to (the `bm_wa`
 * cookie, the `pending` session).
 */
export function passkeyLoginPages(app: PublicDashboard) {
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
        const windowMs = loginRateLimit.windowSec * 1000;
        if (loginRateLimit.enabled) {
          const { limited, retryAfterSec } = isLoginRateLimited(
            ip,
            loginRateLimit.maxAttempts,
            windowMs,
          );
          if (limited) {
            logger.warn("Passkey sign-in blocked: too many attempts", {
              ip,
              retryAfterSec,
            });
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
            set.headers["retry-after"] = String(retryAfterSec);
            const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
            return refuseOptions(set, 429, {
              error: `Too many failed attempts. Try again in ${minutes} minute(s).`,
            });
          }
          recordFailedLogin(ip, windowMs);
        }

        const { binding, options } = await passkeyService.startPasskeySignIn(rp);
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
            if (loginRateLimit.enabled) {
              refundLoginAttempt(ip, loginRateLimit.windowSec * 1000);
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
              if (result.reason === "rate_limited" || limiter.isLimited()) {
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

            limiter.clear();
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

/* ─── Account: the Passkeys page ─── */

/** Redirects to the Passkeys page with a flash banner. */
function toPasskeysPage(
  set: Context["set"],
  message: string,
  type: "success" | "error",
): string {
  return redirect(
    set,
    `${PASSKEYS_PAGE}?flash=${encodeURIComponent(message)}&flashType=${type}`,
  );
}

/** What the Passkeys page says for a refused action. */
const ACCOUNT_REFUSAL: Partial<Record<PasskeyRefusal, string>> = {
  rate_limited: "Too many attempts. Try again later.",
  wrong_password: "Current password is incorrect.",
  no_challenge: "The passkey setup expired or was already used. Start again.",
  rejected: "The passkey could not be verified. Start again.",
  already_registered: "That passkey is already registered.",
  not_found: "That passkey was not found: nothing was changed.",
};

/** The account's own passkey change, emailed in the background (never awaited). */
function alertPasskeyChange(
  event: "passkey_added" | "passkey_removed",
  auth: DashboardAuth,
  ip: string,
  name: string,
): void {
  void sendTwoFactorAlert({
    event,
    userId: auth.user.id,
    email: auth.user.email,
    ip: sessionIp(ip),
    passkeyName: name,
  });
}

/**
 * The signed-in user's passkeys (#223): every role manages its own, like
 * the Two-factor page (#220), so every route is `memberGuard` and scoped
 * to `auth.user.id` in the service. The session guard has already refused
 * a cross-origin POST.
 */
export function passkeyAccountPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/account/passkeys
       * The Passkeys page: the user's passkeys (name, added, last used),
       * rename and remove forms, and the add form. Never cached. Also
       * reachable under `REQUIRE_2FA` before enrolling (a passkey is a
       * second factor).
       */
      .get(
        "/account/passkeys",
        async ({ query, auth, set }) => {
          setNoStore(set);
          try {
            const [passkeys, factors] = await Promise.all([
              passkeyService.listPasskeys(auth.user.id),
              twoFactorService.secondFactorsOf(auth.user.id),
            ]);
            return (
              <AccountPasskeysPage
                passkeys={passkeys}
                enabled={currentRelyingParty() !== null}
                required={
                  !factors.totp &&
                  factors.passkeys === 0 &&
                  twoFactorRequired(config.dashboard.require2fa, auth.user.role)
                }
                flash={toFlash(query.flash, query.flashType)}
              />
            );
          } catch (error: unknown) {
            logger.error("Passkeys page failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              error: errorMessage(error),
            });
            set.status = 500;
            return (
              <AccountPasskeysPage
                passkeys={[]}
                enabled={false}
                required={false}
                flash={{ message: "Failed to load your passkeys.", type: "error" }}
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
       * POST /dashboard/account/passkeys/options
       * Starts adding a passkey (JSON answer, for `dashboard.js`): the name
       * (1 to 64 characters) and the current password (form fields `name`,
       * `password`), checked under the password change's budget
       * (`password:user:<id>`, `password:ip:<bucket>`, #279) before the
       * single argon2id verify, as starting a TOTP enrolment does (#220).
       * Then creation options, the account's passkeys excluded, and a
       * challenge bound to this session.
       */
      .post(
        "/account/passkeys/options",
        async ({ body, auth, set, request, server }) => {
          setNoStore(set);
          const ip = requestIp(request, server?.requestIP(request)?.address);
          const rp = currentRelyingParty();
          if (!rp) return refuseOptions(set, 404, { error: PASSKEYS_OFF });
          try {
            const result = await passkeyService.startRegistration(
              {
                userId: auth.user.id,
                email: auth.user.email,
                sessionId: auth.session.id,
                password: body.password,
                name: body.name.trim(),
              },
              passwordChangeLimiter(auth.user.id, ip),
              rp,
            );
            if (!result.ok) {
              logger.warn("Passkey registration start refused", {
                userId: auth.user.id,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              if (result.reason === "invalid_name") {
                return refuseOptions(set, 400, { error: result.problem });
              }
              return refuseOptions(set, result.reason === "rate_limited" ? 429 : 400, {
                error: ACCOUNT_REFUSAL[result.reason] ?? "Nothing was changed.",
              });
            }
            logger.info("Passkey registration started", {
              userId: auth.user.id,
              sessionId: auth.session.id,
            });
            return { options: result.options };
          } catch (error: unknown) {
            logger.error("Passkey registration start failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return refuseOptions(set, 500, {
              error: "Failed to start adding the passkey: nothing was changed.",
            });
          }
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({
            name: t.String({ maxLength: 1024 }),
            password: t.String({ maxLength: 1024 }),
          }),
        },
      )

      /**
       * POST /dashboard/account/passkeys
       * Finishes adding a passkey with the browser's registration
       * response (form field `credential`, JSON): this session's
       * challenge (spent), the exact origin and RP ID, user verification,
       * no attestation. On success the passkey is stored; when it is the
       * account's first second factor every other session is signed out;
       * this session becomes `mfa`; the account is emailed and the change
       * recorded (`auth.passkey.added`).
       */
      .post(
        "/account/passkeys",
        async ({ body, auth, set, request, server }) => {
          const ip = requestIp(request, server?.requestIP(request)?.address);
          const rp = currentRelyingParty();
          if (!rp) return toPasskeysPage(set, PASSKEYS_OFF, "error");
          try {
            const result = await passkeyService.finishRegistration(
              {
                userId: auth.user.id,
                sessionId: auth.session.id,
                response: parseRegistrationResponse(body.credential),
              },
              rp,
              dashboardClient(request, server),
            );
            if (!result.ok) {
              logger.warn("Passkey registration refused", {
                userId: auth.user.id,
                sessionId: auth.session.id,
                reason: result.reason,
                ip,
              });
              return toPasskeysPage(
                set,
                ACCOUNT_REFUSAL[result.reason] ?? "Nothing was changed.",
                "error",
              );
            }
            logger.warn("Passkey added", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              passkeyId: result.credentialId,
              sessionsRevoked: result.sessionsRevoked,
              ip,
            });
            alertPasskeyChange("passkey_added", auth, ip, result.name);
            return toPasskeysPage(
              set,
              result.sessionsRevoked > 0
                ? "Passkey added. You were signed out on every other device."
                : "Passkey added.",
              "success",
            );
          } catch (error: unknown) {
            logger.error("Passkey registration failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toPasskeysPage(
              set,
              "Failed to add the passkey: nothing was changed.",
              "error",
            );
          }
        },
        { beforeHandle: memberGuard, body: FINISH_BODY },
      )

      /**
       * POST /dashboard/account/passkeys/:id/rename
       * Renames one of the user's passkeys (1 to 64 characters). Scoped to
       * `auth.user.id` in the service: another account's passkey id
       * changes nothing.
       */
      .post(
        "/account/passkeys/:id/rename",
        async ({ params, body, auth, set }) => {
          try {
            const result = await passkeyService.renamePasskey(
              auth.user.id,
              params.id,
              body.name.trim(),
            );
            if (!result.ok) {
              logger.warn("Passkey rename refused", {
                userId: auth.user.id,
                passkeyId: params.id,
                reason: result.reason,
              });
              return toPasskeysPage(
                set,
                result.reason === "invalid_name"
                  ? result.problem
                  : (ACCOUNT_REFUSAL[result.reason] ?? "Nothing was changed."),
                "error",
              );
            }
            logger.info("Passkey renamed", {
              userId: auth.user.id,
              passkeyId: params.id,
            });
            return toPasskeysPage(set, "Passkey renamed.", "success");
          } catch (error: unknown) {
            logger.error("Passkey rename failed", {
              userId: auth.user.id,
              passkeyId: params.id,
              error: errorMessage(error),
            });
            return toPasskeysPage(
              set,
              "Failed to rename the passkey: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
          body: t.Object({ name: t.String({ maxLength: 1024 }) }),
        },
      )

      /**
       * POST /dashboard/account/passkeys/:id/delete
       * Removes one of the user's passkeys, after the current password
       * (the password change's budget, #279). Sessions it opened end with
       * it. Removing the last second factor is allowed, as turning TOTP off
       * is (#220): under `REQUIRE_2FA` the guard then holds the account on
       * its Two-factor and Passkeys pages. The account is emailed and the
       * change recorded (`auth.passkey.removed`).
       */
      .post(
        "/account/passkeys/:id/delete",
        async ({ params, body, auth, set, request, server }) => {
          const ip = requestIp(request, server?.requestIP(request)?.address);
          try {
            const result = await passkeyService.deletePasskey(
              auth.user.id,
              params.id,
              body.password,
              passwordChangeLimiter(auth.user.id, ip),
              dashboardClient(request, server),
            );
            if (!result.ok) {
              logger.warn("Passkey removal refused", {
                userId: auth.user.id,
                passkeyId: params.id,
                reason: result.reason,
                ip,
              });
              return toPasskeysPage(
                set,
                ACCOUNT_REFUSAL[result.reason] ?? "Nothing was changed.",
                "error",
              );
            }
            logger.warn("Passkey removed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              passkeyId: params.id,
              ip,
            });
            alertPasskeyChange("passkey_removed", auth, ip, result.name);
            return toPasskeysPage(set, "Passkey removed.", "success");
          } catch (error: unknown) {
            logger.error("Passkey removal failed", {
              userId: auth.user.id,
              passkeyId: params.id,
              ip,
              error: errorMessage(error),
            });
            return toPasskeysPage(
              set,
              "Failed to remove the passkey: nothing was changed.",
              "error",
            );
          }
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String({ maxLength: 64 }) }),
          body: t.Object({ password: t.String({ maxLength: 1024 }) }),
        },
      )
  );
}
