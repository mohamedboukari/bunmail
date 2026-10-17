import { t } from "elysia";
import { unsubscribeEmailSchema, unsubscribeUrlSchema } from "./create-domain.dto.ts";

/**
 * Validation schema for PATCH /api/v1/domains/:id (#243): edits the
 * `List-Unsubscribe` overrides. An omitted field is left unchanged;
 * `null` clears it (back to the `unsubscribe@<domain>` default, and no
 * one-click URL).
 */
export const updateDomainDto = t.Object({
  unsubscribeEmail: t.Optional(t.Union([unsubscribeEmailSchema, t.Null()])),
  unsubscribeUrl: t.Optional(t.Union([unsubscribeUrlSchema, t.Null()])),
});
