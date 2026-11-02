import { getLogContext } from "../utils/log-context.ts";
import type { UserRole } from "../modules/users/types/user.types.ts";

/**
 * The role of the signed-in account viewing a dashboard page (#218), so
 * the sidebar can leave out links to pages the viewer cannot open,
 * without passing the role through every page component.
 *
 * Request-scoped: the value is keyed on the request's log context object
 * (`src/utils/log-context.ts`), which `withRequestContext` creates fresh
 * for every HTTP request, so it can never be seen by another request and
 * is collected with it. It lives beside that object, not on it, so it
 * never reaches a log line. `AsyncLocalStorage.enterWith` is never used
 * (it segfaults Bun 1.3.14 inside Elysia hooks).
 *
 * Only for display: every route checks the role itself (`guards.tsx`).
 * Fail closed: outside a request context, or before the session guard
 * ran, the role is unknown and admin-only links are hidden.
 */

const viewerRoles = new WeakMap<object, UserRole>();

/**
 * Records the viewer's role for the rest of the request. Called by the
 * session guard with the role it just read. No-op outside a context.
 */
export function setViewerRole(role: UserRole): void {
  const store = getLogContext();
  if (store) viewerRoles.set(store, role);
}

/** Viewers known to hold an SSO link (#224), by request context. */
const viewersWithSsoLink = new WeakSet<object>();

/**
 * Records that the viewer holds an SSO link (#224), so the sidebar shows
 * Sign-in methods even when no provider is configured any more (the link
 * can still be removed). Called by the session guard. No-op outside a
 * context.
 */
export function setViewerHasSsoLink(linked: boolean): void {
  const store = getLogContext();
  if (store && linked) viewersWithSsoLink.add(store);
}

/** True when the viewer is known to hold an SSO link (#224). */
export function viewerHasSsoLink(): boolean {
  const store = getLogContext();
  return store !== undefined && viewersWithSsoLink.has(store);
}

/** True when the viewer is known to be an admin or the owner. */
export function viewerIsAdmin(): boolean {
  const store = getLogContext();
  const role = store ? viewerRoles.get(store) : undefined;
  return role === "admin" || role === "owner";
}
