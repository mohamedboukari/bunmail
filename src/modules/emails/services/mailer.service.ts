import { createTransport } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import { resolveMx } from "dns/promises";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { redactEmail, redactEmailsInText } from "../../../utils/redact.ts";
import { withMxLock } from "../../../utils/mx-throttle.ts";
import { parseRecipients, groupByMx } from "../../../utils/recipients.ts";
import { classifySendFailure } from "../../../utils/smtp-error.ts";
import { resolveMxAddress } from "./mx-address.ts";
import { filterCustomHeaders } from "./custom-headers.ts";
import type {
  CustomHeaders,
  DeliveryGroup,
  DeliveryState,
} from "../models/email.schema.ts";

/**
 * Result of a `sendMail` call. The `messageId` is the canonical
 * `Message-ID:` header: set by the caller (queue), pinned to every
 * MX group's submission, and preserved across retries so feedback
 * loops join on a single identifier.
 *
 * `deliveryState` is the per-group outcome map (#97). The mailer
 * doesn't decide whether to schedule another retry: that's the
 * queue's call. The mailer just reports what each group's status is
 * **after this attempt** so the queue can apply its retry policy.
 */
export interface SendMailResult {
  messageId: string;
  deliveryState: DeliveryState;
}

/**
 * Headers covered by the DKIM signature. Setting `headerFieldNames`
 * replaces nodemailer's default list, so the defaults are restated, plus
 * `List-Unsubscribe-Post` (RFC 8058 requires it to be signed for one-click
 * unsubscribe, which Gmail and Yahoo rely on) and `Feedback-ID`. Listing a
 * header that a message doesn't have costs nothing.
 */
export const DKIM_SIGNED_HEADERS = [
  "From",
  "Sender",
  "Reply-To",
  "Subject",
  "Date",
  "Message-ID",
  "To",
  "Cc",
  "MIME-Version",
  "Content-Type",
  "Content-Transfer-Encoding",
  "Content-ID",
  "Content-Description",
  "Resent-Date",
  "Resent-From",
  "Resent-Sender",
  "Resent-To",
  "Resent-Cc",
  "Resent-Message-ID",
  "In-Reply-To",
  "References",
  "List-Id",
  "List-Help",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-Subscribe",
  "List-Post",
  "List-Owner",
  "List-Archive",
  "Feedback-ID",
].join(":");

/** DKIM signing options passed from the queue processor. */
export interface DkimOptions {
  domainName: string;
  keySelector: string;
  privateKey: string;
}

/**
 * Inputs for the `List-Unsubscribe` header. Both fields optional:
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
 * already in `sent` status**, so a Gmail group that succeeded on
 * attempt 1 never gets a duplicate on attempt 2 when an Outlook group
 * 4xx-retries. Returns a fresh `DeliveryState` reflecting every
 * group's outcome **after this attempt**. The queue decides whether
 * to schedule another pass based on the returned state vs its own
 * retry policy.
 *
 * **Status semantics:**
 *   - `sent`: accepted by the receiving MX this attempt. Won't be retried.
 *   - `retry`: transient failure (4xx, transport timeout, …). Queue may retry.
 *   - `failed`: hard 5xx rejection. Terminal; auto-suppress fires in queue.
 *
 * **First-send vs retry:** on first send (`existingState` undefined),
 * the mailer parses `to/cc/bcc`, groups by destination MX, and starts
 * every group in `retry` before attempting. DNS resolution failures
 * become synthetic-key (`<dns:domain>`) entries in `failed` state:
 * a missing MX is an unrecoverable address problem, not a transient
 * one worth retrying.
 *
 * **Identity:** the caller passes `messageId` so the canonical
 * `Message-ID:` header is pinned across retries. Previously the
 * mailer minted it itself, which would have produced fresh ids per
 * retry: bounce / complaint correlation breaks down without a
 * stable identifier.
 */
export async function sendMail(options: {
  from: string;
  to: string;
  cc?: string | null;
  bcc?: string | null;
  /** Reply-To header (#169). Same on every MX group; not part of the envelope. */
  replyTo?: string | null;
  subject: string;
  html?: string | null;
  text?: string | null;
  /** Canonical Message-ID, set by the caller so retries reuse it. */
  messageId: string;
  /**
   * Custom headers stored on the email (#177). Re-checked here (see
   * {@link safeCustomHeaders}) so a row that bypassed `createEmail` can
   * never override BunMail's own headers or split a header line.
   */
  headers?: CustomHeaders | null;
  /** Prior delivery state when this is a retry pass; undefined on first send. */
  existingState?: DeliveryState | null;
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
  /**
   * Who the mail is sent for, for the `Feedback-ID` header (#250). Typed,
   * never caller-supplied text: BunMail builds the header itself.
   */
  feedback?: FeedbackSource;
  /**
   * BunMail's own automatic mail (inbound notifications, invitations,
   * sign-in alerts): adds `Auto-Submitted: auto-generated` and
   * `X-Auto-Response-Suppress: All` so auto-responders don't reply (#250).
   */
  autoSubmitted?: boolean;
}): Promise<SendMailResult> {
  /** Build the starting state: either a fresh one from the inputs
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
     *  programmer error: the caller shouldn't have reached this code
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

  const customHeaders = safeCustomHeaders(options.headers, options.messageId);

  /** Attempt every group still in `retry` state. Order is insertion-
   *  order, which keeps logs stable across runs even if Maps were
   *  rebuilt from JSONB. */
  for (const [mxHost, group] of Object.entries(state)) {
    if (group.status !== "retry") continue;
    if (mxHost.startsWith("<dns:"))
      continue; /** DNS failures don't retry: marked failed at parse time. */

    try {
      await sendToMxGroup({
        mxHost,
        recipients: group.recipients,
        from: options.from,
        headerTo: options.to,
        headerCc: options.cc ?? null,
        replyTo: options.replyTo ?? null,
        subject: options.subject,
        html: options.html ?? null,
        text: options.text ?? null,
        messageId: options.messageId,
        headers: customHeaders,
        dkim: options.dkim,
        unsubscribe: options.unsubscribe,
        feedback: options.feedback,
        autoSubmitted: options.autoSubmitted === true,
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
      /** Hard 5xx and policy blocks → terminal `failed` (a block won't
       *  clear within the retry window). Soft errors (4xx, transport)
       *  stay `retry` and follow the queue's backoff. */
      /** From the SMTP reply only, never from a transport error's text (#250). */
      const parsed = classifySendFailure(err);
      const nextStatus: DeliveryGroup["status"] =
        parsed?.kind === "hard" || parsed?.kind === "policy" ? "failed" : "retry";
      state[mxHost] = {
        ...group,
        status: nextStatus,
        attempts: group.attempts + 1,
        lastError: error,
        ...(parsed ? { failureKind: parsed.kind, failureCode: parsed.code } : {}),
        ...(parsed?.kind === "policy" ? { blocked: true } : {}),
      };
      logger.warn("MX group send failed", {
        mxHost,
        recipientCount: group.recipients.length,
        nextStatus,
        /** The remote reply often quotes the recipient address (#260). */
        error: redactEmailsInText(error),
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
 * synthetic-key (`<dns:domain>`) entries already in `failed` state:
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
     *  delivery state for operator visibility, but they're already
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

/** Everything one MX group's message is built from. */
interface MxGroupMessage {
  /** RCPT TO for this group only. */
  recipients: string[];
  from: string;
  headerTo: string;
  headerCc: string | null;
  replyTo: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  messageId: string;
  /** Custom headers (#177), already passed through {@link safeCustomHeaders}. */
  headers: CustomHeaders;
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
  /** For the `Feedback-ID` header (#250). */
  feedback?: FeedbackSource;
  /** BunMail's own automatic mail: `Auto-Submitted` and friends (#250). */
  autoSubmitted?: boolean;
}

/** What a `Feedback-ID` header identifies (#250). */
export interface FeedbackSource {
  /** How the mail entered BunMail: `api`, `smtp` or `system`. */
  source: "api" | "smtp" | "system";
  /** The sending API key; `null` for BunMail's own mail. */
  apiKeyId: string | null;
}

/** Keeps a `Feedback-ID` field to safe characters (it is a header value). */
function feedbackField(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64) || "none";
}

/**
 * `Feedback-ID: <source>:<key>:<sender domain>:bunmail` (#250): Gmail's
 * feedback loop aggregates complaints by it. Low cardinality on purpose
 * (no per-message id, which would defeat the aggregation). The API key
 * id goes in hashed, so recipients see a stable per-tenant value but no
 * internal identifier. The id is not a secret, so a fast deterministic
 * non-cryptographic hash (`Bun.hash`, wyhash) is all this tag needs.
 */
export function feedbackIdHeader(feedback: FeedbackSource, senderDomain: string): string {
  const key = feedback.apiKeyId
    ? Bun.hash(feedback.apiKeyId).toString(16).padStart(16, "0").slice(0, 12)
    : "system";
  return [feedback.source, key, senderDomain, "bunmail"].map(feedbackField).join(":");
}

/**
 * Re-applies the custom-header rules (#177) to the headers stored on a
 * row: the send API already refused anything invalid, so this only drops
 * something when a row was written another way (a manual insert, a future
 * bug). It is what guarantees a custom header never overrides
 * `Message-ID`, `List-Unsubscribe` or any other reserved header, whatever
 * its case. Logs the dropped names only, never values.
 */
function safeCustomHeaders(
  headers: CustomHeaders | null | undefined,
  messageId: string,
): CustomHeaders {
  if (!headers) return {};
  const { headers: kept, dropped } = filterCustomHeaders(Object.entries(headers));
  if (dropped.length > 0) {
    logger.warn("Stored custom headers dropped before sending", {
      messageId,
      dropped: dropped.map((d) => ({ name: d.name, problem: d.problem })),
    });
  }
  return kept;
}

/**
 * Builds the Nodemailer options for one MX group's message: headers,
 * envelope, the custom headers (#177), `List-Unsubscribe`, DKIM. Pure, so
 * tests can render the exact message with a stream transport.
 */
export function buildMailOptions(args: MxGroupMessage): Mail.Options {
  const mailOptions: Mail.Options = {
    from: args.from,
    /** Headers carry the *original* recipient lists so each recipient
     *  sees who else was addressed. The actual RCPT TO list is the
     *  envelope override below. */
    to: args.headerTo,
    cc: args.headerCc ?? undefined,
    replyTo: args.replyTo ?? undefined,
    subject: args.subject,
    html: args.html ?? undefined,
    text: args.text ?? undefined,
    messageId: args.messageId,
    envelope: {
      from: args.from,
      to: args.recipients,
    },
  };

  /**
   * Extra headers: the custom ones (#177) first, then BunMail's own
   * `List-Unsubscribe` pair, which is written last so it wins on the same
   * key. The reserved-name filter already keeps every name BunMail sets
   * (in any case) out of the custom set, and Nodemailer's own options
   * (`messageId`, `from`, ...) take precedence over `headers` anyway.
   */
  const headers: Record<string, string> = { ...args.headers };

  /** `List-Unsubscribe` (+ optional `One-Click` POST). Same content
   *  across groups: the header is about the message, not the
   *  recipient set. */
  const senderDomain = args.from.split("@")[1];
  if (senderDomain) {
    /**
     * Strip any CR/LF from the unsubscribe mailto/url before they go into a
     * header value (#133, header-injection defense-in-depth). These come
     * from the operator-set domain record, so this is belt-and-braces, but
     * a stray newline must never split the header.
     */
    const stripCrlf = (v: string): string => v.replace(/[\r\n]/g, "");
    const mailto = stripCrlf(args.unsubscribe?.mailto ?? `unsubscribe@${senderDomain}`);
    const url = args.unsubscribe?.url ? stripCrlf(args.unsubscribe.url) : undefined;
    const headerValue = url ? `<mailto:${mailto}>, <${url}>` : `<mailto:${mailto}>`;
    headers["List-Unsubscribe"] = headerValue;
    if (url) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
    if (args.feedback)
      headers["Feedback-ID"] = feedbackIdHeader(args.feedback, senderDomain);
  }
  if (args.autoSubmitted) {
    headers["Auto-Submitted"] = "auto-generated";
    headers["X-Auto-Response-Suppress"] = "All";
  }
  if (Object.keys(headers).length > 0) mailOptions.headers = headers;

  if (args.dkim) {
    mailOptions.dkim = {
      domainName: args.dkim.domainName,
      keySelector: args.dkim.keySelector,
      privateKey: args.dkim.privateKey,
      headerFieldNames: DKIM_SIGNED_HEADERS,
    };
  }

  return mailOptions;
}

/**
 * Submits the message to a single destination MX. The transport is
 * built per-call (we always want the right MX for the right group)
 * and the `envelope.to` override pins RCPT TO to *only* the
 * recipients on this MX, even when `mailOptions.to` lists the full
 * original set. That's the trick that makes cross-domain CC visible
 * to all recipients without delivering to the wrong server.
 */
async function sendToMxGroup(args: MxGroupMessage & { mxHost: string }): Promise<void> {
  /**
   * Connect to a checked address, not the name: the name's DNS answer is
   * controlled by whoever owns the recipient domain, and resolving it
   * again in nodemailer would let it change after the check. The MX name
   * still goes to TLS as SNI.
   */
  const address = await resolveMxAddress(args.mxHost, {
    allowPrivate: config.mail.allowPrivateMx,
  });
  const transport = createTransport({
    host: address,
    port: 25,
    secure: false,
    opportunisticTLS: true,
    name: config.mail.hostname,
    /**
     * Setup timeouts are 60 s (#250): connecting and the greeting come
     * before anything is sent, so a dead or tarpitting MX gives up its MX
     * lock quickly. The socket inactivity timeout stays at nodemailer's
     * 10 minutes: RFC 5321 4.5.3.2 has the client wait that long for the
     * reply to the final `.` of DATA, and a shorter one risks a retry and
     * a duplicate. The whole session is capped by {@link sendWithDeadline}.
     */
    connectionTimeout: SMTP_SETUP_TIMEOUT_MS,
    greetingTimeout: SMTP_SETUP_TIMEOUT_MS,
    tls: {
      rejectUnauthorized: false,
      servername: args.mxHost,
    },
  });

  const mailOptions = buildMailOptions(args);

  /** Per-MX throttle (#91). Disjoint locks across MXs run in parallel. */
  await withMxLock(args.mxHost, config.mail.mxConcurrency, () =>
    sendWithDeadline(transport, mailOptions, SMTP_SESSION_DEADLINE_MS),
  );
}

/** Connect and greeting timeout for outbound SMTP (#250). */
const SMTP_SETUP_TIMEOUT_MS = 60_000;

/**
 * Longest one outbound SMTP session may take (#250). Every step has its
 * own timeout, but a peer that keeps answering slowly could still hold
 * the MX lock for hours; this caps the whole attempt.
 */
const SMTP_SESSION_DEADLINE_MS = 20 * 60_000;

/** The part of a Nodemailer transport {@link sendWithDeadline} uses. */
interface ClosableTransport {
  sendMail(options: Mail.Options): Promise<unknown>;
  close(): void;
}

/**
 * Sends with an overall deadline (#250): past `deadlineMs` the transport
 * is closed and the attempt fails with a plain error, which carries no
 * SMTP reply and is therefore retried later, not treated as a bounce.
 */
export async function sendWithDeadline(
  transport: ClosableTransport,
  options: Mail.Options,
  deadlineMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      transport.close();
      reject(
        new Error(
          `SMTP session exceeded ${Math.round(deadlineMs / 1000)} s and was closed`,
        ),
      );
    }, deadlineMs);
  });
  try {
    await Promise.race([transport.sendMail(options), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
