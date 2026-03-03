import type { Email } from "../types/email.types.ts";

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
  subject: string;
  html: string | null;
  text: string | null;
  status: string;
  attempts: number;
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
    subject: email.subject,
    html: email.html,
    text: email.textContent,
    status: email.status,
    attempts: email.attempts,
    lastError: email.lastError,
    messageId: email.messageId,
    sentAt: email.sentAt,
    createdAt: email.createdAt,
  };
}
