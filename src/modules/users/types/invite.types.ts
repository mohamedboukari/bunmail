import type { UserRole } from "./user-value-sets.types.ts";

/** Invitation types (#217). Re-exported by `user.types.ts`. */

/**
 * Roles an invitation can grant (#217). Never `owner`: ownership moves
 * only by transfer. Enforced by `user_tokens_invite_check` in the
 * database as well as by the invite service.
 */
export const INVITE_ROLES = ["admin", "member"] as const;
/** A role an invitation can grant. */
export type InviteRole = (typeof INVITE_ROLES)[number];

/** Narrows a submitted or stored role to one an invitation can grant (#217). */
export function isInviteRole(value: string): value is InviteRole {
  return INVITE_ROLES.some((role) => role === value);
}

/** The signed-in account acting on invitations (from the guard's `auth`, #222). */
export interface InviteActor {
  /** `users.id` of the actor; stored as `invited_by` on a new invitation. */
  id: string;
  /** The actor's role, read with the session on every request. */
  role: UserRole;
}

/**
 * Why an invitation was not created, resent or revoked (#217):
 *
 * - `invalid_email`: the address is not one bare, well-formed address.
 * - `role_not_allowed`: the actor's role cannot grant (or manage) that role.
 * - `account_exists`: an account already holds the address.
 * - `pending_higher_role`: a live invitation for the address grants a role
 *   the actor cannot grant, so the actor may not replace (or downgrade) it.
 * - `not_found`: no pending invitation has that id.
 */
export type InviteRefusal =
  | "invalid_email"
  | "role_not_allowed"
  | "account_exists"
  | "pending_higher_role"
  | "not_found";

/**
 * Why the invitation email did not go out (#217), so the inviter can be
 * told to share the link by hand:
 *
 * - `not_configured`: `SYSTEM_MAIL_FROM` is not set.
 * - `sender_unavailable`: its domain is not registered in BunMail, not
 *   DKIM-verified, or its DKIM key cannot be used.
 * - `send_failed`: the send threw or no MX group accepted the message.
 * - `no_base_url`: `APP_BASE_URL` is unset or not an `http(s)://` URL, so
 *   the link would point at `localhost`; it is never emailed.
 */
export type InviteMailFailure =
  "not_configured" | "sender_unavailable" | "send_failed" | "no_base_url";

/** Outcome of sending an invitation email (#217). */
export type InviteMailOutcome =
  { sent: true } | { sent: false; reason: InviteMailFailure };

/**
 * A freshly minted invitation (#217). `token` is the raw value for the
 * accept link: it goes into the email or the one-time reveal, never into
 * storage, a URL of ours, a flash message or a log.
 */
export interface IssuedInvitation {
  /** `user_tokens.id` (`utk_...`); safe to log. */
  invitationId: string;
  /** Raw token for `/dashboard/invite?token=`; only its hash is stored. */
  token: string;
  /** The invited address, trimmed and lower-cased. PII: log it redacted. */
  email: string;
  /** Role the invitation grants. */
  role: InviteRole;
  /** When the link stops working. */
  expiresAt: Date;
  /** How many earlier open invitations for the address this one replaced. */
  replaced: number;
}

/**
 * Result of creating or resending an invitation (#217): the new
 * invitation, its absolute accept link and whether the email went out,
 * or why nothing was issued.
 */
export type IssueInvitationResult =
  | {
      ok: true;
      invitation: IssuedInvitation;
      /** Absolute accept link; shown to the inviter once when the email did not go out. */
      url: string;
      delivery: InviteMailOutcome;
    }
  | { ok: false; reason: InviteRefusal };

/** A pending invitation as the Invitations page lists it (#217). */
export interface PendingInvitation {
  /** `user_tokens.id`. */
  id: string;
  /** The invited address (lower-cased). */
  email: string;
  /** Role the invitation grants. */
  role: InviteRole;
  /** Name or email of the inviter, or `null` when that account is gone. */
  invitedBy: string | null;
  createdAt: Date;
  expiresAt: Date;
}

/** What a live invitation token opens (#217): the accept form's subject. */
export interface InviteTarget {
  /** `user_tokens.id`; safe to log. */
  invitationId: string;
  /** The invited address (lower-cased), shown on the form. */
  email: string;
  /** Role the new account will get. */
  role: InviteRole;
}

/** The new account's details from the accept form (#217). */
export interface InviteAcceptance {
  /** Display name, already trimmed and checked (`inviteNameProblem`). */
  name: string;
  /** Password, already checked against the setup policy. */
  password: string;
}

/**
 * Result of accepting an invitation (#217). `invalid` covers every dead
 * token (unknown, expired, used, revoked); `account_exists` means an
 * account took the address after the invitation was sent.
 */
export type AcceptInvitationResult =
  | {
      ok: true;
      /** `users.id` of the new account. */
      userId: string;
      /** The new account's email (lower-cased). PII: log it redacted. */
      email: string;
      role: InviteRole;
      /** Who sent the invitation, or `null` when that account is gone. */
      invitedBy: string | null;
      /** `sessions.id` of the session opened for the new account. */
      sessionId: string;
      /** Raw cookie value of that session. */
      sessionToken: string;
    }
  | { ok: false; reason: "invalid" | "account_exists" };
