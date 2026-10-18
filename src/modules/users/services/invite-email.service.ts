import { randomBytes } from "crypto";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { sendMail } from "../../emails/services/mailer.service.ts";
import type {
  DkimOptions,
  SendMailResult,
} from "../../emails/services/mailer.service.ts";
import { getDomainByName } from "../../domains/services/domain.service.ts";
import { resolveDomainDkim } from "../../domains/services/domain-dkim.service.ts";
import type { Domain } from "../../domains/types/domain.types.ts";
import { UserStoreError, withSanitizedErrors } from "../errors.ts";
import type { InviteMailOutcome, InviteRole } from "../types/user.types.ts";

/**
 * The invitation email (#217): composed here and sent out-of-band with
 * `sendMail` (no `emails` row, no API key), like inbound notifications
 * (#106), from `SYSTEM_MAIL_FROM` and signed with that domain's DKIM key.
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

/** Escapes the five HTML-significant characters. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c] ?? c,
  );
}

/**
 * Flattens a value for one line of the plain-text part: control
 * characters become spaces, so a hostile name cannot add lines that look
 * like part of the message.
 */
function oneLine(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
export interface InviteMailDeps {
  /** `SYSTEM_MAIL_FROM`, or `null` when unset. */
  from: string | null;
  /** Domain lookup by name (lower-cased). */
  findDomain: (name: string) => Promise<Domain | undefined>;
  /** DKIM options for a domain, or `undefined` when its key is unusable. */
  resolveDkim: (domain: Domain) => DkimOptions | undefined;
  /** The direct-to-MX mailer. */
  send: typeof sendMail;
  /** Message-ID domain (`MAIL_HOSTNAME`). */
  hostname: string;
}

/** The production dependencies. */
function defaultDeps(): InviteMailDeps {
  return {
    from: config.systemMailFrom,
    /** A drizzle error would carry the query params: sanitized to its SQLSTATE. */
    findDomain: (name) => withSanitizedErrors(() => getDomainByName(name)),
    resolveDkim: resolveDomainDkim,
    send: sendMail,
    hostname: config.mail.hostname,
  };
}

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
  deps: InviteMailDeps = defaultDeps(),
): Promise<InviteMailOutcome> {
  const to = redactEmail(input.to);
  const notSent = (
    reason: "not_configured" | "sender_unavailable" | "send_failed",
    detail: Record<string, unknown> = {},
  ): InviteMailOutcome => {
    logger.warn("Invitation email not sent", {
      invitationId: input.invitationId,
      to,
      reason,
      ...detail,
    });
    return { sent: false, reason };
  };

  if (!deps.from) return notSent("not_configured");
  const domainName = deps.from.split("@")[1] ?? "";

  let result: SendMailResult;
  try {
    const domain = await deps.findDomain(domainName);
    if (!domain) return notSent("sender_unavailable", { domain: domainName });
    if (!domain.dkimVerified) {
      return notSent("sender_unavailable", { domain: domainName, dkimVerified: false });
    }
    const dkim = deps.resolveDkim(domain);
    if (!dkim) return notSent("sender_unavailable", { domain: domainName, dkim: "none" });

    const content = buildInviteEmail(input);
    result = await deps.send({
      from: deps.from,
      to: input.to,
      subject: content.subject,
      text: content.text,
      html: content.html,
      messageId: `<${randomBytes(16).toString("hex")}@${deps.hostname}>`,
      dkim,
    });
  } catch (err) {
    /**
     * Never the raw message: a database error's carries the query and its
     * parameters, and an SMTP error's can quote addresses. The error name
     * and, for the users store, the SQLSTATE are enough to diagnose.
     */
    return notSent("send_failed", {
      domain: domainName,
      error: "Invitation email lookup or send threw",
      errorName: err instanceof Error ? err.name : typeof err,
      ...(err instanceof UserStoreError ? { sqlState: err.sqlState } : {}),
    });
  }

  /** `sendMail` reports a dead MX per group instead of throwing. */
  const groups = Object.values(result.deliveryState);
  if (!groups.some((g) => g.status === "sent")) {
    return notSent("send_failed", {
      domain: domainName,
      groups: groups.map((g) => g.status),
    });
  }
  logger.info("Invitation email sent", {
    invitationId: input.invitationId,
    to,
    domain: domainName,
  });
  return { sent: true };
}
