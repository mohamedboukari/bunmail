import { t, type Context } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import type {
  DashboardAuth,
  PasskeyRefusal,
} from "../../modules/users/types/user.types.ts";
import * as passkeyService from "../../modules/users/services/passkey.service.ts";
import * as twoFactorService from "../../modules/users/services/two-factor.service.ts";
import { parseRegistrationResponse } from "../../modules/users/services/passkey-policy.service.ts";
import {
  PASSKEYS_PAGE,
  twoFactorRequired,
} from "../../modules/users/services/two-factor-policy.service.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";
import { AccountPasskeysPage } from "../routes/account-passkeys.tsx";
import { memberGuard } from "../guards.tsx";
import { redirect, setNoStore } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import { dashboardClient } from "../lib/audit.ts";
import { passwordChangeLimiter } from "../lib/password-limiter.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { requestIp } from "../lib/sign-in.tsx";
import {
  FINISH_BODY,
  PASSKEYS_OFF,
  currentRelyingParty,
  refuseOptions,
} from "../lib/passkeys.ts";
import { FLASH_QUERY, flashMessage, flashUrl, toFlash } from "../lib/flash.ts";
import type { FlashCode } from "../lib/flash-codes.ts";

/* ─── Account: the Passkeys page ─── */

/** Redirects to the Passkeys page with a flash banner. */
function toPasskeysPage(set: Context["set"], code: FlashCode): string {
  return redirect(set, flashUrl(PASSKEYS_PAGE, code));
}

/**
 * The Passkeys page's flash code for a refused action (#421: a code,
 * never text); the options endpoint answers the code's message as JSON.
 * Any other refusal is `passkey_nothing_changed`.
 */
const ACCOUNT_REFUSAL: Partial<Record<PasskeyRefusal, FlashCode>> = {
  rate_limited: "rate_limited",
  wrong_password: "current_password_wrong",
  no_challenge: "passkey_no_challenge",
  rejected: "passkey_rejected",
  already_registered: "passkey_already_registered",
  not_found: "passkey_not_found",
  sso_link_requires_second_factor: "passkey_sso_link",
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
                flash={toFlash(query.flash, query.flashN)}
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
            ...FLASH_QUERY,
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
                error: flashMessage(
                  ACCOUNT_REFUSAL[result.reason] ?? "passkey_nothing_changed",
                ),
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
          if (!rp) return toPasskeysPage(set, "passkeys_off");
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
                ACCOUNT_REFUSAL[result.reason] ?? "passkey_nothing_changed",
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
              result.sessionsRevoked > 0 ? "passkey_added_signed_out" : "passkey_added",
            );
          } catch (error: unknown) {
            logger.error("Passkey registration failed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              ip,
              error: errorMessage(error),
            });
            return toPasskeysPage(set, "passkey_add_failed");
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
                /** One fixed sentence for the name policy (#421): never the problem text. */
                result.reason === "invalid_name"
                  ? "passkey_invalid_name"
                  : (ACCOUNT_REFUSAL[result.reason] ?? "passkey_nothing_changed"),
              );
            }
            logger.info("Passkey renamed", {
              userId: auth.user.id,
              passkeyId: params.id,
            });
            return toPasskeysPage(set, "passkey_renamed");
          } catch (error: unknown) {
            logger.error("Passkey rename failed", {
              userId: auth.user.id,
              passkeyId: params.id,
              error: errorMessage(error),
            });
            return toPasskeysPage(set, "passkey_rename_failed");
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
                ACCOUNT_REFUSAL[result.reason] ?? "passkey_nothing_changed",
              );
            }
            logger.warn("Passkey removed", {
              userId: auth.user.id,
              sessionId: auth.session.id,
              passkeyId: params.id,
              ip,
            });
            alertPasskeyChange("passkey_removed", auth, ip, result.name);
            return toPasskeysPage(set, "passkey_removed");
          } catch (error: unknown) {
            logger.error("Passkey removal failed", {
              userId: auth.user.id,
              passkeyId: params.id,
              ip,
              error: errorMessage(error),
            });
            return toPasskeysPage(set, "passkey_remove_failed");
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
