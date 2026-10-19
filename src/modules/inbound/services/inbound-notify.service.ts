import { randomBytes } from "crypto";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { sendMail } from "../../emails/services/mailer.service.ts";
import {
  getDomainByName,
  domainExistsByName,
} from "../../domains/services/domain.service.ts";
import { resolveDomainDkim } from "../../domains/services/domain-dkim.service.ts";
import type { Domain } from "../../domains/types/domain.types.ts";
import {
  NOTIFY_DOMAIN_THROTTLE_MAX,
  NOTIFY_THROTTLE_MAX,
  NOTIFY_THROTTLE_WINDOW_MS,
  NotifyThrottle,
  type SkippedNotifications,
} from "./notify-throttle.ts";
import type { RawHeaderLine } from "./threading.ts";

/**
 * Inbound notification service (#106).
 *
 * When the SMTP receiver accepts an inbound message for a domain that has
 * a `notify_email` set, this sends a small "you have new mail" email to
 * that address: which address received it, who it is from, when, its
 * size and (when `APP_BASE_URL` is configured) a link to the message in
 * the dashboard.
 *
 * The notification is sent FROM `<INBOUND_NOTIFY_FROM_LOCAL>@<recipient
 * domain>` and DKIM-signed with that domain's own key, so it passes the
 * same SPF/DKIM the operator already set up for outbound. It is sent
 * out-of-band via {@link sendMail} (no `emails` row): there is no owning
 * API key in the per-domain model, and a notification doesn't belong in
 * the sender's outbound log. The send outcome is logged instead.
 *
 * Because the operator's domain signs it, a notification never carries
 * the inbound message's content by default (#250): the subject is fixed,
 * and the body holds no subject, no text and no link from the message.
 * `INBOUND_NOTIFY_PREVIEW=true` adds the original subject and a short
 * preview to the body, plain text only, every link replaced. Automatic
 * inbound mail (auto-replies, bulk and list mail, a null return path) is
 * not notified, and each recipient address gets at most
 * {@link NOTIFY_THROTTLE_MAX} notifications per 10 minutes, each recipient
 * domain at most {@link NOTIFY_DOMAIN_THROTTLE_MAX}.
 *
 * The receiver calls {@link notifyInboundReceived} fire-and-forget after
 * the inbound row is persisted, so a slow notification never delays the
 * SMTP acknowledgement.
 */

/** Longest preview, and longest original subject, shown (characters). */
const NOTIFY_PREVIEW_CHARS = 200;

/** Longest address shown (RFC 5321 path limit). */
const NOTIFY_ADDRESS_CHARS = 320;

/** What every `http://`, `https://` and `www.` link becomes. */
const LINK_REMOVED = "[link removed]";

/**
 * A link a mail client could make clickable: `http://` or `https://`
 * anywhere, or `www.` at the start of a word (not after `@` or a dot, so
 * the domain of `user@www.example.com` stays readable). Runs to the next
 * whitespace.
 */
const LINK_PATTERN = /https?:\/\/\S*|(?<![\w@.-])www\.\S*/gi;

/** Bidirectional controls: they can make text display in another order. */
const BIDI_CONTROLS = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

/** The composed notification email (plain text only), ready for {@link sendMail}. */
export interface InboundNotificationContent {
  subject: string;
  text: string;
}

/** Inputs for {@link buildInboundNotification}: pure, no I/O. */
export interface BuildNotificationInput {
  /** Address the inbound mail was sent to (the BunMail mailbox). */
  to: string;
  /** Sender of the inbound mail. */
  from: string;
  /** When the inbound mail arrived. */
  receivedAt: Date;
  /** Size of the raw inbound message, in bytes. */
  sizeBytes: number;
  /** Absolute dashboard URL for the message, or null to omit the link. */
  detailUrl: string | null;
  /** `INBOUND_NOTIFY_PREVIEW`: include the original subject and a preview. */
  preview: boolean;
  /** Subject of the inbound mail, or null when absent (shown only with `preview`). */
  subject: string | null;
  /** Plain-text body of the inbound mail (shown only with `preview`). */
  text: string | null;
  /** Earlier mail to this address not notified by the throttle, or null. */
  skipped: SkippedNotifications | null;
}

/**
 * Makes an untrusted value safe for one line of the plain-text part:
 * control characters (CR/LF included) become spaces, bidirectional
 * controls are dropped, whitespace collapses, every link is replaced by
 * {@link LINK_REMOVED}, and the result is cut to `maxChars` characters
 * (code points, so no emoji is split) with an ellipsis. Only a bounded
 * prefix is read, so a 10 MB field costs no more than a short one.
 */
export function plainTextLine(value: string, maxChars: number): string {
  /** Bounded prefix; a high surrogate cut from its pair is dropped. */
  const head = value.slice(0, maxChars * 4).replace(/[\uD800-\uDBFF]$/, "");
  const flat = head
    .replace(/[\p{Cc}\u2028\u2029]+/gu, " ")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(LINK_PATTERN, LINK_REMOVED);
  const chars = Array.from(flat);
  if (chars.length <= maxChars) return flat;
  return chars.slice(0, maxChars).join("").trimEnd() + "…";
}

/** A byte count for people: `512 bytes`, `12.3 KB`, `4.0 MB`. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Composes the notification email. Pure function. Plain text only, so no
 * inbound value can ever reach HTML. The subject is fixed (`New email for
 * <address>`) and never carries the inbound subject; the body names the
 * sender as plain text, the arrival time and the size, and only with
 * `preview` the original subject and a short preview, links removed.
 */
export function buildInboundNotification(
  input: BuildNotificationInput,
): InboundNotificationContent {
  const to = plainTextLine(input.to, NOTIFY_ADDRESS_CHARS);
  const from = plainTextLine(input.from, NOTIFY_ADDRESS_CHARS) || "(unknown sender)";
  const domain = to.split("@")[1] ?? to;

  const subject = `New email for ${to}`;

  const lines = [
    `You have a new email at ${to}.`,
    "",
    `From:     ${from}`,
    `Received: ${input.receivedAt.toUTCString()}`,
    `Size:     ${formatSize(input.sizeBytes)}`,
  ];
  if (input.preview) {
    const originalSubject =
      plainTextLine(input.subject ?? "", NOTIFY_PREVIEW_CHARS) || "(no subject)";
    lines.splice(3, 0, `Subject:  ${originalSubject}`);
    const preview = plainTextLine(input.text ?? "", NOTIFY_PREVIEW_CHARS);
    if (preview) lines.push("", preview);
  }
  if (input.skipped) {
    const n = input.skipped.count;
    lines.push(
      "",
      `And ${n} more ${n === 1 ? "email" : "emails"} since ${new Date(
        input.skipped.since,
      ).toUTCString()}, not notified separately (at most ${NOTIFY_THROTTLE_MAX} notifications per address and ${NOTIFY_DOMAIN_THROTTLE_MAX} per domain every 10 minutes).`,
    );
  }
  if (input.detailUrl) {
    lines.push("", `View it in your dashboard: ${input.detailUrl}`);
  }
  lines.push(
    "",
    `Sent by BunMail because inbound notifications are enabled for ${domain}.`,
  );

  return { subject, text: lines.join("\n") };
}

/** Why an inbound message is automatic, or `null` when it is not. */
export type AutomaticInboundReason =
  "null_return_path" | "auto_submitted" | "precedence" | "autoreply_header";

/** `Precedence` values that mark bulk, junk and list mail. */
const BULK_PRECEDENCE = new Set(["bulk", "junk", "list"]);

/** The unfolded value of a raw header line, first 256 characters only. */
function headerValue(line: string): string {
  const colon = line.indexOf(":");
  if (colon < 0) return "";
  return line
    .slice(colon + 1, colon + 1 + 256)
    .replace(/\r?\n(?=[ \t])/g, "")
    .trim();
}

/** The first word of a header value, lower-cased (`no (comment)` gives `no`). */
function firstToken(value: string): string {
  return (value.split(/[\s;(]/, 1)[0] ?? "").toLowerCase();
}

/**
 * Whether an inbound message was sent by a machine and gets no
 * notification (#250): a null return path (`MAIL FROM:<>`),
 * `Auto-Submitted` with any value but `no` (RFC 3834), `Precedence:
 * bulk|junk|list`, or an `X-Autoreply` / `X-Autorespond` header. Notifying
 * on these only adds noise, and answering an auto-reply risks a loop.
 * Pure; returns the reason for the log.
 */
export function automaticInboundReason(
  headerLines: readonly RawHeaderLine[],
  returnPath: string,
): AutomaticInboundReason | null {
  if (returnPath.trim() === "") return "null_return_path";
  for (const { key, line } of headerLines) {
    const name = key.toLowerCase();
    if (name === "auto-submitted") {
      if (firstToken(headerValue(line)) !== "no") return "auto_submitted";
    } else if (name === "precedence") {
      if (BULK_PRECEDENCE.has(firstToken(headerValue(line)))) return "precedence";
    } else if (name === "x-autoreply" || name === "x-autorespond") {
      return "autoreply_header";
    }
  }
  return null;
}

/** What the notification path needs from the outside, injectable for tests. */
export interface InboundNotifyDeps {
  /** The direct-to-MX mailer. */
  send: typeof sendMail;
  /** The current time (ms). */
  now: () => number;
  /** The per-address and per-domain budgets (#250). */
  throttle: NotifyThrottle;
}

/** The production dependencies: one throttle for the whole process. */
const defaultDeps: InboundNotifyDeps = {
  send: sendMail,
  now: () => Date.now(),
  throttle: new NotifyThrottle(),
};

/** The production dependencies. */
export function inboundNotifyDeps(): InboundNotifyDeps {
  return defaultDeps;
}

/** Inputs for {@link notifyInboundReceived}. */
export interface NotifyInboundInput {
  /** The `inb_…` id of the stored inbound row (for the dashboard link). */
  inboundId: string;
  /** Sender of the inbound mail. */
  from: string;
  /**
   * The **envelope** RCPT TO addresses the receiver actually accepted
   * (`session.envelope.rcptTo`). Domain resolution keys off these, NOT
   * the spoofable `To:` header, so BCC / list mail still notifies the
   * domain the message was received for, and a forged header can't steer
   * which domain's identity/key signs the notification. One message can be
   * addressed to several registered domains; each notify-enabled one gets
   * its own notification.
   */
  recipients: string[];
  /** Subject of the inbound mail, or null (in the body only with the preview on). */
  subject: string | null;
  /** Plain-text body of the inbound mail, or null (previewed only when enabled). */
  text: string | null;
  /** The message's raw header lines, for the automatic-mail check. */
  headerLines: readonly RawHeaderLine[];
  /** Envelope `MAIL FROM`; empty for a null return path (`<>`). */
  returnPath: string;
  /** Size of the raw message, in bytes. */
  sizeBytes: number;
}

/**
 * Sends inbound notifications for every accepted recipient domain that has
 * a `notify_email` configured.
 *
 * Resolution + guards:
 *   0. **Automatic mail** (#250): auto-replies, bulk and list mail and a
 *      null return path are not notified ({@link automaticInboundReason}).
 *   1. **Loop guard**: skip entirely when the inbound sender's domain is
 *      itself a registered BunMail domain. Notifications are sent from
 *      `notifications@<our domain>`, so a notification that loops back in
 *      (or any intra-system mail) is suppressed rather than re-notifying.
 *   2. Group the accepted envelope recipients by domain; for each distinct
 *      domain with a `notify_email`, send one summary email (signed with
 *      that domain's own key).
 *
 * Never throws: the whole body is wrapped so every failure (DB lookups,
 * the send) is logged and swallowed. The caller invokes it fire-and-forget
 * after the SMTP ack, and the contract holds even without a `.catch`.
 */
export async function notifyInboundReceived(
  input: NotifyInboundInput,
  deps: InboundNotifyDeps = defaultDeps,
): Promise<void> {
  try {
    const automatic = automaticInboundReason(input.headerLines, input.returnPath);
    if (automatic) {
      logger.debug("Inbound notify skipped: automatic message", {
        inboundId: input.inboundId,
        reason: automatic,
      });
      return;
    }

    /** Loop guard: don't notify on mail from one of our own domains. */
    const senderDomain = input.from.split("@")[1]?.toLowerCase();
    if (senderDomain && (await domainExistsByName(senderDomain))) {
      logger.info("Inbound notify skipped: sender is a registered domain (loop guard)", {
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
      logger.debug("Inbound notify skipped: no envelope recipients", {
        inboundId: input.inboundId,
      });
      return;
    }

    for (const [domainName, recipientAddress] of byDomain) {
      const domain = await getDomainByName(domainName);
      if (!domain || !domain.notifyEmail) continue;
      await sendDomainNotification(domain, recipientAddress, input, deps);
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
  deps: InboundNotifyDeps,
): Promise<void> {
  const notifyEmail = domain.notifyEmail;
  if (!notifyEmail) return;

  const from = `${config.inboundNotify.fromLocalPart}@${domain.name}`;
  const dkim = resolveDomainDkim(domain);
  /**
   * A stored key that does not decrypt (#244): in production the
   * notification is not sent unsigned. With no key at all, or in
   * development, it is sent unsigned rather than dropped.
   */
  if (!dkim && domain.dkimPrivateKey !== null && config.env === "production") {
    logger.error("Inbound notification not sent: DKIM key unreadable", {
      domain: domain.name,
      inboundId: input.inboundId,
    });
    return;
  }
  /**
   * Per-address and per-domain budgets (#250): past either, the message is
   * counted and the next notification for this address reports it.
   */
  const now = deps.now();
  const decision = deps.throttle.check(recipientAddress, now);
  if (!decision.notify) {
    if (decision.firstInWindow && decision.limitedBy === "address") {
      logger.info("Inbound notifications throttled for this address", {
        inboundId: input.inboundId,
        to: redactEmail(recipientAddress),
        domain: domain.name,
        max: NOTIFY_THROTTLE_MAX,
        windowMinutes: NOTIFY_THROTTLE_WINDOW_MS / 60_000,
      });
    } else if (decision.firstInWindow) {
      logger.info("Inbound notifications throttled for this domain", {
        inboundId: input.inboundId,
        domain: domain.name,
        max: NOTIFY_DOMAIN_THROTTLE_MAX,
        windowMinutes: NOTIFY_THROTTLE_WINDOW_MS / 60_000,
      });
    } else {
      logger.debug("Inbound notify skipped: throttled", {
        inboundId: input.inboundId,
        domain: domain.name,
        limitedBy: decision.limitedBy,
      });
    }
    return;
  }

  const messageId = `<${randomBytes(16).toString("hex")}@${config.mail.hostname}>`;
  const detailUrl = config.appBaseUrl
    ? `${config.appBaseUrl}/dashboard/inbound/${input.inboundId}`
    : null;

  const content = buildInboundNotification({
    to: recipientAddress,
    from: input.from,
    receivedAt: new Date(now),
    sizeBytes: input.sizeBytes,
    detailUrl,
    preview: config.inboundNotify.preview,
    subject: input.subject,
    text: input.text,
    skipped: decision.skipped,
  });

  try {
    const result = await deps.send({
      from,
      to: notifyEmail,
      subject: content.subject,
      text: content.text,
      messageId,
      dkim,
      /** BunMail's own automatic mail: no auto-replies to it (#250). */
      feedback: { source: "system", apiKeyId: null },
      autoSubmitted: true,
    });
    /** sendMail doesn't throw on a dead recipient MX: it reports per-group
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
        reportedSkipped: decision.skipped?.count ?? 0,
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
