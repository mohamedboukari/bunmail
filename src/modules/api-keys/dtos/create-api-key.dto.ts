import { t } from "elysia";

/**
 * Validation schema for creating a new API key.
 * Only a name is required — the key value is auto-generated server-side.
 */
export const createApiKeyDto = t.Object({
  /** Human-readable label (1-100 chars) */
  name: t.String({ minLength: 1, maxLength: 100 }),
});
