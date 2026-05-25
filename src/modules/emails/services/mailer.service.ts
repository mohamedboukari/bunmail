import { randomBytes } from "crypto";
import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { resolveMx } from "dns/promises";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { withMxLock } from "../../../utils/mx-throttle.ts";
import { parseRecipients, groupByMx, type Recipient } from "../../../utils/recipients.ts";

/**
 * Result of a `sendMail` call. The `messageId` is the canonical
 * `Message-ID:` header we generated up-front and used for every MX
 * group's submission — so all recipients see the same identifier,
 * which is what bounce/complaint feedback loops join on.
 *
 * `partialFailures` is populated only when *some* groups succeeded
 * and *others* failed. Full-failure paths throw instead so the
 * queue's retry/suppress logic ({@link handleSendFailure}) can react;
 * full-success leaves `partialFailures` undefined.
 */
export interface SendMailResult {
  messageId: string;
  partialFailures?: GroupFailure[];
}

/**
 * Per-MX-group delivery failure surfaced to the queue. Carries the
 * recipient addresses so the queue can decide per-recipient outcomes
 * (auto-suppress on inline 5xx, log on transient, etc.) instead of
 * having to reverse-lookup which recipient was on which MX.
 */
export interface GroupFailure {
  mxHost: string;
  /** Addresses we attempted RCPT TO for in this group's envelope. */
  recipients: string[];
  /** Raw error message from nodemailer / DNS — same string format the
   *  existing `parseSmtpError` already understands. */
  error: string;
}

/** DKIM signing options passed from the queue processor. */
export interface DkimOptions {
  domainName: string;
  keySelector: string;
  privateKey: string;
}

/**
 * Inputs for the `List-Unsubscribe` header. Both fields optional —
 * the mailer always emits at least the mailto form (defaulting to
 * `unsubscribe@<from-domain>` when `mailto` is omitted), and adds
 * the HTTPS / `List-Unsubscribe-Post: One-Click` form whenever a
 * URL is provided.
 *
 * Per Gmail's Feb-2024 sender requirements every transactional /
 * promotional message benefits from a List-Unsubscribe header even
 * when the recipient doesn't realistically need to unsubscribe —
 * its presence is a positive ranking signal.
 */
export interface UnsubscribeOptions {
  /** Defaults to `unsubscribe@<from-domain>` if not set. */
  mailto?: string;
  /** RFC 8058 one-click endpoint. When set, also emits the One-Click POST header. */
  url?: string;
}

/**
 * Resolves the MX server for a single domain and returns the
 * lowest-priority (highest preference) mail exchange host. Used by
 * {@link groupByMx} to bucket recipients per destination.
 */
async function resolveMxForDomain(domain: string): Promise<string> {
  const records = await resolveMx(domain);
  if (!records || records.length === 0) {
    throw new Error(`No MX records found for domain: ${domain}`);
  }
  records.sort((a, b) => a.priority - b.priority);
  return records[0]!.exchange;
}

/**
 * Sends a single email row to its full recipient set.
 *
 * **Multi-MX flow (#87):** parses `to/cc/bcc` into recipients, groups
 * them by destination MX, opens one SMTP session per MX group, and
 * submits the *same* DKIM-signed message body to each — with
 * `envelope.to` overridden so each MX only sees RCPT TO for the
 * recipients it's actually responsible for. The `To:` / `Cc:` message
 * headers carry the original full lists so every recipient sees who
 * else is on the message; BCC recipients appear only in their MX's
 * envelope and never in headers.
 *
 * **Message-ID:** generated once up-front (`<hex@hostname>`) and
 * pinned to all groups so the canonical identifier matches across
 * deliveries — bounce/complaint correlation depends on this.
 *
 * **Partial failure (Phase 1 of #87):** when some groups deliver and
 * others fail, the email row is still marked `sent` and
 * `partialFailures` is returned so the queue can fire per-recipient
 * `email.bounced` events / auto-suppress on hard 5xx. Per-group retry
 * is **not** done in this phase — a retry of a partially-failed row
 * would re-send to the groups that already succeeded, causing
 * duplicates. Tracked separately by the Phase-2 follow-up.
 *
 * **Full failure:** if every group fails, we throw the first error
 * verbatim. The queue's `handleSendFailure` classifies it as inline
 * 5xx (auto-suppress) vs transient (retry), exactly as in the
 * pre-#87 single-MX flow.
 */
export async function sendMail(options: {
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
}): Promise<SendMailResult> {
  const recipients = parseRecipients(options.to, options.cc, options.bcc);
  if (recipients.length === 0) {
    throw new Error("No valid recipients after parsing to/cc/bcc");
  }

  const { groups, failures: dnsFailures } = await groupByMx(
    recipients,
    resolveMxForDomain,
  );

  /** Pre-generate the canonical Message-ID. Same string is pinned on
   *  every MX group's submission so the message is identifiable as a
   *  single logical email across all delivery paths. */
  const messageId = `<${randomBytes(16).toString("hex")}@${config.mail.hostname}>`;

  logger.info("Sending email via SMTP", {
    from: redactEmail(options.from),
    recipientCount: recipients.length,
    groupCount: groups.size,
    dnsFailures: dnsFailures.length,
    subject: options.subject,
    dkim: options.dkim ? options.dkim.domainName : "none",
    messageId,
  });

  /**
   * Pre-populate the failures list with DNS-resolution failures —
   * recipients on domains without an MX record are unreachable at
   * the SMTP layer entirely, so they're reported alongside transport
   * failures. The synthetic `mxHost` marks them as DNS-tier so
   * downstream classification ({@link handleSendFailure}) can choose
   * to treat them differently if needed.
   */
  const failures: GroupFailure[] = dnsFailures.map((d) => ({
    mxHost: `<dns:${d.domain}>`,
    recipients: d.recipients.map((r) => r.address),
    error: d.error,
  }));
  let successCount = 0;

  for (const [mxHost, groupRecipients] of groups) {
    try {
      await sendToMxGroup({
        mxHost,
        groupRecipients,
        from: options.from,
        headerTo: options.to,
        headerCc: options.cc ?? null,
        subject: options.subject,
        html: options.html ?? null,
        text: options.text ?? null,
        messageId,
        dkim: options.dkim,
        unsubscribe: options.unsubscribe,
      });
      successCount++;
      logger.info("MX group delivered", {
        mxHost,
        recipientCount: groupRecipients.length,
        messageId,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failures.push({
        mxHost,
        recipients: groupRecipients.map((r) => r.address),
        error,
      });
      logger.warn("MX group send failed", {
        mxHost,
        recipientCount: groupRecipients.length,
        error,
        messageId,
      });
    }
  }

  if (successCount === 0) {
    /** Full failure — throw the first concrete error so the existing
     *  {@link handleSendFailure} path sees a normal `sendMail` rejection
     *  and applies retry / auto-suppress as it always has. */
    const first = failures[0];
    throw first
      ? new Error(first.error)
      : new Error("All MX groups failed with no recorded error");
  }

  if (failures.length > 0) {
    logger.warn("Multi-MX partial delivery", {
      messageId,
      successCount,
      failureCount: failures.length,
      failedRecipients: failures.flatMap((f) => f.recipients).map(redactEmail),
    });
  }

  return {
    messageId,
    ...(failures.length > 0 ? { partialFailures: failures } : {}),
  };
}

/**
 * Submits the message to a single destination MX. The transport is
 * built per-call (we always want the right MX for the right group,
 * never a stale pooled connection to a different host) and the
 * `envelope.to` override pins RCPT TO to *only* the recipients on
 * this MX — even when `mailOptions.to` lists the full original set.
 * That's the trick that makes cross-domain CC visible to all
 * recipients without delivering to the wrong server.
 */
async function sendToMxGroup(args: {
  mxHost: string;
  groupRecipients: Recipient[];
  from: string;
  /** Original `to` field — used verbatim for the `To:` header so every
   *  recipient sees the full visible recipient list. */
  headerTo: string;
  /** Original `cc` field. Same visibility rule as `headerTo`. */
  headerCc: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  messageId: string;
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
}): Promise<void> {
  /**
   * Transport configuration is identical to the pre-#87 single-MX
   * flow — port 25, opportunistic TLS, relaxed cert validation. See
   * the original commentary in this file's history for the rationale
   * (MTA-to-MTA delivery routinely hits self-signed certs).
   */
  const transport = nodemailer.createTransport({
    host: args.mxHost,
    port: 25,
    secure: false,
    opportunisticTLS: true,
    name: config.mail.hostname,
    tls: {
      rejectUnauthorized: false,
    },
  });

  const mailOptions: Mail.Options = {
    from: args.from,
    /** Headers carry the *original* recipient lists so each recipient
     *  sees who else was addressed. The actual RCPT TO list is the
     *  envelope override below. */
    to: args.headerTo,
    cc: args.headerCc ?? undefined,
    subject: args.subject,
    html: args.html ?? undefined,
    text: args.text ?? undefined,
    messageId: args.messageId,
    /**
     * Envelope override — what actually goes on the wire. Includes
     * every recipient on this MX regardless of original kind (to/cc/bcc),
     * which means BCC addresses still get delivered but never appear
     * in the rendered message headers (since they're not in `to`/`cc`
     * above).
     */
    envelope: {
      from: args.from,
      to: args.groupRecipients.map((r) => r.address),
    },
  };

  /**
   * Build `List-Unsubscribe` (and optionally `List-Unsubscribe-Post`)
   * per RFC 2369 + RFC 8058. Identical content per group — the header
   * is about the message, not the recipient set.
   */
  const senderDomain = args.from.split("@")[1];
  if (senderDomain) {
    const mailto = args.unsubscribe?.mailto ?? `unsubscribe@${senderDomain}`;
    const url = args.unsubscribe?.url;
    const headerValue = url ? `<mailto:${mailto}>, <${url}>` : `<mailto:${mailto}>`;
    mailOptions.headers = {
      "List-Unsubscribe": headerValue,
      ...(url && { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }),
    };
  }

  if (args.dkim) {
    mailOptions.dkim = {
      domainName: args.dkim.domainName,
      keySelector: args.dkim.keySelector,
      privateKey: args.dkim.privateKey,
    };
  }

  /**
   * Throttle per-MX (#91). Keeps strict receivers from `421`-ing
   * parallel sessions from our source IP — and lets two different
   * groups on different MXs proceed in parallel since their locks
   * are disjoint.
   */
  await withMxLock(args.mxHost, config.mail.mxConcurrency, () =>
    transport.sendMail(mailOptions),
  );
}
