import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { AccountTwoFactorPage } from "../routes/account-two-factor.tsx";
import { memberGuard } from "../guards.tsx";
import { consumeRevealSecret } from "../reveal-store.ts";
import * as twoFactorService from "../../modules/users/services/two-factor.service.ts";
import {
  TWO_FACTOR_PAGE,
  twoFactorRequired,
} from "../../modules/users/services/two-factor-policy.service.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import { passwordChangeLimiter } from "../lib/password-limiter.ts";
import { dashboardClient } from "../lib/audit.ts";
import { clientIp } from "../lib/client-ip.ts";
import {
  TWO_FACTOR_REFUSAL,
  alertTwoFactorChange,
  stashRecoveryCodes,
  toTwoFactorPage,
} from "../lib/account-two-factor.ts";
import type { accountSessionPages } from "./account-sessions.plugin.tsx";

/**
 * The Two-factor page (#220) and the enrolment: start and confirm. Takes
 * the instance the Active sessions routes were registered on, so the
 * route types chain exactly as in one `accountPages` chain.
 */
export function accountTwoFactorPages(app: ReturnType<typeof accountSessionPages>) {
  return (
    app
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
          const recoveryCodes = (
            await consumeRevealSecret(query.reveal, "recovery_codes", revealOwnerOf(auth))
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
              dashboardClient(request, server),
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
              await stashRecoveryCodes(result.recoveryCodes, auth),
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
  );
}
