import { isEmailAddress } from "../../../utils/recipients.ts";
import type { InviteRole, UserRole } from "../types/user.types.ts";
import { buildDashboardUrl } from "./owner-setup-policy.service.ts";

/**
 * Rules for dashboard invitations (#217): who may grant which role, what
 * an invited address and a new account's name must look like, when a link
 * expires, and how the accept link is built. The database side lives in
 * `invite.service.ts`; the password policy is the owner setup one
 * (`setupPasswordProblem`).
 *
 * Pure: no I/O, no config, so it unit-tests without mocks.
 */

/**
 * Roles each role may grant by invitation (and so manage: revoke, resend).
 * The owner invites admins and members, an admin invites members, a
 * member invites nobody. Nobody invites an owner.
 */
const GRANTABLE_ROLES: Record<UserRole, readonly InviteRole[]> = {
  owner: ["admin", "member"],
  admin: ["member"],
  member: [],
};

/** Longest display name accepted, in characters: `users.name` is `varchar(100)`. */
export const INVITE_NAME_MAX_LENGTH = 100;

/**
 * Control and format characters: Unicode `Cc` (C0 including CR and LF,
 * DEL, C1) and `Cf` (bidi overrides, zero-width spaces and joiners, soft
 * hyphen), which can make a name or an address look like something else.
 */
const CONTROL_OR_FORMAT_RE = /[\p{Cc}\p{Cf}]/u;

/** The roles `actorRole` may grant, in the order the invite form lists them. */
export function grantableRoles(actorRole: UserRole): readonly InviteRole[] {
  return GRANTABLE_ROLES[actorRole];
}

/**
 * True when `actorRole` may grant `role` by invitation. `role` is the raw
 * submitted value, so a crafted `owner` or an unknown string is `false`.
 */
export function canGrantRole(actorRole: UserRole, role: string): role is InviteRole {
  return GRANTABLE_ROLES[actorRole].some((grantable) => grantable === role);
}

/**
 * Normalizes an invited address the way `users.email` and
 * `user_tokens.email` store it: trimmed and lower-cased.
 */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * True when a normalized address can be invited: one bare address in the
 * shape the recipient parser accepts, at most 254 characters, and free of
 * control and format characters (checked here rather than in the shared
 * address regex, which other paths rely on).
 */
export function isInvitableEmail(email: string): boolean {
  return !CONTROL_OR_FORMAT_RE.test(email) && isEmailAddress(email);
}

/**
 * Why a new account's display name is not acceptable, or `null` if it is.
 * Expects the trimmed value. Lengths count characters (code points), as
 * Postgres does for `varchar(100)`. Control and format characters (bidi
 * overrides, zero-width) are refused: the name is shown to other accounts
 * and appears in invitation emails this account sends. The message is
 * shown on the accept form, so it never echoes the input.
 */
export function inviteNameProblem(name: string): string | null {
  const length = Array.from(name).length;
  if (length === 0) return "Enter your name.";
  if (length > INVITE_NAME_MAX_LENGTH) {
    return `The name must be at most ${INVITE_NAME_MAX_LENGTH} characters long.`;
  }
  if (CONTROL_OR_FORMAT_RE.test(name)) {
    return "The name cannot contain control or invisible formatting characters.";
  }
  return null;
}

/**
 * Builds the absolute accept link for an invitation token, from
 * `APP_BASE_URL` or the `http://localhost:PORT` fallback (see
 * `buildDashboardUrl`).
 */
export function buildInviteUrl(
  appBaseUrl: string,
  port: number,
  token: string,
): { url: string; usedFallback: boolean } {
  return buildDashboardUrl(
    appBaseUrl,
    port,
    `/dashboard/invite?token=${encodeURIComponent(token)}`,
  );
}
