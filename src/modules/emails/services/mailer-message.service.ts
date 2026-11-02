import type Mail from "nodemailer/lib/mailer";
import { logger } from "../../../utils/logger.ts";
import { filterCustomHeaders } from "./custom-headers.ts";
import type { CustomHeaders } from "../models/email.schema.ts";
import type { EmailCategory } from "../types/email.types.ts";

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

/**
 * One attachment as the mailer sends it (#181): already checked, typed
 * from its bytes (`services/attachments.ts`) and loaded by the queue.
 */
export interface OutboundAttachment {
  filename: string;
  /** The derived Content-Type, never a declared one. */
  contentType: string;
  /** Content-ID of an inline image (`cid:` in the HTML), else `null`. */
  contentId: string | null;
  content: Uint8Array;
}

/** DKIM signing options passed from the queue processor. */
export interface DkimOptions {
  domainName: string;
  keySelector: string;
  privateKey: string;
}

/**
 * Inputs for the `List-Unsubscribe` header. Both fields optional:
 * the mailer emits the mailto form (defaulting to
 * `unsubscribe@<from-domain>` when `mailto` is omitted, left out when it
 * is `null`), and adds the HTTPS / `List-Unsubscribe-Post: One-Click`
 * form whenever a URL is provided. The queue builds them per email
 * (`list-unsubscribe.ts`, #249).
 */
export interface UnsubscribeOptions {
  /** `null`: no mailto form (only valid together with `url`). */
  mailto?: string | null;
  url?: string;
}

/** Everything one MX group's message is built from. */
export interface MxGroupMessage {
  /** RCPT TO for this group only. */
  recipients: string[];
  from: string;
  /** Display name of the `From:` header (#250); the address is always `from`. */
  fromName?: string | null;
  /**
   * `MAIL FROM` of this transaction: the recipient's signed return path
   * (#236). Defaults to `from`. The `From:` header is always `from`.
   */
  envelopeFrom?: string;
  headerTo: string;
  headerCc: string | null;
  replyTo: string | null;
  subject: string;
  html: string | null;
  text: string | null;
  messageId: string;
  /** Custom headers (#177), already passed through {@link safeCustomHeaders}. */
  headers: CustomHeaders;
  /** Attachments (#181); absent or empty for a message without any. */
  attachments?: readonly OutboundAttachment[];
  dkim?: DkimOptions;
  unsubscribe?: UnsubscribeOptions;
  /** For the `Feedback-ID` header (#250). */
  feedback?: FeedbackSource;
  /** BunMail's own automatic mail: `Auto-Submitted` and friends (#250). */
  autoSubmitted?: boolean;
  /** `transactional`: no `List-Unsubscribe` (#250). */
  category?: EmailCategory | null;
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
export function safeCustomHeaders(
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
 * Whether a message carries `List-Unsubscribe` (#250): not when it is
 * `transactional`, and never on BunMail's own automatic mail (invitations,
 * alerts, inbound notifications), which nobody subscribed to.
 */
export function carriesListUnsubscribe(
  args: Pick<MxGroupMessage, "category" | "autoSubmitted">,
): boolean {
  return args.category !== "transactional" && args.autoSubmitted !== true;
}

/**
 * Builds the Nodemailer options for one MX group's message: headers,
 * envelope, the custom headers (#177), `List-Unsubscribe`, DKIM. The body
 * is used as given: `sendMail` composes it first ({@link composeMessageBody}).
 * Pure, so tests can render the exact message with a stream transport.
 */
export function buildMailOptions(args: MxGroupMessage): Mail.Options {
  const mailOptions: Mail.Options = {
    /**
     * With a display name (#250), Nodemailer quotes it and RFC 2047-encodes
     * it when it is not ASCII. The address, and the envelope below, stay
     * the bare `from`.
     */
    from: args.fromName ? { name: args.fromName, address: args.from } : args.from,
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
      from: args.envelopeFrom ?? args.from,
      to: args.recipients,
    },
    /**
     * Nothing in a message may make Nodemailer read a file or fetch a URL
     * (a `path` or `href` content): every part BunMail builds is inline
     * data. Defense in depth for the attachments (#181).
     */
    disableFileAccess: true,
    disableUrlAccess: true,
  };

  /**
   * Attachments (#181), each with its derived type. One with a Content-ID
   * is an inline part beside the HTML (Nodemailer moves it into the
   * `multipart/related` node, and the HTML's `cid:` references are left as
   * they are); every other one is `Content-Disposition: attachment`. The
   * filename is RFC 2231 encoded by Nodemailer when it is not ASCII.
   */
  if (args.attachments && args.attachments.length > 0) {
    mailOptions.attachments = args.attachments.map((a) => ({
      filename: a.filename,
      content: Buffer.from(a.content.buffer, a.content.byteOffset, a.content.byteLength),
      contentType: a.contentType,
      ...(a.contentId === null
        ? { contentDisposition: "attachment" }
        : { cid: a.contentId, contentDisposition: "inline" }),
    }));
  }

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
  if (senderDomain && carriesListUnsubscribe(args)) {
    /**
     * Strip any CR/LF from the unsubscribe mailto/url before they go into a
     * header value (#133, header-injection defense-in-depth). These come
     * from the operator-set domain record, so this is belt-and-braces, but
     * a stray newline must never split the header.
     */
    const stripCrlf = (v: string): string => v.replace(/[\r\n]/g, "");
    const url = args.unsubscribe?.url ? stripCrlf(args.unsubscribe.url) : undefined;
    /** No mailto only when asked for and a URL is there: the header is never empty. */
    const mailto =
      args.unsubscribe?.mailto === null && url
        ? null
        : stripCrlf(args.unsubscribe?.mailto ?? `unsubscribe@${senderDomain}`);
    headers["List-Unsubscribe"] = [
      ...(mailto === null ? [] : [`<mailto:${mailto}>`]),
      ...(url ? [`<${url}>`] : []),
    ].join(", ");
    if (url) headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }
  if (senderDomain && args.feedback) {
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
