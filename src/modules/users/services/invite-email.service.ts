import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import type { InviteMailOutcome, InviteRole } from "../types/user.types.ts";
import {
  escapeHtml,
  oneLine,
  sendSystemMail,
  systemMailDeps,
  type SystemMailDeps,
} from "./system-mail.service.ts";

/**
 * The invitation email (#217): composed here and sent with
 * `sendSystemMail` (`system-mail.service.ts`): out-of-band, from
 * `SYSTEM_MAIL_FROM`, signed with that domain's DKIM key.
 *
 * Sent only when the sender is usable: `SYSTEM_MAIL_FROM` is set, its
 * domain is registered in BunMail with a verified DKIM record, and its
 * key decrypts. Otherwise, or when no MX group accepts the message, the
 * caller shows the inviter the link once instead, so an invitation never
 * fails because mail could not go out.
 *
 * The email carries exactly one link, the accept link: no tracking pixel,
 * no other URL. Never logs the link or the token.
 */

/** Subject of every invitation email: static, so nothing can inject a header. */
const INVITE_SUBJECT = "You're invited to BunMail";

/** What the invitation email says. Pure input: no I/O. */
export interface InviteEmailInput {
  /** Absolute accept link (`/dashboard/invite?token=...`). */
  url: string;
  /** Who invited: their name, or their email when they have no name. */
  inviter: string;
  /** Role the new account will get. */
  role: InviteRole;
  /** When the link stops working. */
  expiresAt: Date;
}

/** A composed invitation email. */
export interface InviteEmailContent {
  subject: string;
  text: string;
  html: string;
}

/** "an admin" / "a member". */
function withArticle(role: InviteRole): string {
  return role === "admin" ? "an admin" : "a member";
}

/**
 * Composes the invitation email. Pure: every dynamic value (inviter, role,
 * link, date) is HTML-escaped in the HTML part and flattened to one line
 * in the text part. The accept link is the only link in either part.
 */
export function buildInviteEmail(input: InviteEmailInput): InviteEmailContent {
  const inviter = oneLine(input.inviter);
  const role = withArticle(input.role);
  const expires = input.expiresAt.toUTCString();

  const text = [
    `${inviter} invited you to join BunMail as ${role}.`,
    "",
    "Accept the invitation and choose your password:",
    input.url,
    "",
    `The link works once and expires on ${expires}.`,
    "If you were not expecting this invitation, ignore this email.",
  ].join("\n");

  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#1f2328;line-height:1.5;">`,
    `<p style="margin:0 0 16px;"><strong>${escapeHtml(inviter)}</strong> invited you to join BunMail as ${escapeHtml(role)}.</p>`,
    `<p style="margin:16px 0;"><a href="${escapeHtml(input.url)}" style="color:#0969da;">Accept the invitation</a></p>`,
    `<p style="margin:16px 0;font-size:13px;color:#656d76;">The link works once and expires on ${escapeHtml(expires)}.</p>`,
    `<p style="margin:0;font-size:12px;color:#8b949e;">If you were not expecting this invitation, ignore this email.</p>`,
    `</div>`,
  ].join("");

  return { subject: INVITE_SUBJECT, text, html };
}

/** What `sendInviteEmail` needs from the outside, injectable for tests. */
export type InviteMailDeps = SystemMailDeps;

/** What to send and to whom. */
export interface SendInviteEmailInput extends InviteEmailInput {
  /** `user_tokens.id`, for the log lines. */
  invitationId: string;
  /** The invited address. */
  to: string;
}

/**
 * Sends the invitation email when the system sender is usable, and says
 * whether it went out. Never throws: every failure is logged (`warn`,
 * with the invitation id, the redacted address and the reason) and
 * reported as `{ sent: false, reason }` so the caller can fall back to
 * showing the link. `sent` means a receiving MX accepted the message.
 */
export async function sendInviteEmail(
  input: SendInviteEmailInput,
  deps: InviteMailDeps = systemMailDeps(),
): Promise<InviteMailOutcome> {
  const to = redactEmail(input.to);
  const content = buildInviteEmail(input);
  const result = await sendSystemMail({ to: input.to, ...content }, deps);

  if (!result.sent) {
    logger.warn("Invitation email not sent", {
      invitationId: input.invitationId,
      to,
      reason: result.reason,
      ...("errorName" in result.detail
        ? { error: "Invitation email lookup or send threw" }
        : {}),
      ...result.detail,
    });
    return { sent: false, reason: result.reason };
  }
  logger.info("Invitation email sent", {
    invitationId: input.invitationId,
    to,
    domain: result.domain,
  });
  return { sent: true };
}
