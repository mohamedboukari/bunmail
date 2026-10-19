import type {
  DeliveryGroup,
  DeliveryGroupStatus,
  DeliveryState,
  DeliveryTls,
} from "../models/email.schema.ts";

/**
 * One delivery-state entry in API responses and on the email detail page
 * (#250): where a set of recipients was sent and what happened there.
 * Built only from the stored state; the entry's internal key (`<mx>#<n>`
 * for a per-recipient entry, `<dns:domain>` for a DNS failure), `mxHost`,
 * `blocked` and `messageId` are not exposed.
 */
export interface SerializedDeliveryGroup {
  /**
   * Destination MX host. `null` when the recipient domain's MX could not
   * be resolved (the recipients were never attempted).
   */
  mx: string | null;
  /** The recipients of this entry: one with signed return paths (#236), else the MX's group. */
  recipients: string[];
  status: DeliveryGroupStatus;
  /** Attempts this entry has used. */
  attempts: number;
  /** How the last failure's SMTP reply was classified (#250); null without one. */
  failureKind: "hard" | "policy" | "soft" | null;
  /** The status code of that classification, e.g. `5.1.1`. */
  failureCode: string | null;
  /** The last failure's message, as stored (also part of the email's `lastError`). */
  lastError: string | null;
  /**
   * Encryption of the session behind the latest outcome (#250): `starttls`,
   * `plaintext`, or `null` when unknown (no session got ready, or the
   * entry predates the record).
   */
  tls: DeliveryTls | null;
  /** When the latest outcome happened (ISO); `null` on entries from before. */
  updatedAt: string | null;
}

/** Prefix of the synthetic key of a DNS-failed entry (see `buildInitialState`). */
const DNS_FAILURE_KEY = "<dns:";

/**
 * Maps the stored `delivery_state` to its public shape (#250), sorted by MX
 * then first recipient, so the order is stable (jsonb does not keep key
 * order). An email not attempted yet has no entries.
 */
export function serializeDeliveryState(
  state: DeliveryState | null,
): SerializedDeliveryGroup[] {
  if (!state) return [];
  return Object.entries(state)
    .map(([key, group]) => serializeGroup(key, group))
    .toSorted(compareGroups);
}

function serializeGroup(key: string, group: DeliveryGroup): SerializedDeliveryGroup {
  return {
    mx: key.startsWith(DNS_FAILURE_KEY) ? null : (group.mxHost ?? key),
    recipients: [...group.recipients],
    status: group.status,
    attempts: group.attempts,
    failureKind: group.failureKind ?? null,
    failureCode: group.failureCode ?? null,
    lastError: group.lastError ?? null,
    tls: group.tls ?? null,
    updatedAt: group.updatedAt ?? group.deliveredAt ?? null,
  };
}

/** MX first (unresolved last), then the first recipient. */
function compareGroups(a: SerializedDeliveryGroup, b: SerializedDeliveryGroup): number {
  if (a.mx !== b.mx) {
    if (a.mx === null) return 1;
    if (b.mx === null) return -1;
    return a.mx < b.mx ? -1 : 1;
  }
  const ra = a.recipients[0] ?? "";
  const rb = b.recipients[0] ?? "";
  if (ra === rb) return 0;
  return ra < rb ? -1 : 1;
}
