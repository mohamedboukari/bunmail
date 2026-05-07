import type { InferSelectModel } from "drizzle-orm";
import type { suppressions } from "../models/suppression.schema.ts";

/**
 * Row shape returned from the database. Inferred from the Drizzle schema
 * so renames stay in sync without a duplicate type definition.
 */
export type Suppression = InferSelectModel<typeof suppressions>;

/**
 * Reasons we accept at the API boundary. The DB column is plain text for
 * forward compatibility — a finer split (e.g. `bounce.hard.no_user`) can
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
 * of the schema columns — the bounce-specific fields are populated by
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
