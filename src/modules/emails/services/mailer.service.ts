import nodemailer from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { resolveMx } from "dns/promises";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail } from "../../../utils/redact.ts";
import { withMxLock } from "../../../utils/mx-throttle.ts";
import { parseRecipients, groupByMx } from "../../../utils/recipients.ts";
import { parseSmtpError } from "../../../utils/smtp-error.ts";
import type { DeliveryGroup, DeliveryState } from "../models/email.schema.ts";

/**
 * Result of a `sendMail` call. The `messageId` is the canonical
 * `Message-ID:` header — set by the caller (queue), pinned to every
 * MX group's submission, and preserved across retries so feedback
 * loops join on a single identifier.
 *
 * `deliveryState` is the per-group outcome map (#97). The mailer
 * doesn't decide whether to schedule another retry — that's the
 * queue's call. The mailer just reports what each group's status is
 * **after this attempt** so the queue can apply its retry policy.
 */
export interface SendMailResult {
  messageId: string;
  deliveryState: DeliveryState;
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
 */
export interface UnsubscribeOptions {
  mailto?: string;
  url?: string;
}

/**
 * Resolves the MX server for a single domain and returns the
 * lowest-priority (highest preference) mail exchange host.
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
 * **Stateful retry (#97):** the mailer reads `existingState` when
 * provided (set by the queue on retry passes) and **skips every group
 * already in `sent` status** — so a Gmail group that succeeded on
 * attempt 1 never gets a duplicate on attempt 2 when an Outlook group
 * 4xx-retries. Returns a fresh `DeliveryState` reflecting every
 * group's outcome **after this attempt**. The queue decides whether
 * to schedule another pass based on the returned state vs its own
 * retry policy.
 *
 * **Status semantics:**
 *   - `sent`   — accepted by the receiving MX this attempt. Won't be retried.
 *   - `retry`  — transient failure (4xx, transport timeout, …). Queue may retry.
 *   - `failed` — hard 5xx rejection. Terminal; auto-suppress fires in queue.
 *
 * **First-send vs retry:** on first send (`existingState` undefined),
 * the mailer parses `to/cc/bcc`, groups by destination MX, and starts
 * every group in `retry` before attempting. DNS resolution failures
 * become synthetic-key (`<dns:domain>`) entries in `failed` state —
 * a missing MX is an unrecoverable address problem, not a transient
 * one worth retrying.
 *
 * **Identity:** the caller passes `messageId` so the canonical
 * `Message-ID:` header is pinned across retries. Previously the
 * mailer minted it itself, which would have produced fresh ids per
 * retry — bounce / complaint correlation breaks down without a
 * stable identifier.
 */
export async function sendMail(options: {
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  /** Canonical Message-ID, set by the caller so retries reuse it. */
  messageId: string;
  /** Prior delivery state when this is a retry pass; undefined on first send. */
  existingState?: DeliveryState | null;
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
}): Promise<SendMailResult> {
  /** Build the starting state — either a fresh one from the inputs
   *  or a deep clone of the row's prior state. We always clone so the
   *  caller can compare `before` vs `after` for change detection. */
  let state: DeliveryState;
  if (options.existingState) {
    state = structuredClone(options.existingState);
  } else {
    state = await buildInitialState(options.to, options.cc, options.bcc);
  }

  if (Object.keys(state).length === 0) {
    /** No groups at all (no valid recipients after parsing). Treat as
     *  programmer error — the caller shouldn't have reached this code
     *  path. The queue's full-failure path catches the throw. */
    throw new Error("No valid recipients after parsing to/cc/bcc");
  }

  logger.info("Sending email via SMTP", {
    from: redactEmail(options.from),
    groupCount: Object.keys(state).length,
    pendingCount: Object.values(state).filter((g) => g.status === "retry").length,
    subject: options.subject,
    dkim: options.dkim ? options.dkim.domainName : "none",
    messageId: options.messageId,
    retry: options.existingState ? "yes" : "no",
  });

  /** Attempt every group still in `retry` state. Order is insertion-
   *  order, which keeps logs stable across runs even if Maps were
   *  rebuilt from JSONB. */
  for (const [mxHost, group] of Object.entries(state)) {
    if (group.status !== "retry") continue;
    if (mxHost.startsWith("<dns:"))
      continue; /** DNS failures don't retry — marked failed at parse time. */

    try {
      await sendToMxGroup({
        mxHost,
        recipients: group.recipients,
        from: options.from,
        headerTo: options.to,
        headerCc: options.cc ?? null,
        subject: options.subject,
        html: options.html ?? null,
        text: options.text ?? null,
        messageId: options.messageId,
        dkim: options.dkim,
        unsubscribe: options.unsubscribe,
      });
      state[mxHost] = {
        ...group,
        status: "sent",
        attempts: group.attempts + 1,
        deliveredAt: new Date().toISOString(),
        messageId: options.messageId,
      };
      logger.info("MX group delivered", {
        mxHost,
        recipientCount: group.recipients.length,
        messageId: options.messageId,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      /** Hard 5xx → terminal `failed`. Soft errors (4xx, transport)
       *  stay `retry`; the queue's row-level attempts cap decides
       *  when to flip them to `failed`. */
      const parsed = parseSmtpError(error);
      const nextStatus: DeliveryGroup["status"] =
        parsed?.kind === "hard" ? "failed" : "retry";
      state[mxHost] = {
        ...group,
        status: nextStatus,
        attempts: group.attempts + 1,
        lastError: error,
      };
      logger.warn("MX group send failed", {
        mxHost,
        recipientCount: group.recipients.length,
        nextStatus,
        error,
        messageId: options.messageId,
      });
    }
  }

  return { messageId: options.messageId, deliveryState: state };
}

/**
 * Builds the initial per-MX state map for a fresh send. Parses
 * `to/cc/bcc`, groups recipients by destination MX, and seeds every
 * group at `status: "retry"` so the attempt loop above picks them up.
 * DNS-resolution failures (no MX records, lookup error) become
 * synthetic-key (`<dns:domain>`) entries already in `failed` state —
 * those addresses can't be delivered to in principle, so there's
 * nothing to retry.
 */
async function buildInitialState(
  to: string,
  cc: string | null | undefined,
  bcc: string | null | undefined,
): Promise<DeliveryState> {
  const recipients = parseRecipients(to, cc, bcc);
  if (recipients.length === 0) return {};

  const { groups, failures: dnsFailures } = await groupByMx(
    recipients,
    resolveMxForDomain,
  );

  const state: DeliveryState = {};
  for (const [mxHost, rcpts] of groups) {
    state[mxHost] = {
      status: "retry",
      recipients: rcpts.map((r) => r.address),
      attempts: 0,
    };
  }
  for (const f of dnsFailures) {
    /** Synthetic mxHost key so DNS-failed groups still show up in the
     *  delivery state for operator visibility — but they're already
     *  terminal so the retry loop above skips them. */
    state[`<dns:${f.domain}>`] = {
      status: "failed",
      recipients: f.recipients.map((r) => r.address),
      attempts: 0,
      lastError: f.error,
    };
  }
  return state;
}

/**
 * Submits the message to a single destination MX. The transport is
 * built per-call (we always want the right MX for the right group)
 * and the `envelope.to` override pins RCPT TO to *only* the
 * recipients on this MX — even when `mailOptions.to` lists the full
 * original set. That's the trick that makes cross-domain CC visible
 * to all recipients without delivering to the wrong server.
 */
async function sendToMxGroup(args: {
  mxHost: string;
  recipients: string[];
  from: string;
  headerTo: string;
  headerCc: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  messageId: string;
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
}): Promise<void> {
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
    envelope: {
      from: args.from,
      to: args.recipients,
    },
  };

  /** `List-Unsubscribe` (+ optional `One-Click` POST). Same content
   *  across groups — the header is about the message, not the
   *  recipient set. */
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

  /** Per-MX throttle (#91). Disjoint locks across MXs run in parallel. */
  await withMxLock(args.mxHost, config.mail.mxConcurrency, () =>
    transport.sendMail(mailOptions),
  );
}
