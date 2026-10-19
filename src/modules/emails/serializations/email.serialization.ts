import { isEmailCategory, type Email, type EmailCategory } from "../types/email.types.ts";
import type { CustomHeaders, EmailTags } from "../models/email.schema.ts";
import type { AttachmentMeta } from "../services/attachment-storage.ts";
import {
  serializeDeliveryState,
  type SerializedDeliveryGroup,
} from "./delivery-state.serialization.ts";

/**
 * An attachment in API responses (#181): metadata only, never the bytes.
 */
export interface SerializedAttachment {
  filename: string;
  /** The type it is sent with, derived from the bytes (never the declared one). */
  contentType: string;
  /** Decoded size in bytes. */
  size: number;
  /** Content-ID of an inline image; null for a plain attachment. */
  contentId: string | null;
  /** Whether the bytes are still stored: false once the email reached a final state. */
  available: boolean;
}

/**
 * Shape of an email in API responses.
 * Hides internal fields (api_key_id) and renames DB column names
 * to a cleaner, consumer-friendly format.
 */
export interface SerializedEmail {
  id: string;
  from: string;
  /** Sender display name (#250); null when none. */
  fromName: string | null;
  to: string;
  cc: string | null;
  bcc: string | null;
  /** Reply-To address(es), comma-separated (#169) */
  replyTo: string | null;
  /** Custom headers set on the send (#177), name to value; null when none. */
  headers: CustomHeaders | null;
  subject: string;
  html: string | null;
  text: string | null;
  status: string;
  /** Ingress channel: "api" (REST) or "smtp" (submission server) (#137) */
  source: string;
  /** "transactional" or "marketing" as set on the send (#250); null when unset. */
  category: EmailCategory | null;
  /** Labels set on the send (#189), key to value; null when none. */
  tags: EmailTags | null;
  /** Attachments (#181), in order, metadata only; empty when none. */
  attachments: SerializedAttachment[];
  attempts: number;
  /**
   * When a deferred email will be retried (#180): set while `status` is
   * `queued`, `null` otherwise.
   */
  nextAttemptAt: Date | null;
  lastError: string | null;
  messageId: string | null;
  sentAt: Date | null;
  createdAt: Date;
  /**
   * Per-MX delivery state (#250): one entry per destination MX, or per
   * recipient when signed return paths split the group (#236). Empty
   * until the first attempt.
   */
  deliveryState: SerializedDeliveryGroup[];
}

/**
 * Transforms a raw database email row into the public API response shape.
 * Strips internal fields like `apiKeyId` and `domainId` that consumers
 * don't need to see. `attachments` is the email's attachment metadata
 * (#181), read without the bytes; pass `[]` for an email without any.
 */
export function serializeEmail(
  email: Email,
  attachments: readonly AttachmentMeta[],
): SerializedEmail {
  return {
    id: email.id,
    from: email.fromAddress,
    fromName: email.fromName,
    to: email.toAddress,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo,
    headers: email.headers,
    subject: email.subject,
    html: email.html,
    text: email.textContent,
    status: email.status,
    source: email.source,
    category: isEmailCategory(email.category) ? email.category : null,
    tags: email.tags,
    attachments: attachments.map(serializeAttachment),
    attempts: email.attempts,
    nextAttemptAt: email.status === "queued" ? email.nextAttemptAt : null,
    lastError: email.lastError,
    messageId: email.messageId,
    sentAt: email.sentAt,
    createdAt: email.createdAt,
    deliveryState: serializeDeliveryState(email.deliveryState),
  };
}

/** One attachment's metadata in the response shape (#181). */
function serializeAttachment(meta: AttachmentMeta): SerializedAttachment {
  return {
    filename: meta.filename,
    contentType: meta.contentType,
    size: meta.sizeBytes,
    contentId: meta.contentId,
    available: meta.available,
  };
}
