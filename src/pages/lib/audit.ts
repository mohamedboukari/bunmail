import type { Context } from "elysia";
import {
  requestAuditClient,
  userAuditContext,
} from "../../modules/audit/services/audit-context.service.ts";
import type {
  AuditClient,
  AuditContext,
  AuditEventFilters,
} from "../../modules/audit/types/audit.types.ts";
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

/** An actor id as the log stores them: our own `usr_` / `key_` ids. */
const ACTOR_ID_RE = /^[a-z]{3}_[0-9a-f]{24}$/;

/**
 * Parses the audit log's actor filter (`user:<id>`, `api_key:<id>` or
 * `system`), for the page and its CSV export (#430). Anything else is
 * ignored, like the other dashboard filters: the URL is edited by hand,
 * so a bad value lists everything instead of failing.
 */
export function parseAuditActor(raw: string | undefined): AuditEventFilters["actor"] {
  if (raw === "system") return { type: "system" };
  const separator = raw?.indexOf(":") ?? -1;
  if (raw === undefined || separator < 0) return undefined;
  const type = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if ((type !== "user" && type !== "api_key") || !ACTOR_ID_RE.test(id)) return undefined;
  return { type, id };
}
