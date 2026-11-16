import type { InboundAttachmentMeta, InboundEmail } from "../types/inbound.types.ts";

/**
 * Shape of an inbound email in API responses.
 * Omits `rawMessage` to keep response sizes small.
 */
export interface SerializedInboundEmail {
  id: string;
  from: string;
  to: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  receivedAt: Date;
  /** Attachment metadata (#486); only on the single-email response. */
  attachments?: SerializedInboundAttachment[];
}

/** One attachment of a received email in API responses (#486). */
export interface SerializedInboundAttachment {
  position: number;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
}

/** Maps attachment metadata to the API shape (`size`, like outbound). */
export function serializeInboundAttachment(
  attachment: InboundAttachmentMeta,
): SerializedInboundAttachment {
  return {
    position: attachment.position,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.sizeBytes,
    contentId: attachment.contentId,
  };
}

/**
 * Transforms a raw database inbound email row into the API response shape.
 * Strips the raw RFC 822 source: consumers can fetch it via GET /:id/raw
 * if they need it in the future.
 */
export function serializeInboundEmail(
  email: InboundEmail,
  attachments?: InboundAttachmentMeta[],
): SerializedInboundEmail {
  return {
    id: email.id,
    from: email.fromAddress,
    to: email.toAddress,
    subject: email.subject,
    html: email.html,
    text: email.textContent,
    receivedAt: email.receivedAt,
    ...(attachments === undefined
      ? {}
      : { attachments: attachments.map(serializeInboundAttachment) }),
  };
}
