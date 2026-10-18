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
export type TokenPurpose = (typeof TOKEN_PURPOSES)[number];

/**
 * A freshly minted owner setup link (#215). `token` is the raw value for
 * the URL: it is shown once (log line or terminal) and never stored.
 */
export interface OwnerSetupLink {
  /** Raw token to put in `/dashboard/setup?token=`; only its hash is stored. */
  token: string;
  /** The owner's stored (lower-cased) email. */
  email: string;
  /** When the link stops working. */
  expiresAt: Date;
}

/**
 * What the boot-time owner bootstrap did (#215), so `src/index.ts` can log
 * the right line:
 *
 * - `created`: no owner existed; one was created with a setup link.
 * - `reissued`: the owner exists but has not set a password yet; the old
 *   link was revoked and a new one minted.
 * - `complete`: the owner has a password and the configured email matches.
 * - `mismatch`: the owner has a password and the configured email differs;
 *   nothing changed (ownership moves only by transfer).
 * - `email-taken`: a non-owner account already holds the configured email;
 *   nothing changed (an env value never promotes an existing account).
 */
export type OwnerBootstrapResult =
  | ({ kind: "created" | "reissued" } & OwnerSetupLink)
  | { kind: "complete" }
  | { kind: "mismatch"; storedEmail: string }
  | { kind: "email-taken" };

/**
 * Renders a value set as a quoted SQL list for a `CHECK (... IN (...))`
 * constraint: `'owner', 'admin', 'member'`. These are code constants, never
 * user input, so inlining them is safe; bound parameters are not valid in
 * DDL and drizzle-kit would emit `$1, $2` placeholders into the migration.
 */
export function literals(values: readonly string[]): SQL {
  return sql.raw(values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", "));
}
