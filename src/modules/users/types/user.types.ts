import { sql, type SQL } from "drizzle-orm";

/**
 * Value sets for the dashboard accounts schema (#214). Each is enforced by
 * a `CHECK` constraint in the database as well as by these types, so a
 * typo can never become a privilege: an unknown role is rejected on write.
 */

/** Exactly one `owner` (database-enforced), any number of admins and members. */
export const USER_ROLES = ["owner", "admin", "member"] as const;
/** @public Consumed by the login, invite and guard flows (#215 to #218); exported ahead of them. */
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Login methods. `password` is the only one implemented; the others are
 * reserved so 2FA (#220), passkeys (#223) and OAuth/SSO (#224) can add rows
 * without a schema change.
 */
export const CREDENTIAL_TYPES = ["password", "totp", "passkey", "oauth"] as const;
/** @public Consumed by the login, invite and guard flows (#215 to #218); exported ahead of them. */
export type CredentialType = (typeof CREDENTIAL_TYPES)[number];

/**
 * How far a session has got through login. `pending` means the first
 * factor passed and a second one is still required; `password` is a
 * normal session; `mfa` passed a second factor. The auth guard (#222) can
 * require a minimum level per route.
 */
export const SESSION_ASSURANCES = ["pending", "password", "mfa"] as const;
/** @public Consumed by the login, invite and guard flows (#215 to #218); exported ahead of them. */
export type SessionAssurance = (typeof SESSION_ASSURANCES)[number];

/** What a one-time token is for. */
export const TOKEN_PURPOSES = ["owner_setup", "invite", "password_reset"] as const;
/** @public Consumed by the login, invite and guard flows (#215 to #218); exported ahead of them. */
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
