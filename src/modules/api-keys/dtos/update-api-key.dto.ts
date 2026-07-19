import { t } from "elysia";

/**
 * Validation schema for `PATCH /api/v1/api-keys/:id` (#126).
 *
 * All fields optional — only what's provided changes. `allowedSenders`
 * uses replace semantics (send the full desired list; add = include,
 * remove = omit).
 */
export const updateApiKeyDto = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  allowedSenders: t.Optional(
    t.Array(t.String({ format: "email", maxLength: 255 }), { maxItems: 100 }),
  ),
});
