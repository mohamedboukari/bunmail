import type { Email } from "../types/email.types.ts";
import type { CustomHeaders } from "../models/email.schema.ts";

/**
 * Shape of an email in API responses.
 * Hides internal fields (api_key_id) and renames DB column names
 * to a cleaner, consumer-friendly format.
 */
export interface SerializedEmail {
  id: string;
  from: string;
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
}

/**
 * Transforms a raw database email row into the public API response shape.
 * Strips internal fields like `apiKeyId` and `domainId` that consumers
 * don't need to see.
 */
export function serializeEmail(email: Email): SerializedEmail {
  return {
    id: email.id,
    from: email.fromAddress,
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
    attempts: email.attempts,
    nextAttemptAt: email.status === "queued" ? email.nextAttemptAt : null,
    lastError: email.lastError,
    messageId: email.messageId,
    sentAt: email.sentAt,
    createdAt: email.createdAt,
  };
}
