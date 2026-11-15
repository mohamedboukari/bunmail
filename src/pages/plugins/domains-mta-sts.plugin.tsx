import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { adminGuard } from "../guards.tsx";
import * as domainService from "../../modules/domains/services/domain.service.ts";
import { flashUrl, type Flash } from "../lib/flash.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardAudit } from "../lib/audit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";

/** The domain page with a flash banner (#421: a code, never text). */
function domainFlashUrl(id: string, flash: Flash): string {
  return flashUrl(`/dashboard/domains/${id}`, flash);
}

/**
 * The domain page's MTA-STS setting (#472), split from `domains.plugin.tsx`
 * (which calls it first on its instance) to keep that file under the size
 * limit.
 */
export function domainMtaStsPages(app: GuardedDashboard) {
  return (
    app
      /**
       * POST /dashboard/domains/:id/mta-sts
       * Sets the domain's MTA-STS mode: `none`, `testing` or `enforce`
       * (#472). Audited as `domain.updated`. An enforce policy on a server
       * without inbound STARTTLS is saved, with a warning banner.
       */
      .post(
        "/domains/:id/mta-sts",
        async ({ params, body, set, auth, request, server }) => {
          const updated = await domainService.updateDomainSettings(params.id, {
            mtaStsMode: body.mode,
          });
          set.status = 302;
          if (!updated) {
            set.headers["location"] = flashUrl("/dashboard/domains", "domain_not_found");
            return "";
          }
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.updated",
            target: { type: "domain", id: updated.id, label: updated.name },
            metadata: { fields: ["mtaStsMode"] },
          });
          const inboundStarttls = config.smtp.enabled && config.smtp.tls !== null;
          if (body.mode === "enforce" && !inboundStarttls) {
            logger.warn("MTA-STS enforce set without inbound STARTTLS", {
              domainId: updated.id,
            });
          }
          set.headers["location"] = domainFlashUrl(
            params.id,
            body.mode === "none"
              ? "domain_mta_sts_off"
              : body.mode === "enforce" && !inboundStarttls
                ? "domain_mta_sts_saved_no_tls"
                : "domain_mta_sts_saved",
          );
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
          body: t.Object({
            mode: t.Union([
              t.Literal("none"),
              t.Literal("testing"),
              t.Literal("enforce"),
            ]),
          }),
        },
      )
  );
}
