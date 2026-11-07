import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import { logger } from "../../../utils/logger.ts";
import { filterCustomHeaders } from "./custom-headers.ts";
import { DkimSignError, dkimSignMessage } from "./dkim-signer.service.ts";
import type { CustomHeaders } from "../models/email.schema.ts";
import type { EmailCategory } from "../types/email.types.ts";

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
 * envelope, the custom headers (#177), `List-Unsubscribe`. The body is used
 * as given: `sendMail` composes it first ({@link composeMessageBody}). Never
 * DKIM: {@link signMessage} signs (#345). Pure, so tests can
 * render the exact message with a stream transport.
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

  return mailOptions;
}

/** The parts of a message that are the same in every transaction of a session. */
export type MessageParts = Omit<MxGroupMessage, "recipients" | "envelopeFrom">;

/** One transaction's envelope: its `RCPT TO` and its `MAIL FROM`. */
export interface TransactionEnvelope {
  recipients: string[];
  envelopeFrom: string;
}

/**
 * What can be logged of a compose or signing failure: the signer's own fixed
 * text, else the error's name and code only (a `node:crypto` or Nodemailer
 * message may quote input).
 */
function failureDetail(err: unknown): Record<string, string> {
  if (err instanceof DkimSignError) return { reason: err.message };
  if (!(err instanceof Error)) return { errorName: typeof err };
  const code: unknown = Reflect.get(err, "code");
  return typeof code === "string"
    ? { errorName: err.name, errorCode: code }
    : { errorName: err.name };
}

/**
 * A message that has a DKIM key the signer cannot use (#345): the key does
 * not parse, is of another type than RSA or ed25519, or the domain or
 * selector is invalid. Thrown by {@link signMessage} before anything is
 * sent: such a message is never sent unsigned. The queue holds the email on
 * the retry backoff, as for a key that does not decrypt (#244); mail sent
 * outside the queue reports it as a failed send. Also thrown by
 * {@link buildTransactionMails} when asked for unsigned options of a message
 * that has a key. The message is fixed text with the domain, safe to log.
 */
export class DkimSigningFailedError extends Error {
  override name = "DkimSigningFailedError";
  readonly domain: string;

  constructor(domain: string) {
    super(`DKIM key for ${domain} cannot be used to sign: not sent unsigned`);
    this.domain = domain;
  }
}

/**
 * What {@link signMessage} made of a message: `unsigned` (no DKIM key, sent
 * as before), `signed` (the bytes to send), or `uncomposable` (the message
 * itself could not be built, key or not: reported per transaction as
 * Nodemailer would, see `mailer-delivery.service.ts`).
 */
export type SignedMessage =
  | { kind: "unsigned" }
  | { kind: "signed"; raw: Buffer }
  | { kind: "uncomposable"; error: unknown };

/**
 * Composes and signs a message once (#345). The message is composed by
 * Nodemailer's own `MailComposer` from the options {@link buildMailOptions}
 * builds, so headers, body, attachments, `List-Unsubscribe` and
 * `Feedback-ID` are exactly what Nodemailer would send, then signed by
 * {@link dkimSignMessage} (over-signed headers).
 *
 * Composing and signing fail apart. A message that cannot be composed is
 * `uncomposable`, logged on its own (`Message could not be composed`): it
 * fails as it would without a key, never as a DKIM problem. A key that
 * cannot sign throws {@link DkimSigningFailedError}, after logging
 * `DKIM signing failed` at `error` with the domain, selector and the
 * error's name and code (never the key): the caller must not send.
 */
export async function signMessage(message: MessageParts): Promise<SignedMessage> {
  const dkim = message.dkim;
  if (!dkim) return { kind: "unsigned" };
  let composed: Buffer;
  try {
    composed = await new MailComposer(buildMailOptions({ ...message, recipients: [] }))
      .compile()
      .build();
  } catch (error) {
    logger.error("Message could not be composed", {
      messageId: message.messageId,
      ...failureDetail(error),
    });
    return { kind: "uncomposable", error };
  }
  let raw: Buffer;
  try {
    raw = dkimSignMessage(composed, dkim);
  } catch (err) {
    logger.error("DKIM signing failed: not sent unsigned", {
      messageId: message.messageId,
      domain: dkim.domainName,
      selector: dkim.keySelector,
      ...failureDetail(err),
    });
    throw new DkimSigningFailedError(dkim.domainName);
  }
  logger.debug("Message DKIM-signed", {
    messageId: message.messageId,
    domain: dkim.domainName,
    selector: dkim.keySelector,
    bytes: raw.byteLength,
  });
  return { kind: "signed", raw };
}

/**
 * Each transaction of one message with its Nodemailer options (`mail`), in
 * the order given. With `signed` (from {@link signMessage}): every
 * transaction gets those bytes as `raw`, which Nodemailer sends unchanged,
 * with only the transaction's envelope beside them, so all transactions
 * carry the same signed message. With `null`: {@link buildMailOptions} per
 * transaction, as before, only for a message without a DKIM key; a message
 * with one throws {@link DkimSigningFailedError}, so no caller can send it
 * unsigned.
 */
export function buildTransactionMails<T extends TransactionEnvelope>(
  message: MessageParts,
  signed: Buffer | null,
  transactions: readonly T[],
): Array<T & { mail: Mail.Options }> {
  if (signed === null) {
    if (message.dkim) throw new DkimSigningFailedError(message.dkim.domainName);
    return transactions.map((transaction) => ({
      ...transaction,
      mail: buildMailOptions({
        ...message,
        recipients: transaction.recipients,
        envelopeFrom: transaction.envelopeFrom,
      }),
    }));
  }
  return transactions.map((transaction) => ({
    ...transaction,
    mail: {
      envelope: { from: transaction.envelopeFrom, to: transaction.recipients },
      raw: signed,
      /** Nothing to read, but the same sandbox as an unsigned message. */
      disableFileAccess: true,
      disableUrlAccess: true,
    },
  }));
}
