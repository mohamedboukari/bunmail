import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { AuditLogPage } from "../routes/audit-log.tsx";
import { adminGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import { setNoStore } from "../lib/responses.ts";
import { errorMessage } from "../lib/error-message.ts";
import * as auditService from "../../modules/audit/services/audit.service.ts";
import {
  isAuditAction,
  isAuditOutcome,
  type AuditEventFilters,
} from "../../modules/audit/types/audit.types.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/** An actor id as the log stores them: our own `usr_` / `key_` ids. */
const ACTOR_ID_RE = /^[a-z]{3}_[0-9a-f]{24}$/;

/**
 * Parses the actor filter (`user:<id>`, `api_key:<id>` or `system`).
 * Anything else is ignored, like the other dashboard filters: the URL is
 * edited by hand, so a bad value lists everything instead of failing.
 */
function parseActor(raw: string | undefined): AuditEventFilters["actor"] {
  if (raw === "system") return { type: "system" };
  const separator = raw?.indexOf(":") ?? -1;
  if (raw === undefined || separator < 0) return undefined;
  const type = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if ((type !== "user" && type !== "api_key") || !ACTOR_ID_RE.test(id)) return undefined;
  return { type, id };
}

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
      const actor = parseActor(query.actor);

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
