import { t } from "elysia";
import {
  trackingFlagSchema,
  unsubscribeEmailSchema,
  unsubscribeUrlSchema,
} from "./create-domain.dto.ts";

/**
 * The domain's MTA-STS mode (#472): `none`, `testing` or `enforce`.
 * Anything else is a 422.
 */
const mtaStsModeSchema = t.Union(
  [t.Literal("none"), t.Literal("testing"), t.Literal("enforce")],
  {
    description:
      "MTA-STS policy served for this domain at https://mta-sts.<domain>/.well-known/mta-sts.txt (#472): none (default, no policy), testing or enforce. Served only while the domain is verified; publish the _mta-sts TXT record from dnsRecords.",
  },
);

/**
 * Validation schema for PATCH /api/v1/domains/:id (#243): edits the
 * `List-Unsubscribe` overrides, the open and click tracking opt-in (#187)
 * and the MTA-STS mode (#472). An omitted field is left unchanged; `null`
 * clears an unsubscribe override (back to the `unsubscribe@<domain>`
 * default, and no one-click URL). The tracking flags take `true` or
 * `false` only.
 */
export const updateDomainDto = t.Object({
  unsubscribeEmail: t.Optional(t.Union([unsubscribeEmailSchema, t.Null()])),
  unsubscribeUrl: t.Optional(t.Union([unsubscribeUrlSchema, t.Null()])),
  trackOpens: t.Optional(trackingFlagSchema),
  trackClicks: t.Optional(trackingFlagSchema),
  mtaStsMode: t.Optional(mtaStsModeSchema),
});
