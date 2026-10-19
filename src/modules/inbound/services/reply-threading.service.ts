import { simpleParser } from "mailparser";
import { DrizzleQueryError, eq, inArray } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { emails } from "../../emails/models/email.schema.ts";
import { inboundEmails } from "../models/inbound-email.schema.ts";
import { logger } from "../../../utils/logger.ts";
import {
  buildReplyHeaders,
  joinThreadIds,
  replyCandidates,
  threadingIdsFromHeaderLines,
  type RawHeaderLine,
  type ReplyThreadingHeaders,
  type StoredThreading,
} from "./threading.ts";
import { getInboundEmailById, getTrashedInboundEmailById } from "./inbound.service.ts";
import type { InboundEmail } from "../types/inbound.types.ts";

/**
 * Threading of inbound mail and dashboard replies (#192): what the receiver
 * stores, the headers a reply carries, and the link from a received reply
 * to the email of ours it answers. The parsing rules are in `threading.ts`.
 */

/**
 * Most bytes of a stored raw message read when recovering the threading
 * ids of a row received before #192: the header section only. A header
 * section longer than this is not parsed at all.
 */
const MAX_HEADER_SECTION_BYTES = 64 * 1024;

/** The threading columns of a new `inbound_emails` row. */
export interface InboundThreadingColumns {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  inReplyToEmailId: string | null;
}

/** The email of ours an inbound message replies to, for its detail page. */
export interface RepliedEmail {
  id: string;
  subject: string;
  /** When it was sent, or queued when it never was. */
  sentAt: Date;
}

/** The Postgres SQLSTATE of a failed query, never its parameters. */
function sqlStateOf(error: unknown): string | null {
  const cause: unknown = error instanceof DrizzleQueryError ? error.cause : error;
  const code =
    typeof cause === "object" && cause !== null ? Reflect.get(cause, "errno") : undefined;
  return typeof code === "string" ? code : null;
}

/** The lowercase domain of an address, or `null` when it has none. */
function domainOf(address: string): string | null {
  const domain = address.split("@")[1]?.trim().toLowerCase();
  return domain ? domain : null;
}

/**
 * The id of the email BunMail sent that `candidates` (most direct first)
 * name by Message-ID, among emails whose sender domain is one of
 * `recipientDomains`: one tenant's inbound mail never links to another
 * tenant's outbound mail. `null` when none matches.
 */
export async function findRepliedEmailId(
  candidates: readonly string[],
  recipientDomains: ReadonlySet<string>,
): Promise<string | null> {
  if (candidates.length === 0 || recipientDomains.size === 0) return null;
  /** The queue stores `<id@host>`; older rows may hold the bare form. */
  const forms = candidates.flatMap((id) => [id, id.slice(1, -1)]);
  const rows = await db
    .select({
      id: emails.id,
      messageId: emails.messageId,
      fromAddress: emails.fromAddress,
    })
    .from(emails)
    .where(inArray(emails.messageId, forms));

  for (const candidate of candidates) {
    const bare = candidate.slice(1, -1);
    const match = rows.find((row) => {
      if (row.messageId !== candidate && row.messageId !== bare) return false;
      const sender = domainOf(row.fromAddress);
      return sender !== null && recipientDomains.has(sender);
    });
    if (match) return match.id;
  }
  return null;
}

/**
 * The threading columns of a received message, from its raw header lines,
 * and the email of ours it replies to, scoped to the domains it was
 * received for (`recipients`, the envelope recipients). A failed link
 * lookup is logged and leaves the link empty: the message is still stored.
 */
export async function threadingColumnsFor(
  headerLines: readonly RawHeaderLine[],
  recipients: readonly string[],
): Promise<InboundThreadingColumns> {
  const ids = threadingIdsFromHeaderLines(headerLines);
  const domains = new Set(
    recipients.map(domainOf).filter((domain): domain is string => domain !== null),
  );

  let inReplyToEmailId: string | null = null;
  try {
    inReplyToEmailId = await findRepliedEmailId(replyCandidates(ids), domains);
  } catch (error) {
    logger.warn("Inbound reply link lookup failed", { sqlState: sqlStateOf(error) });
  }
  if (inReplyToEmailId !== null) {
    logger.debug("Inbound email is a reply to a sent email", {
      emailId: inReplyToEmailId,
    });
  }

  return {
    messageId: ids.messageId,
    inReplyTo: joinThreadIds(ids.inReplyTo),
    references: joinThreadIds(ids.references),
    inReplyToEmailId,
  };
}

/**
 * The header section of a raw message, at most
 * {@link MAX_HEADER_SECTION_BYTES}; `null` when it is longer.
 */
function headerSectionOf(raw: string): string | null {
  const head = raw.slice(0, MAX_HEADER_SECTION_BYTES);
  const end = /\r?\n\r?\n/.exec(head);
  if (end) return head.slice(0, end.index);
  return raw.length <= MAX_HEADER_SECTION_BYTES ? raw : null;
}

/**
 * Reads the threading ids of a row received before #192 from its stored
 * raw message (header section only, through mailparser), and stores them so
 * the next reply does not parse again. Returns what was found.
 */
async function recoverThreading(inbound: InboundEmail): Promise<StoredThreading> {
  const none: StoredThreading = { messageId: null, inReplyTo: null, references: null };
  const headers =
    inbound.rawMessage === null ? null : headerSectionOf(inbound.rawMessage);
  if (headers === null) return none;

  const parsed = await simpleParser(`${headers}\r\n\r\n`, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
    skipTextLinks: true,
  });
  const ids = threadingIdsFromHeaderLines(parsed.headerLines);
  const recovered: StoredThreading = {
    messageId: ids.messageId,
    inReplyTo: joinThreadIds(ids.inReplyTo),
    references: joinThreadIds(ids.references),
  };
  if (recovered.messageId !== null) {
    await db.update(inboundEmails).set(recovered).where(eq(inboundEmails.id, inbound.id));
    logger.debug("Recovered threading ids from the raw message", {
      inboundId: inbound.id,
    });
  }
  return recovered;
}

/**
 * The `In-Reply-To` and `References` headers of a dashboard reply to the
 * inbound email `inboundId` (live or trashed), computed from its stored
 * ids, or recovered once from its raw message when the columns are empty.
 * `undefined` when the email is gone or has no valid Message-ID: the reply
 * is then sent without threading headers.
 */
export async function replyHeadersForInbound(
  inboundId: string,
): Promise<ReplyThreadingHeaders | undefined> {
  const inbound =
    (await getInboundEmailById(inboundId)) ??
    (await getTrashedInboundEmailById(inboundId));
  if (!inbound) {
    logger.warn("Reply threading skipped: inbound email not found", { inboundId });
    return undefined;
  }

  let stored: StoredThreading = inbound;
  if (inbound.messageId === null) {
    try {
      stored = await recoverThreading(inbound);
    } catch (error) {
      logger.warn("Reply threading: raw message could not be parsed", {
        inboundId,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  const headers = buildReplyHeaders(stored);
  if (!headers) {
    logger.debug("Reply sent without threading headers: no valid Message-ID", {
      inboundId,
    });
    return undefined;
  }
  return headers;
}

/** The email of ours `inbound` replies to, when it is linked and still exists. */
export async function getRepliedEmail(
  inbound: InboundEmail,
): Promise<RepliedEmail | undefined> {
  if (inbound.inReplyToEmailId === null) return undefined;
  const [row] = await db
    .select({
      id: emails.id,
      subject: emails.subject,
      sentAt: emails.sentAt,
      createdAt: emails.createdAt,
    })
    .from(emails)
    .where(eq(emails.id, inbound.inReplyToEmailId));
  if (!row) return undefined;
  return { id: row.id, subject: row.subject, sentAt: row.sentAt ?? row.createdAt };
}
