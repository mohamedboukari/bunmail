import type { Context } from "elysia";
import { logger } from "../utils/logger.ts";
import { ForbiddenPage } from "./routes/forbidden.tsx";
import type {
  ActiveSession,
  DashboardAuth,
  SessionAssurance,
  UserRole,
} from "../modules/users/types/user.types.ts";

/**
 * Per-route access checks for the dashboard (#222).
 *
 * The session guard in `pages.plugin.tsx` (an Elysia `resolve`) proves who
 * is signed in and puts `auth` on the context. These helpers then decide
 * whether that account may open a given route. They run as the route's
 * own `beforeHandle`, after the session guard, so `auth` is always set:
 *
 * ```ts
 * .post("/api-keys", handler, { beforeHandle: adminGuard, body: ... })
 * ```
 *
 * Every dashboard route registered after the session guard carries one of
 * `ownerGuard`, `adminGuard` or `memberGuard`, and is listed in the route
 * table of `test/integration/dashboard-route-access.integration.test.ts`,
 * which fails on any route missing from it.
 *
 * A denial is a 403 with a small server-rendered page and a `warn` log
 * line carrying IDs only.
 */

/** Role rank: a higher number may open everything a lower one can. */
const ROLE_RANK: Record<UserRole, number> = { member: 1, admin: 2, owner: 3 };

/** Assurance rank: `pending` never reaches a route (the session lookup rejects it). */
const ASSURANCE_RANK: Record<SessionAssurance, number> = {
  pending: 0,
  password: 1,
  mfa: 2,
};

/** What a role or assurance check reads from the route context. */
interface GuardContext {
  /** The signed-in account, set by the session guard. */
  auth: DashboardAuth;
  /** Raw request: only its method is read, for the log line. */
  request: Request;
  /** Matched path, for the log line. */
  path: string;
  /** Response state: a denial sets the 403 status on it. */
  set: Context["set"];
}

/**
 * A per-route check: returns nothing to let the request through, or the
 * 403 page (with `set.status` already 403) to stop it.
 */
type RouteGuard = (ctx: GuardContext) => string | Promise<string> | undefined;

/**
 * Builds the `auth` context from the guard's session lookup. Pure: the
 * lookup already returned every field, so no further query is needed.
 */
export function toDashboardAuth(session: ActiveSession): DashboardAuth {
  return {
    user: { id: session.userId, email: session.email, role: session.role },
    session: { id: session.sessionId, assurance: session.assurance },
  };
}

/** Whether `role` ranks at least `min` (owner > admin > member). */
export function roleAtLeast(role: UserRole, min: UserRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * A route check that lets through accounts whose role ranks at least
 * `min`. Anyone lower gets a 403 page, and the denial is logged at `warn`
 * with the user ID, both roles, the method and the path.
 */
export function requireRole(min: UserRole): RouteGuard {
  return ({ auth, request, path, set }) => {
    if (roleAtLeast(auth.user.role, min)) return undefined;
    logger.warn("Dashboard access denied: role too low", {
      userId: auth.user.id,
      role: auth.user.role,
      required: min,
      method: request.method,
      path,
    });
    set.status = 403;
    return (
      <ForbiddenPage
        message={`This page needs the ${min} role or higher. Your account is a ${auth.user.role}.`}
      />
    );
  };
}

/**
 * @public Exported ahead of its first use: 2FA (#220) will put it on the
 * routes that need a second factor.
 *
 * A route check that lets through sessions whose assurance ranks at
 * least `min` (`password` < `mfa`). A weaker session gets a 403 page, and
 * the denial is logged at `warn` with the user and session IDs, both
 * levels, the method and the path.
 */
export function requireAssurance(min: SessionAssurance): RouteGuard {
  return ({ auth, request, path, set }) => {
    if (ASSURANCE_RANK[auth.session.assurance] >= ASSURANCE_RANK[min]) return undefined;
    logger.warn("Dashboard access denied: session assurance too low", {
      userId: auth.user.id,
      sessionId: auth.session.id,
      assurance: auth.session.assurance,
      required: min,
      method: request.method,
      path,
    });
    set.status = 403;
    return (
      <ForbiddenPage
        message={`This page needs a session verified with ${min}. Yours was verified with ${auth.session.assurance}.`}
      />
    );
  };
}

/**
 * @public Exported ahead of its first use: no route is owner-only yet;
 * account management (#217, #218) and ownership transfer will be.
 *
 * Owner only.
 */
export const ownerGuard: RouteGuard = requireRole("owner");

/** Admins and the owner: management actions and destructive operations. */
export const adminGuard: RouteGuard = requireRole("admin");

/**
 * Any signed-in account. Lets every session the session guard admitted
 * through; carried anyway so each route states its access level, and the
 * route-table test can tell a reviewed member route from a forgotten one.
 */
export const memberGuard: RouteGuard = requireRole("member");
