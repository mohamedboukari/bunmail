import { t } from "elysia";
import { SUPPRESSION_REASONS } from "../types/suppression.types.ts";

/**
 * Validation schema for `POST /api/v1/suppressions` — manual addition.
 *
 * `reason` is restricted to the known union; the DB column is plain text
 * for forward compatibility, but the API surface is strict so consumers
 * can't drift the vocabulary.
 *
 * `expiresAt` is optional. When omitted, the suppression is permanent
 * (the right default for `manual` and `complaint`).
 */
export const createSuppressionDto = t.Object({
  /** Recipient address to suppress. */
  email: t.String({ format: "email", maxLength: 255 }),

  /**
   * Why. `bounce` and `unsubscribe` are typically populated by automated
   * paths (auto-suppression in #24, one-click unsubscribe endpoint in a
   * future ticket); manual additions usually come in as `manual`.
   */
  reason: t.Union(
    SUPPRESSION_REASONS.map((r) => t.Literal(r)),
    { default: "manual" },
  ),

  /** ISO-8601 timestamp; null/omitted = permanent. */
  expiresAt: t.Optional(t.Union([t.Date(), t.String({ format: "date-time" }), t.Null()])),
});
