import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { adminGuard } from "../guards.tsx";
import * as domainService from "../../modules/domains/services/domain.service.ts";
import {
  checkBimi,
  rememberBimiCheck,
} from "../../modules/domains/services/bimi-check.service.ts";
import type { BimiStatus } from "../../modules/domains/types/bimi.types.ts";
import { flashUrl } from "../lib/flash.ts";
import type { FlashCode } from "../lib/flash-codes.ts";
import { isDnsVerifyThrottled } from "../lib/dns-verify-throttle.ts";
import type { domainMtaStsPages } from "./domains-mta-sts.plugin.tsx";

/** The banner of each BIMI verdict (#421: a code, never text). */
const BIMI_FLASH: Record<BimiStatus, FlashCode> = {
  ready: "bimi_ready",
  "not-ready": "bimi_not_ready",
  missing: "bimi_missing",
  declined: "bimi_declined",
  error: "bimi_check_failed",
};

/**
 * The domain page's BIMI check (#415). A separate group from
 * `domains.plugin.tsx`, which composes it after the MTA-STS group (#472)
 * on the same instance (#387), so neither file grows past the split size.
 */
export function domainBimiPages(app: ReturnType<typeof domainMtaStsPages>) {
  return app.post(
    /**
     * POST /dashboard/domains/:id/bimi
     * Checks the domain's BIMI record, DMARC prerequisite and logo, keeps
     * the result in memory for the page, and redirects back to it with a
     * banner. Admins only: it fetches a URL from the domain's DNS. Shares
     * the Verify throttle, since it looks up DNS too. Same-origin like
     * every dashboard POST (the session guard). Read-only, so not audited.
     */
    "/domains/:id/bimi",
    async ({ params, set }) => {
      set.status = 302;
      const domain = await domainService.getDomainById(params.id);
      if (!domain) {
        set.headers["location"] = flashUrl("/dashboard/domains", "domain_not_found");
        return "";
      }
      if (await isDnsVerifyThrottled(params.id)) {
        logger.warn("BIMI check throttled", { domainId: params.id });
        set.headers["location"] = flashUrl(
          `/dashboard/domains/${params.id}`,
          "bimi_throttled",
        );
        return "";
      }
      const check = await checkBimi(domain.name);
      rememberBimiCheck(domain.id, check);
      set.headers["location"] = flashUrl(
        `/dashboard/domains/${params.id}`,
        BIMI_FLASH[check.status],
      );
      return "";
    },
    {
      beforeHandle: adminGuard,
      params: t.Object({ id: t.String() }),
    },
  );
}
