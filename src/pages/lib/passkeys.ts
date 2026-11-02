import { t, type Context } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import type { AuditLoginFailureReason } from "../../modules/audit/types/audit.types.ts";
import type {
  PasskeyRefusal,
  RelyingParty,
} from "../../modules/users/types/user.types.ts";
import {
  PASSKEY_RESPONSE_MAX_LENGTH,
  relyingPartyFrom,
} from "../../modules/users/services/passkey-policy.service.ts";
import { sendTwoFactorAlert } from "../../modules/users/services/two-factor-alert.service.ts";
import { sessionIp } from "../../modules/users/services/session-policy.service.ts";

/**
 * What the passkey routes share (#223): the public sign-ins
 * (`passkey-sign-in.plugin.tsx`, `passkey-second-step.plugin.tsx`) and the
 * Passkeys page (`passkey-account.plugin.tsx`).
 */

/** The JSON answer of an options request that cannot go on. */
interface OptionsRefusal {
  error: string;
  /** Where the browser should go instead (the pending session is gone). */
  redirect?: string;
}

/** What the browser is told when passkeys are off. */
export const PASSKEYS_OFF = "Passkeys are switched off on this server.";

/** The relying party now: `APP_BASE_URL` is read on every request (tests change it). */
export function currentRelyingParty(): RelyingParty | null {
  return relyingPartyFrom(config.appBaseUrl);
}

/** Answers an options request with an error status and JSON. */
export function refuseOptions(
  set: Context["set"],
  status: number,
  body: OptionsRefusal,
): OptionsRefusal {
  set.status = status;
  return body;
}

/** The cross-origin refusal every POST here gives, logged at `warn`. */
export function crossOrigin(
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
export function auditReason(reason: PasskeyRefusal): AuditLoginFailureReason {
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
export function reportCounterRegression(
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
export const FINISH_BODY = t.Object({
  credential: t.String({ maxLength: PASSKEY_RESPONSE_MAX_LENGTH }),
});
