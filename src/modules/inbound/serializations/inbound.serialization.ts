import type { InboundEmail } from "../types/inbound.types.ts";

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
}

/**
 * Transforms a raw database inbound email row into the API response shape.
 * Strips the raw RFC 822 source — consumers can fetch it via GET /:id/raw
 * if they need it in the future.
 */
export function serializeInboundEmail(email: InboundEmail): SerializedInboundEmail {
  return {
    id: email.id,
    from: email.fromAddress,
    to: email.toAddress,
    subject: email.subject,
    html: email.html,
    text: email.textContent,
    receivedAt: email.receivedAt,
  };
}
