import { logger } from "../../../utils/logger.ts";
import { maskEmail, redactEmail } from "../../../utils/redact.ts";
import { formatAlertTime } from "./new-device-alert.service.ts";
import {
  escapeHtml,
  oneLine,
  sendSystemMail,
  systemMailDeps,
  type SystemMailDeps,
  type SystemMailFailure,
} from "./system-mail.service.ts";

/**
 * Security emails about an account's two-factor authentication (#220),
 * sent like the new-device alert (#282): `sendSystemMail` from
 * `SYSTEM_MAIL_FROM`, DKIM-signed, never unsigned, and **no links of any
 * kind**. A change the account holder did not make is the signal: a
 * stolen session or password turning 2FA on (to lock them out) or off,
 * replacing the recovery codes, an admin-issued reset or `reset-owner`
 * removing it, or a correct password followed by a run of wrong codes.
 *
 * Callers never await it on the request path (`void`): a slow or failing
 * send never delays or breaks the action. It never throws.
 */

/** What happened to the account's second factor. */
export type TwoFactorAlertEvent =
  | "enabled"
  | "disabled"
  | "recovery_codes_regenerated"
  | "removed_by_reset"
  | "login_codes_exhausted";

/** Subject and first line per event: static text, nothing to inject. */
const EVENT_TEXT: Record<TwoFactorAlertEvent, { subject: string; intro: string }> = {
  enabled: {
    subject: "Two-factor authentication turned on for your BunMail account",
    intro:
      "Two-factor authentication was just turned on for your BunMail account. Signing in now needs a code from an authenticator app, and every other device was signed out.",
  },
  disabled: {
    subject: "Two-factor authentication turned off for your BunMail account",
    intro:
      "Two-factor authentication was just turned off for your BunMail account. Signing in now needs only the password.",
  },
  recovery_codes_regenerated: {
    subject: "New recovery codes for your BunMail account",
    intro:
      "New two-factor recovery codes were just created for your BunMail account. The previous recovery codes no longer work.",
  },
  removed_by_reset: {
    subject: "Two-factor authentication removed from your BunMail account",
    intro:
      "Your BunMail password was reset with a one-time reset link, and two-factor authentication was removed from the account with it. Signing in now needs only the new password.",
  },
  login_codes_exhausted: {
    subject: "Failed two-factor sign-in attempts on your BunMail account",
    intro:
      "Someone entered your BunMail password correctly, then several wrong two-factor codes, and the sign-in was blocked for a while. Whoever it was may know your password.",
  },
};

/** What to do about it: the same words for every event. */
const ADVICE =
  "If this was you, you can ignore this email. If it wasn't, sign in and change " +
  "your password, check Account > Two-factor, use Account > Active sessions > " +
  "Sign out all other devices, and tell an administrator.";

/** Why there is no link. */
const NO_LINK_NOTE =
  "This email has no links on purpose: open your BunMail dashboard yourself.";

/** A composed alert. */
export interface TwoFactorAlertContent {
  subject: string;
  text: string;
  html: string;
}

/**
 * Composes the alert. Pure: the masked address, the IP (or `unknown`) and
 * the time are escaped in the HTML part and flattened to one line in the
 * text part.
 */
export function buildTwoFactorAlertEmail(input: {
  event: TwoFactorAlertEvent;
  email: string;
  ip: string | null;
  at: Date;
}): TwoFactorAlertContent {
  const { subject, intro } = EVENT_TEXT[input.event];
  const facts: Array<[string, string]> = [
    ["Account", oneLine(maskEmail(input.email))],
    ["IP address", input.ip ? oneLine(input.ip) : "unknown"],
    ["Time", formatAlertTime(input.at)],
  ];
  const text = [
    intro,
    "",
    ...facts.map(([label, value]) => `${label}: ${value}`),
    "",
    ADVICE,
    "",
    NO_LINK_NOTE,
  ].join("\n");
  const rows = facts
    .map(
      ([label, value]) =>
        `<tr><td style="padding:2px 16px 2px 0;color:#656d76;">${escapeHtml(label)}</td><td style="padding:2px 0;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#1f2328;line-height:1.5;">`,
    `<p style="margin:0 0 16px;">${escapeHtml(intro)}</p>`,
    `<table style="border-collapse:collapse;margin:0 0 16px;font-size:14px;">${rows}</table>`,
    `<p style="margin:16px 0;">${escapeHtml(ADVICE)}</p>`,
    `<p style="margin:0;font-size:12px;color:#8b949e;">${escapeHtml(NO_LINK_NOTE)}</p>`,
    `</div>`,
  ].join("");
  return { subject, text, html };
}

/** Outcome of `sendTwoFactorAlert`. */
export type TwoFactorAlertOutcome =
  { sent: true } | { sent: false; reason: SystemMailFailure | "error" };

/** What to send, to whom, and the ids for the log lines. */
export interface SendTwoFactorAlertInput {
  event: TwoFactorAlertEvent;
  userId: string;
  /** The account's address. PII: logged only through `redactEmail`. */
  email: string;
  /** Client IP of the action, or null. */
  ip: string | null;
  at?: Date;
}

/**
 * Sends the alert when the system sender is usable. Never throws. Logs
 * `warn` `Two-factor security alert sent` (redacted address), `info`
 * `Two-factor security alert not sent` when no system sender is
 * configured, and `warn` for a configured but unusable sender, a failed
 * send or an unexpected error. Always with `event` and `userId`.
 */
export async function sendTwoFactorAlert(
  input: SendTwoFactorAlertInput,
  deps?: SystemMailDeps,
): Promise<TwoFactorAlertOutcome> {
  const ids = { event: input.event, userId: input.userId };
  try {
    const content = buildTwoFactorAlertEmail({
      event: input.event,
      email: input.email,
      ip: input.ip,
      at: input.at ?? new Date(),
    });
    const result = await sendSystemMail(
      { to: input.email, ...content },
      deps ?? systemMailDeps(),
    );
    if (!result.sent) {
      if (result.reason === "not_configured") {
        logger.info("Two-factor security alert not sent", {
          ...ids,
          reason: result.reason,
        });
      } else {
        logger.warn("Two-factor security alert not sent", {
          ...ids,
          reason: result.reason,
          ...result.detail,
        });
      }
      return { sent: false, reason: result.reason };
    }
    logger.warn("Two-factor security alert sent", {
      ...ids,
      to: redactEmail(input.email),
      domain: result.domain,
    });
    return { sent: true };
  } catch (error: unknown) {
    logger.warn("Two-factor security alert not sent", {
      ...ids,
      reason: "error",
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return { sent: false, reason: "error" };
  }
}
