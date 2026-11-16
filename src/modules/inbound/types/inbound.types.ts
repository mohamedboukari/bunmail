import type { inboundEmails } from "../models/inbound-email.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

/**
 * The shape of an inbound email row returned from the database.
 */
export type InboundEmail = InferSelectModel<typeof inboundEmails>;

/**
 * One attachment of a received email (#486), parsed from its raw message.
 * `filename` and `contentId` come from the sender: escape them wherever
 * they are shown.
 */
export interface InboundAttachmentMeta {
  /** 0-based position among the message's attachments; the download key. */
  position: number;
  /** The sender's filename, or `attachment-<n>` when the part has none. */
  filename: string;
  /** The type the sender declared; never trusted for rendering. */
  contentType: string;
  sizeBytes: number;
  /** The inline Content-ID without angle brackets, or null. */
  contentId: string | null;
}

/** An attachment with its decoded bytes, for a download. */
export interface InboundAttachment extends InboundAttachmentMeta {
  content: Buffer;
}
