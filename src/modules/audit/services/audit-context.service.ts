import { config } from "../../../config.ts";
import { resolveClientIp } from "../../../middleware/login-rate-limit.ts";
import type { AuditClient, AuditContext } from "../types/audit.types.ts";

/**
 * Builds the "who and from where" of an audit event (#221) from an HTTP
 * request: the dashboard routes and the REST API both use it, so every
 * event resolves the client IP the same way the login limiter does
 * (`DASHBOARD_TRUSTED_PROXY_HOPS`).
 */

/**
 * The client of a request: the resolved IP (stored only when it is an IP
 * literal) and the raw `User-Agent` (cut when stored).
 *
 * @param socketIp - `server?.requestIP(request)?.address`
 */
export function requestAuditClient(
  request: Request,
  socketIp: string | undefined,
): AuditClient {
  return {
    ip: resolveClientIp({
      socketIp,
      forwardedFor: request.headers.get("x-forwarded-for"),
      trustedProxyHops: config.dashboard.trustedProxyHops,
    }),
    userAgent: request.headers.get("user-agent"),
  };
}

/** A signed-in dashboard user acting from `client`; the label is the account email. */
export function userAuditContext(
  user: { id: string; email: string },
  client: AuditClient,
): AuditContext {
  return { actor: { type: "user", id: user.id, label: user.email }, ...client };
}

/** What a REST handler's context carries that an audit event needs. */
interface RestAuditSource {
  /** The calling key, from the auth middleware. */
  apiKeyId: string;
  /** Its name; read from the row when absent. */
  apiKeyName?: string;
  request: Request;
  /** Bun's server, for the socket address (null in `app.handle` tests). */
  server: { requestIP(request: Request): { address: string } | null } | null;
}

/** The API key calling a REST route (#221); the label is the key's name. */
export function restAuditContext(ctx: RestAuditSource): AuditContext {
  return {
    actor: { type: "api_key", id: ctx.apiKeyId, label: ctx.apiKeyName },
    ...requestAuditClient(ctx.request, ctx.server?.requestIP(ctx.request)?.address),
  };
}
