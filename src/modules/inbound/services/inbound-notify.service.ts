import { randomBytes } from "crypto";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { decryptSecret, isEncryptedSecret } from "../../../utils/crypto.ts";
import { sendMail } from "../../emails/services/mailer.service.ts";
import type { DkimOptions } from "../../emails/services/mailer.service.ts";
import {
  getDomainByName,
  domainExistsByName,
} from "../../domains/services/domain.service.ts";
import type { Domain } from "../../domains/types/domain.types.ts";

/**
 * Inbound notification service (#106).
 *
 * When the SMTP receiver accepts an inbound message for a domain that has
 * a `notify_email` set, this sends a small "you have new mail" summary
 * email to that address — sender, subject, a short preview, and (when
 * `APP_BASE_URL` is configured) a link to the message in the dashboard.
 *
 * The notification is sent FROM `<INBOUND_NOTIFY_FROM_LOCAL>@<recipient
 * domain>` and DKIM-signed with that domain's own key, so it passes the
 * same SPF/DKIM the operator already set up for outbound. It is sent
 * out-of-band via {@link sendMail} (no `emails` row) — there is no owning
 * API key in the per-domain model, and a notification doesn't belong in
 * the sender's outbound log. The send outcome is logged instead.
 *
 * The receiver calls {@link notifyInboundReceived} fire-and-forget after
 * the inbound row is persisted, so a slow notification never delays the
 * SMTP acknowledgement.
 */

/** How many characters of the inbound body to include as a preview. */
const NOTIFY_PREVIEW_CHARS = 200;

/** The composed notification email, ready to hand to {@link sendMail}. */
export interface InboundNotificationContent {
  subject: string;
  html: string;
  text: string;
}

/** Inputs for {@link buildInboundNotification} — pure, no I/O. */
export interface BuildNotificationInput {
  /** Address the inbound mail was sent to (the BunMail mailbox). */
  to: string;
  /** Sender of the inbound mail. */
  from: string;
  /** Subject of the inbound mail, or null when absent. */
  subject: string | null;
  /** Plain-text body of the inbound mail, used for the preview. */
  text: string | null;
  /** Absolute dashboard URL for the message, or null to omit the link. */
  detailUrl: string | null;
}

/** Escapes the five HTML-significant characters for safe interpolation. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c] ?? c,
  );
}

/**
 * Collapses whitespace and truncates the inbound body to a short preview.
 * Returns an empty string when there's no text part (e.g. HTML-only mail).
 */
function buildPreview(text: string | null): string {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= NOTIFY_PREVIEW_CHARS) return collapsed;
  return collapsed.slice(0, NOTIFY_PREVIEW_CHARS).trimEnd() + "…";
}

/**
 * Composes the summary notification email. Pure function — all values are
 * provided by the caller, every user-controlled field is HTML-escaped in
 * the HTML part, and the subject carries the original subject so the
 * notification is glanceable in an inbox list.
 */
export function buildInboundNotification(
  input: BuildNotificationInput,
): InboundNotificationContent {
  const originalSubject = input.subject?.trim() || "(no subject)";
  const preview = buildPreview(input.text);

  const subject = `New email at ${input.to}: ${originalSubject}`;

  /** Plain-text part. */
  const textLines = [
    `You have a new email at ${input.to}.`,
    "",
    `From:    ${input.from}`,
    `Subject: ${originalSubject}`,
  ];
  if (preview) {
    textLines.push("", preview);
  }
  if (input.detailUrl) {
    textLines.push("", `View it in your dashboard: ${input.detailUrl}`);
  }
  textLines.push(
    "",
    "—",
    `Sent by BunMail because inbound notifications are enabled for ${input.to.split("@")[1] ?? input.to}.`,
  );
  const text = textLines.join("\n");

  /** HTML part — escaped user input, minimal inline styling. */
  const previewHtml = preview
    ? `<p style="margin:16px 0;padding:12px 16px;background:#f6f8fa;border-radius:6px;color:#444;white-space:pre-wrap;">${escapeHtml(
        preview,
      )}</p>`
    : "";
  const linkHtml = input.detailUrl
    ? `<p style="margin:16px 0;"><a href="${escapeHtml(
        input.detailUrl,
      )}" style="color:#0969da;">View it in your dashboard →</a></p>`
    : "";
  const html = [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#1f2328;line-height:1.5;">`,
    `<p style="margin:0 0 16px;">You have a new email at <strong>${escapeHtml(input.to)}</strong>.</p>`,
    `<table style="border-collapse:collapse;font-size:14px;">`,
    `<tr><td style="padding:2px 12px 2px 0;color:#656d76;">From</td><td>${escapeHtml(input.from)}</td></tr>`,
    `<tr><td style="padding:2px 12px 2px 0;color:#656d76;">Subject</td><td>${escapeHtml(originalSubject)}</td></tr>`,
    `</table>`,
    previewHtml,
    linkHtml,
    `<hr style="border:none;border-top:1px solid #e1e4e8;margin:24px 0 12px;">`,
    `<p style="margin:0;font-size:12px;color:#8b949e;">Sent by BunMail because inbound notifications are enabled for ${escapeHtml(
      input.to.split("@")[1] ?? input.to,
    )}.</p>`,
    `</div>`,
  ].join("");

  return { subject, html, text };
}

/**
 * Decrypts a domain's stored DKIM private key, mirroring the queue's
 * fail-open behaviour: null stays null, plaintext (boot encrypter not yet
 * run) is used as-is with a warning, and a decrypt failure logs and
 * returns null so the notification still sends — unsigned — rather than
 * being dropped.
 */
function decryptDkimPrivateKey(stored: string | null, domainName: string): string | null {
  if (stored === null) return null;
  if (!isEncryptedSecret(stored)) {
    logger.warn("DKIM private key stored as plaintext — boot encrypter has not run", {
      domain: domainName,
    });
    return stored;
  }
  try {
    return decryptSecret(stored, config.dkimEncryptionKey);
  } catch (err) {
    logger.error("Failed to decrypt DKIM private key — sending notification unsigned", {
      domain: domainName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Builds DKIM options from a domain row, or undefined when no key. */
function resolveDkim(domain: Domain): DkimOptions | undefined {
  const privateKey = decryptDkimPrivateKey(domain.dkimPrivateKey, domain.name);
  if (!privateKey) return undefined;
  return {
    domainName: domain.name,
    keySelector: domain.dkimSelector,
    privateKey,
  };
}

/** Inputs for {@link notifyInboundReceived}. */
export interface NotifyInboundInput {
  /** The `inb_…` id of the stored inbound row (for the dashboard link). */
  inboundId: string;
  /** Sender of the inbound mail. */
  from: string;
  /**
   * The **envelope** RCPT TO addresses the receiver actually accepted
   * (`session.envelope.rcptTo`). Domain resolution keys off these — NOT
   * the spoofable `To:` header — so BCC / list mail still notifies the
   * domain the message was received for, and a forged header can't steer
   * which domain's identity/key signs the notification. One message can be
   * addressed to several registered domains; each notify-enabled one gets
   * its own notification.
   */
  recipients: string[];
  /** Subject of the inbound mail, or null. */
  subject: string | null;
  /** Plain-text body of the inbound mail, or null. */
  text: string | null;
}

/**
 * Sends inbound notifications for every accepted recipient domain that has
 * a `notify_email` configured.
 *
 * Resolution + guards:
 *   1. **Loop guard** — skip entirely when the inbound sender's domain is
 *      itself a registered BunMail domain. Notifications are sent from
 *      `notifications@<our domain>`, so a notification that loops back in
 *      (or any intra-system mail) is suppressed rather than re-notifying.
 *   2. Group the accepted envelope recipients by domain; for each distinct
 *      domain with a `notify_email`, send one summary email (signed with
 *      that domain's own key).
 *
 * Never throws — the whole body is wrapped so every failure (DB lookups,
 * the send) is logged and swallowed. The caller invokes it fire-and-forget
 * after the SMTP ack, and the contract holds even without a `.catch`.
 */
export async function notifyInboundReceived(input: NotifyInboundInput): Promise<void> {
  try {
    /** Loop guard — don't notify on mail from one of our own domains. */
    const senderDomain = input.from.split("@")[1]?.toLowerCase();
    if (senderDomain && (await domainExistsByName(senderDomain))) {
      logger.info("Inbound notify skipped — sender is a registered domain (loop guard)", {
        from: redactEmail(input.from),
      });
      return;
    }

    /** Distinct recipient domain → first accepted address on it (for display). */
    const byDomain = new Map<string, string>();
    for (const addr of input.recipients) {
      const domainName = addr.split("@")[1]?.toLowerCase();
      if (domainName && !byDomain.has(domainName)) byDomain.set(domainName, addr);
    }
    if (byDomain.size === 0) {
      logger.debug("Inbound notify skipped — no envelope recipients", {
        inboundId: input.inboundId,
      });
      return;
    }

    for (const [domainName, recipientAddress] of byDomain) {
      const domain = await getDomainByName(domainName);
      if (!domain || !domain.notifyEmail) continue;
      await sendDomainNotification(domain, recipientAddress, input);
    }
  } catch (err) {
    logger.error("Inbound notification handler error", {
      inboundId: input.inboundId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Sends a single domain's notification. Isolated in its own try/catch so a
 * failure for one recipient domain doesn't abort the others, and so the
 * delivery outcome is reported accurately: `sendMail` resolves and returns
 * a per-MX `deliveryState` rather than throwing on a bad recipient MX, so
 * we inspect it and only log success when a group actually reached `sent`.
 */
async function sendDomainNotification(
  domain: Domain,
  recipientAddress: string,
  input: NotifyInboundInput,
): Promise<void> {
  const notifyEmail = domain.notifyEmail;
  if (!notifyEmail) return;

  const from = `${config.inboundNotify.fromLocalPart}@${domain.name}`;
  const dkim = resolveDkim(domain);
  const messageId = `<${randomBytes(16).toString("hex")}@${config.mail.hostname}>`;
  const detailUrl = config.appBaseUrl
    ? `${config.appBaseUrl}/dashboard/inbound/${input.inboundId}`
    : null;

  const content = buildInboundNotification({
    to: recipientAddress,
    from: input.from,
    subject: input.subject,
    text: input.text,
    detailUrl,
  });

  try {
    const result = await sendMail({
      from,
      to: notifyEmail,
      subject: content.subject,
      html: content.html,
      text: content.text,
      messageId,
      dkim,
    });
    /** sendMail doesn't throw on a dead recipient MX — it reports per-group
     *  outcomes. Only claim "sent" when a group actually landed. */
    const delivered = Object.values(result.deliveryState).some(
      (g) => g.status === "sent",
    );
    if (delivered) {
      logger.info("Inbound notification sent", {
        inboundId: input.inboundId,
        to: redactEmail(notifyEmail),
        domain: domain.name,
        signed: !!dkim,
      });
    } else {
      logger.warn("Inbound notification not delivered (no MX group accepted it)", {
        inboundId: input.inboundId,
        to: redactEmail(notifyEmail),
        domain: domain.name,
      });
    }
  } catch (err) {
    logger.warn("Inbound notification failed to send", {
      inboundId: input.inboundId,
      domain: domain.name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
