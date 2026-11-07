import { sql, type SQL } from "drizzle-orm";

/**
 * Value sets for the dashboard accounts schema (#214). Each is enforced by
 * a `CHECK` constraint in the database as well as by these types, so a
 * typo can never become a privilege: an unknown role is rejected on write.
 */

/** Exactly one `owner` (database-enforced), any number of admins and members. */
export const USER_ROLES = ["owner", "admin", "member"] as const;
/** A dashboard account's role; the guard (#222) ranks them owner > admin > member. */
export type UserRole = (typeof USER_ROLES)[number];

/** Narrows a stored `users.role` value to a known role (#222). */
export function isUserRole(value: string): value is UserRole {
  return USER_ROLES.some((role) => role === value);
}

/**
 * Login methods: `password`, `totp` (the second factor, #220), `passkey`
 * (WebAuthn, a first or second factor, #223) and `oauth` (an SSO link,
 * #224: a first factor only, never a second factor).
 */
export const CREDENTIAL_TYPES = ["password", "totp", "passkey", "oauth"] as const;
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/**
 * The credential types that count as a second factor (#220, #223): an
 * account holding any of them gets a `pending` session from the password
 * step, its `password` sessions are refused, and it satisfies
 * `REQUIRE_2FA`. Read by the one shared predicate, `hasSecondFactor`.
 */
export const SECOND_FACTOR_TYPES = ["totp", "passkey"] as const;

/**
 * How far a session has got through login. `pending` means the first
 * factor passed and a second one is still required; `password` is a
 * normal session; `mfa` passed a second factor. The auth guard (#222) can
 * require a minimum level per route.
 */
export const SESSION_ASSURANCES = ["pending", "password", "mfa"] as const;
export type SessionAssurance = (typeof SESSION_ASSURANCES)[number];

/** Narrows a stored `sessions.assurance` value to a known level (#222). */
export function isSessionAssurance(value: string): value is SessionAssurance {
  return SESSION_ASSURANCES.some((level) => level === value);
}

/** What a one-time token is for. */
export const TOKEN_PURPOSES = ["owner_setup", "invite", "password_reset"] as const;
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

/**
 * Renders a value set as a quoted SQL list for a `CHECK (... IN (...))`
 * constraint: `'owner', 'admin', 'member'`. These are code constants, never
 * user input, so inlining them is safe; bound parameters are not valid in
 * DDL and drizzle-kit would emit `$1, $2` placeholders into the migration.
 */
export function literals(values: readonly string[]): SQL {
  return sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", "));
}
