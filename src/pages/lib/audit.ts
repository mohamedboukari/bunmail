import type { Context } from "elysia";
import {
  requestAuditClient,
  userAuditContext,
} from "../../modules/audit/services/audit-context.service.ts";
import type { AuditClient, AuditContext } from "../../modules/audit/types/audit.types.ts";
import type { DashboardAuth } from "../../modules/users/types/user.types.ts";

/**
 * Audit context of a dashboard request (#221): the signed-in user, the
 * client IP (resolved like the login limiter does) and the user agent.
 */

/** The client of a dashboard request. */
export function dashboardClient(
  request: Request,
  server: Context["server"],
): AuditClient {
  return requestAuditClient(request, server?.requestIP(request)?.address);
}

/** The signed-in user acting through this request. */
export function dashboardAudit(
  auth: DashboardAuth,
  request: Request,
  server: Context["server"],
): AuditContext {
  return userAuditContext(auth.user, dashboardClient(request, server));
}
