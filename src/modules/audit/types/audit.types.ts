/**
 * Types of the audit log (#221): who did what, when, from where, to what.
 *
 * Every action is a code-level string with its own metadata shape
 * (`AuditMetadataByAction`), so a call site cannot attach a field the
 * action does not declare. Metadata carries identifiers, counts, roles and
 * reasons only: never a password, token, hash, key, code or message
 * content (`recordAuditEvent` drops a secret-looking key as a last line
 * of defence).
 */

/** Who performed an action: a dashboard user, an API key, or BunMail itself. */
export const AUDIT_ACTOR_TYPES = ["user", "api_key", "system"] as const;

/** Whether the action took effect. */
export const AUDIT_OUTCOMES = ["success", "failure"] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

/** Narrows a query value to an outcome. */
export function isAuditOutcome(value: string | undefined): value is AuditOutcome {
  return AUDIT_OUTCOMES.some((outcome) => outcome === value);
}

/**
 * The actor of an event. A `label` left `undefined` is filled in from the
 * live row when the event is written (the user's email, the key's name),
 * so it survives a later deletion; `null` stores no label.
 *
 * A `user` actor without an id is an unidentified sign-in attempt (an
 * email that matches no account): the typed address is never stored.
 */
export type AuditActor =
  | { type: "user"; id: string | null; label?: string | null }
  | { type: "api_key"; id: string; label?: string | null }
  | { type: "system"; label: string };

/** What an event acted on. */
export type AuditTargetType =
  | "user"
  | "session"
  | "passkey"
  | "invitation"
  | "password_reset"
  | "owner_setup"
  | "api_key"
  | "domain"
  | "webhook"
  | "suppression"
  | "audit_log";

/**
 * The target of an event. As for the actor, a `label` left `undefined`
 * is read from the live row for users, API keys, domains and webhooks.
 */
export interface AuditTarget {
  type: AuditTargetType;
  id: string | null;
  label?: string | null;
}

/** Request metadata stored with an event. */
export interface AuditClient {
  /** Resolved client IP; anything that is not an IP literal is stored as null. */
  ip: string | null;
  /** Raw `User-Agent` header; cut to 256 characters before it is stored. */
  userAgent: string | null;
}

/** Who acts, and from where: what a route hands a service to record with. */
export interface AuditContext extends AuditClient {
  actor: AuditActor;
}

/** Why a sign-in step failed, as the audit log records it. */
export type AuditLoginFailureReason =
  | "unknown_account"
  | "no_password"
  | "deactivated"
  | "wrong_password"
  | "input_too_long"
  | "credential_replaced"
  | "wrong_code"
  | "passkey_rejected"
  | "unknown_passkey"
  | "passkey_counter_regressed";

/** How a sign-in was completed (`passkey`: WebAuthn, alone or as the second step, #223). */
type AuditSignInMethod = "password" | "totp" | "recovery_code" | "passkey";

/** The role an account or invitation carries. */
type AuditRole = "owner" | "admin" | "member";

/**
 * The metadata each action stores (`null`: none). Keys are deliberately
 * plain: no field may hold a secret, and none is named like one.
 */
export interface AuditMetadataByAction {
  "auth.login.succeeded": { method: AuditSignInMethod; recoveryCodesLeft?: number };
  "auth.login.failed": {
    /** `passkey`: a passwordless sign-in with a passkey (#223). */
    step: "password" | "two_factor" | "passkey";
    reason: AuditLoginFailureReason;
  };
  "auth.login.rate_limited": { retryAfterSec: number };
  "auth.login.two_factor_required": null;
  "auth.login.two_factor_locked": null;
  "auth.logout": null;
  "auth.session.revoked": { current: boolean; reason: "user" | "code_budget_spent" };
  "auth.session.others_revoked": { sessionsRevoked: number };
  "auth.session.token_reuse_detected": null;
  "auth.two_factor.enabled": { sessionsRevoked: number };
  "auth.two_factor.disabled": { method: "totp" | "recovery_code" };
  "auth.two_factor.recovery_codes_regenerated": null;
  "auth.two_factor.removed": {
    via: "password_reset" | "owner_setup";
    /** Whether the TOTP credential went, and how many passkeys (#223). */
    totp: boolean;
    passkeys: number;
  };
  "auth.passkey.added": { sessionsRevoked: number };
  "auth.passkey.removed": null;
  "auth.passkey.counter_regressed": { storedCounter: number; receivedCounter: number };
  "auth.password.changed": { sessionsRevoked: number };
  "auth.password_reset.issued": { expiresAt: string; linksReplaced: number };
  "auth.password_reset.completed": { issuedBy: string; sessionsRevoked: number };
  "auth.owner_setup.issued": { via: "boot" | "reset_owner"; sessionsRevoked: number };
  "auth.owner_setup.completed": null;
  "user.invitation.created": { role: AuditRole; replaced: number };
  "user.invitation.resent": { role: AuditRole; previousInvitationId: string };
  "user.invitation.revoked": { role: AuditRole };
  "user.invitation.accepted": { role: AuditRole; invitedBy: string | null };
  "user.role.changed": { from: AuditRole; to: AuditRole };
  "user.deactivated": { sessionsRevoked: number; keysDisabled: number };
  "user.reactivated": null;
  "user.removed": { role: AuditRole; keysDisabled: number };
  "user.ownership.transferred": { reason?: "wrong_password" };
  "api_key.created": { isAdmin: boolean; allowedSenders: number };
  "api_key.updated": { fields: string[]; allowedSenders?: number };
  "api_key.admin_changed": { isAdmin: boolean };
  "api_key.revoked": null;
  "domain.created": null;
  "domain.updated": { fields: string[] };
  "domain.verified": { spf: boolean; dkim: boolean; dmarc: boolean };
  "domain.deleted": null;
  "domain.dkim_rotation_started": { selector: string };
  "domain.dkim_rotation_completed": { selector: string };
  "domain.dkim_rotation_cancelled": { selector: string };
  "webhook.created": { events: string[] };
  "webhook.deleted": null;
  "suppression.created": { reason: string };
  "suppression.deleted": null;
  "audit_log.purged": { deleted: number; retentionDays: number };
}

/** Every recorded action. */
export type AuditAction = keyof AuditMetadataByAction;

/**
 * Human labels for the dashboard (#221). A `Record` over every action, so
 * adding an action without a label does not compile; it is also the
 * runtime list of actions (the page's filter and `isAuditAction`).
 */
export const AUDIT_ACTION_LABELS: { readonly [A in AuditAction]: string } = {
  "auth.login.succeeded": "Signed in",
  "auth.login.failed": "Sign-in failed",
  "auth.login.rate_limited": "Sign-in rate limited",
  "auth.login.two_factor_required": "Password accepted, second factor required",
  "auth.login.two_factor_locked": "Sign-in locked: too many invalid codes",
  "auth.logout": "Signed out",
  "auth.session.revoked": "Session revoked",
  "auth.session.others_revoked": "Other sessions revoked",
  "auth.session.token_reuse_detected": "Session token reuse: all sessions revoked",
  "auth.two_factor.enabled": "Two-factor authentication enabled",
  "auth.two_factor.disabled": "Two-factor authentication disabled",
  "auth.two_factor.recovery_codes_regenerated": "Recovery codes regenerated",
  "auth.two_factor.removed": "Second factors removed by a reset",
  "auth.passkey.added": "Passkey added",
  "auth.passkey.removed": "Passkey removed",
  "auth.passkey.counter_regressed":
    "Passkey refused: signature counter went back (possible clone)",
  "auth.password.changed": "Password changed",
  "auth.password_reset.issued": "Password reset link issued",
  "auth.password_reset.completed": "Password reset completed",
  "auth.owner_setup.issued": "Owner setup link issued",
  "auth.owner_setup.completed": "Owner setup completed",
  "user.invitation.created": "Invitation created",
  "user.invitation.resent": "Invitation resent",
  "user.invitation.revoked": "Invitation revoked",
  "user.invitation.accepted": "Invitation accepted",
  "user.role.changed": "Role changed",
  "user.deactivated": "Account deactivated",
  "user.reactivated": "Account reactivated",
  "user.removed": "Account removed",
  "user.ownership.transferred": "Ownership transferred",
  "api_key.created": "API key created",
  "api_key.updated": "API key updated",
  "api_key.admin_changed": "API key admin flag changed",
  "api_key.revoked": "API key revoked",
  "domain.created": "Domain added",
  "domain.updated": "Domain settings changed",
  "domain.verified": "Domain DNS verified",
  "domain.deleted": "Domain deleted",
  "domain.dkim_rotation_started": "DKIM key rotation started",
  "domain.dkim_rotation_completed": "DKIM key rotation completed",
  "domain.dkim_rotation_cancelled": "DKIM key rotation cancelled",
  "webhook.created": "Webhook created",
  "webhook.deleted": "Webhook deleted",
  "suppression.created": "Suppression added",
  "suppression.deleted": "Suppression removed",
  "audit_log.purged": "Old audit entries purged",
};

/** Narrows a string (a stored value, a query value) to a known action. */
export function isAuditAction(value: string | undefined): value is AuditAction {
  return value !== undefined && Object.hasOwn(AUDIT_ACTION_LABELS, value);
}

/** Every action, in label order of declaration, for the page's filter. */
export const AUDIT_ACTIONS: readonly AuditAction[] =
  Object.keys(AUDIT_ACTION_LABELS).filter(isAuditAction);

/**
 * One event to record. `metadata` is required exactly when the action
 * declares a shape; `outcome` defaults to `success`.
 */
export type AuditEventInput<A extends AuditAction = AuditAction> = {
  action: A;
  outcome?: AuditOutcome;
  actor: AuditActor;
  ip?: string | null;
  userAgent?: string | null;
  target?: AuditTarget;
} & (AuditMetadataByAction[A] extends null
  ? { metadata?: null }
  : { metadata: AuditMetadataByAction[A] });

/** A stored event, as the dashboard reads it. */
export interface AuditEvent {
  id: string;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  outcome: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
}

/** Filters of the audit log page. */
export interface AuditEventFilters {
  action?: AuditAction;
  /** `{ type, id }` of one actor, or `{ type: "system" }`. */
  actor?: { type: "user" | "api_key"; id: string } | { type: "system" };
  outcome?: AuditOutcome;
  page: number;
  limit: number;
}

/** An actor that appears in the log, for the page's actor filter. */
export interface AuditActorOption {
  type: "user" | "api_key";
  id: string;
  /** Its most recent label, or null. */
  label: string | null;
}
