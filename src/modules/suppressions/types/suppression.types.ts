import type { InferSelectModel } from "drizzle-orm";
import type { suppressions } from "../models/suppression.schema.ts";

/**
 * Row shape returned from the database. Inferred from the Drizzle schema
 * so renames stay in sync without a duplicate type definition.
 */
export type Suppression = InferSelectModel<typeof suppressions>;

/**
 * Reasons we accept at the API boundary. The DB column is plain text for
 * forward compatibility: a finer split (e.g. `bounce.hard.no_user`) can
 * land later without a migration. The API DTO restricts incoming reasons
 * to this set so we don't grow stringly-typed accidentally.
 */
export const SUPPRESSION_REASONS = [
  "bounce",
  "complaint",
  "manual",
  "unsubscribe",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const BOUNCE_TYPES = ["hard", "soft"] as const;
export type BounceType = (typeof BOUNCE_TYPES)[number];

/**
 * Input accepted by the manual `POST /suppressions` endpoint. A subset
 * of the schema columns: the bounce-specific fields are populated by
 * the auto-suppression path (#24) only.
 */
export interface CreateSuppressionInput {
  email: string;
  reason: SuppressionReason;
  expiresAt?: Date | null;
}

/**
 * Input shape used internally by the auto-suppression hook (#24 will
 * call this once DSN parsing lands). Kept separate from the public
 * `CreateSuppressionInput` so manual requests can't spoof a "bounce"
 * reason with diagnostic-code metadata they didn't actually parse.
 */
export interface AddFromBounceInput {
  email: string;
  bounceType: BounceType;
  diagnosticCode?: string;
  sourceEmailId?: string;
  /** Soft-bounce backoff window. Defaults to permanent for hard bounces. */
  expiresAt?: Date | null;
}

/**
 * How an unsubscribe request arrived (#249); also the webhook's `source`.
 * `fbl` is an `opt-out` feedback-loop report from a mailbox provider (#191).
 */
export type UnsubscribeSource = "one_click" | "link" | "mailto" | "fbl";

/**
 * Input of the unsubscribe path (#249). Built only from a verified
 * unsubscribe token, never from request fields.
 */
export interface AddFromUnsubscribeInput {
  apiKeyId: string;
  email: string;
  /** The email whose `List-Unsubscribe` link or mailto was used. */
  emailId: string;
  source: UnsubscribeSource;
}

/**
 * Input of the feedback-loop complaint path (#191). Built only from an
 * email row a report was linked to by its Message-ID, never from report
 * fields alone.
 */
export interface AddFromComplaintInput {
  apiKeyId: string;
  email: string;
  /** The email the complaint was about. */
  emailId: string;
}
