import type { RevealOwner } from "../reveal-store.ts";
import type { DashboardAuth } from "../../modules/users/types/user.types.ts";

/**
 * The owner a one-time reveal is bound to (#280): the signed-in user and
 * the session that created it, from the guard's `auth` (#222).
 */
export function revealOwnerOf(auth: DashboardAuth): RevealOwner {
  return { userId: auth.user.id, sessionId: auth.session.id };
}
