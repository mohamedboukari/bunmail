import type { EmailEvent } from "../services/email-events.service.ts";

/**
 * An open or click event in API responses (#187). No internal ids: the
 * event's own id and the API key stay internal, and the email is the one
 * in the path.
 */
export interface SerializedEmailEvent {
  /** `open` or `click`. */
  type: string;
  /** When it happened. */
  occurredAt: Date;
  /** A click: the target without query string and fragment; null for an open. */
  url: string | null;
  /** A click: the link's position in the email (0-based); null for an open. */
  linkPosition: number | null;
  /** `image_proxy` (a mail provider's image proxy) or `unknown`. */
  clientKind: string;
  /** A guess that no person caused it (a proxy or a link scanner). */
  machine: boolean;
}

/** Maps a stored event to the response shape. */
export function serializeEmailEvent(event: EmailEvent): SerializedEmailEvent {
  return {
    type: event.type,
    occurredAt: event.occurredAt,
    url: event.url,
    linkPosition: event.linkPosition,
    clientKind: event.clientKind,
    machine: event.machine,
  };
}
