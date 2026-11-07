import { t } from "elysia";
import {
  trackingFlagSchema,
  unsubscribeEmailSchema,
  unsubscribeUrlSchema,
} from "./create-domain.dto.ts";

/**
 * Validation schema for PATCH /api/v1/domains/:id (#243): edits the
 * `List-Unsubscribe` overrides and the open and click tracking opt-in
 * (#187). An omitted field is left unchanged; `null` clears an
 * unsubscribe override (back to the `unsubscribe@<domain>` default, and
 * no one-click URL). The tracking flags take `true` or `false` only.
 */
export const updateDomainDto = t.Object({
  unsubscribeEmail: t.Optional(t.Union([unsubscribeEmailSchema, t.Null()])),
  unsubscribeUrl: t.Optional(t.Union([unsubscribeUrlSchema, t.Null()])),
  trackOpens: t.Optional(trackingFlagSchema),
  trackClicks: t.Optional(trackingFlagSchema),
});
