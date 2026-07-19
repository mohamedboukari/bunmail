import { t } from "elysia";

/**
 * Validation schema for creating a new API key.
 * Only a name is required — the key value is auto-generated server-side.
 */
export const createApiKeyDto = t.Object({
  /** Human-readable label (1-100 chars) */
  name: t.String({ minLength: 1, maxLength: 100 }),

  /**
   * Optional allowlist of `From` addresses this key may send from (#126).
   * Omit or pass `[]` for unrestricted. Capped to keep the row small.
   */
  allowedSenders: t.Optional(
    t.Array(t.String({ format: "email", maxLength: 255 }), { maxItems: 100 }),
  ),
});
