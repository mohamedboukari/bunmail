import { logger } from "../../../utils/logger.ts";
import { maskEmail, redactEmail } from "../../../utils/redact.ts";
import {
  escapeHtml,
  oneLine,
  sendSystemMail,
  systemMailDeps,
  type SystemMailDeps,
  type SystemMailFailure,
} from "./system-mail.service.ts";

/**
 * The new-device sign-in alert (#282): "New sign-in to your BunMail
 * account", sent to the account's address when it signs in with a
 * password from a browser it has not used in the last 30 days. Sent like
 * the invitation email (`sendSystemMail`: from `SYSTEM_MAIL_FROM`,
 * DKIM-signed, never unsigned).
 *
 * **No links of any kind**: no URL, no token, no button. A forwarded or
 * leaked alert must not be able to act on the account, and users should
 * not learn to click links in security mail. The text tells them where to
 * go in the dashboard instead.
 */

/** Subject of every alert: static, so nothing can inject a header. */
const ALERT_SUBJECT = "New sign-in to your BunMail account";

/** What to do about it: the same words in both parts. */
const ADVICE =
  "If this was you, you can ignore this email. If it wasn't, sign in and use " +
  "Account > Active sessions > Sign out all other devices, change your " +
  "password, and tell an administrator.";

/** Why there is no link. */
const NO_LINK_NOTE =
  "This email has no links on purpose: open your BunMail dashboard yourself.";

/** What the alert says. Pure input: no I/O. */
export interface NewDeviceAlertInput {
  /** The account's address (shown masked). */
  email: string;
  /** The device label ("Chrome on macOS"). */
  device: string;
  /** The client IP (a valid literal), or null when unknown. */
  ip: string | null;
  /** Approximate location, or null when unknown. */
  location: string | null;
  /** When the sign-in happened. */
  at: Date;
}

/** A composed alert. */
export interface NewDeviceAlertContent {
  subject: string;
  text: string;
  html: string;
}

/** "2026-10-18 14:03:27 UTC". */
export function formatAlertTime(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Composes the alert. Pure: every dynamic value is HTML-escaped in the
 * HTML part and flattened to one line in the text part. The location line
 * is left out when the location is unknown.
 */
export function buildNewDeviceAlertEmail(
  input: NewDeviceAlertInput,
): NewDeviceAlertContent {
  const facts: Array<[string, string]> = [
    ["Account", oneLine(maskEmail(input.email))],
    ["Device", oneLine(input.device)],
    ["IP address", input.ip ? oneLine(input.ip) : "unknown"],
  ];
  if (input.location) facts.push(["Approximate location", oneLine(input.location)]);
  facts.push(["Time", formatAlertTime(input.at)]);
  const intro =
    "Your BunMail account was just signed in to from a device it has not used recently.";

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

  return { subject: ALERT_SUBJECT, text, html };
}

/** Outcome of `sendNewDeviceAlert`. */
export type NewDeviceAlertOutcome =
  { sent: true } | { sent: false; reason: SystemMailFailure };

/** What to send, to whom, and the ids for the log lines. */
export interface SendNewDeviceAlertInput extends NewDeviceAlertInput {
  userId: string;
  /** `user_devices.id`. */
  deviceId: string;
}

/**
 * Sends the alert when the system sender is usable. Never throws. Logs:
 * `warn` `New-device sign-in alert sent` (redacted address), `info`
 * `New-device sign-in alert not sent` when no system sender is configured
 * (an expected setup, nothing to fix), and `warn` for a sender that is
 * configured but unusable or a send that failed. Never the address in
 * clear, never a raw error.
 */
export async function sendNewDeviceAlert(
  input: SendNewDeviceAlertInput,
  deps: SystemMailDeps = systemMailDeps(),
): Promise<NewDeviceAlertOutcome> {
  const content = buildNewDeviceAlertEmail(input);
  const result = await sendSystemMail({ to: input.email, ...content }, deps);
  const ids = { userId: input.userId, deviceId: input.deviceId };

  if (!result.sent) {
    if (result.reason === "not_configured") {
      logger.info("New-device sign-in alert not sent", {
        ...ids,
        ip: input.ip,
        reason: result.reason,
      });
    } else {
      logger.warn("New-device sign-in alert not sent", {
        ...ids,
        reason: result.reason,
        ...result.detail,
      });
    }
    return { sent: false, reason: result.reason };
  }
  logger.warn("New-device sign-in alert sent", {
    ...ids,
    to: redactEmail(input.email),
    domain: result.domain,
  });
  return { sent: true };
}
