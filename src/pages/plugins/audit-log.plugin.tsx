import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { AuditLogPage } from "../routes/audit-log.tsx";
import { adminGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import { setNoStore } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import * as auditService from "../../modules/audit/services/audit.service.ts";
import { isAuditAction, isAuditOutcome } from "../../modules/audit/types/audit.types.ts";
import { parseAuditActor } from "../lib/audit.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/**
 * Audit log page (#221): the owner and admins (`adminGuard`); members get
 * the 403 page. Read-only: the log has no edit or delete action anywhere.
 */
export function auditLogPages(app: GuardedDashboard) {
  return app.get(
    "/audit-log",
    async ({ query, set, auth }) => {
      /** Labels are emails and IPs: never cached by the browser or a proxy. */
      setNoStore(set);
      const { page, limit } = parsePagination(query, 50);
      const action = isAuditAction(query.action) ? query.action : undefined;
      const outcome = isAuditOutcome(query.outcome) ? query.outcome : undefined;
      const actor = parseAuditActor(query.actor);

      try {
        const [{ data, total }, actors] = await Promise.all([
          auditService.listAuditEvents({ action, actor, outcome, page, limit }),
          auditService.listAuditActors(),
        ]);
        return (
          <AuditLogPage
            events={data}
            total={total}
            page={page}
            limit={limit}
            filters={{
              action,
              actor: actor === undefined ? undefined : query.actor,
              outcome,
            }}
            actors={actors}
          />
        );
      } catch (error: unknown) {
        logger.error("Audit log page failed to load", {
          userId: auth.user.id,
          error: errorMessage(error),
        });
        set.status = 503;
        return "Audit log temporarily unavailable";
      }
    },
    {
      beforeHandle: adminGuard,
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        action: t.Optional(t.String()),
        actor: t.Optional(t.String()),
        outcome: t.Optional(t.String()),
      }),
    },
  );
}
