import { simpleParser, type Attachment } from "mailparser";
import { logger } from "../../../utils/logger.ts";
import type {
  InboundAttachment,
  InboundAttachmentMeta,
  InboundEmail,
} from "../types/inbound.types.ts";

/**
 * Attachments of a received email (#486), read from its stored raw
 * message on demand: nothing is extracted at receive time, so mail stored
 * before this feature shows its attachments too, and no migration is
 * needed. The cost of a parse is bounded by the inbound message size cap.
 *
 * Inline images need no work here: `simpleParser` already rewrites
 * `cid:` references to `data:` URIs when the message is stored, which the
 * preview CSP allows.
 */

/** Name shown for a part that carries no filename (e.g. an inline image). */
function fallbackFilename(position: number): string {
  return `attachment-${position + 1}`;
}

/**
 * Parses the raw message of `email` and returns its attachment parts, or
 * an empty list when there is no raw message or it does not parse. A
 * parse failure is logged with the email ID and the error name only: the
 * message may embed sender content.
 */
async function parseAttachments(email: InboundEmail): Promise<Attachment[]> {
  if (email.rawMessage === null || email.rawMessage === "") return [];
  try {
    const parsed = await simpleParser(email.rawMessage, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      skipImageLinks: true,
      keepCidLinks: true,
    });
    return parsed.attachments;
  } catch (err) {
    logger.warn("Inbound attachments: raw message did not parse", {
      inboundEmailId: email.id,
      error: err instanceof Error ? err.name : "unknown",
    });
    return [];
  }
}

/** Metadata of one parsed part, at its 0-based position. */
function toMeta(attachment: Attachment, position: number): InboundAttachmentMeta {
  return {
    position,
    filename: attachment.filename ?? fallbackFilename(position),
    contentType: attachment.contentType,
    sizeBytes: attachment.size,
    contentId: attachment.cid ?? null,
  };
}

/**
 * Lists the attachments of a received email, in message order.
 *
 * @param email The stored inbound email (live or trashed).
 * @returns One entry per attachment; empty when there are none.
 */
export async function listInboundAttachments(
  email: InboundEmail,
): Promise<InboundAttachmentMeta[]> {
  const attachments = await parseAttachments(email);
  return attachments.map(toMeta);
}

/**
 * One attachment of a received email, with its bytes, for a download.
 *
 * @param email The stored inbound email (live or trashed).
 * @param position The 0-based position from {@link listInboundAttachments}.
 * @returns The attachment, or `undefined` when there is none at `position`.
 */
export async function getInboundAttachment(
  email: InboundEmail,
  position: number,
): Promise<InboundAttachment | undefined> {
  const attachments = await parseAttachments(email);
  const attachment = attachments[position];
  if (attachment === undefined) return undefined;
  return { ...toMeta(attachment, position), content: attachment.content };
}

/**
 * Parses a download position path segment: a non-negative integer of at
 * most three digits, the same rule as outbound attachment downloads.
 *
 * @returns The position, or `null` when the segment is not one.
 */
export function parseAttachmentPosition(segment: string): number | null {
  return /^\d{1,3}$/.test(segment) ? Number(segment) : null;
}
