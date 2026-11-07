import type { RemovedSsoLink } from "./sso.types.ts";
import type { RemovedSecondFactors } from "./two-factor.types.ts";

/**
 * Owner bootstrap and setup (#215, #216) and record ownership (#219)
 * types. Re-exported by `user.types.ts`.
 */

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
 * Templates, domains and webhooks whose creator an ownership transfer
 * changed (#219). API keys never move. Logged as counts, never IDs.
 */
export interface ContentRecordCounts {
  templates: number;
  domains: number;
  webhooks: number;
}

/**
 * Rows per table the boot backfill assigned to the owner (#219), API
 * keys included. Logged as counts, never IDs.
 */
export interface RecordCounts extends ContentRecordCounts {
  /** `api_keys` rows. */
  keys: number;
}

/** What a completed owner setup returns (#215, #216). */
export interface CompletedOwnerSetup {
  /** `users.id` of the owner. */
  userId: string;
  /** The owner's stored (lower-cased) email. */
  email: string;
  /** Raw cookie value of the session opened for the owner. */
  sessionToken: string;
  /** A second factor of the owner was removed (#220, #223, reset-owner recovery). */
  twoFactorRemoved: boolean;
  /** What exactly was removed, for the security email (#223). */
  secondFactorsRemoved: RemovedSecondFactors;
  /** The owner's SSO links removed with them (#224), with the sessions they opened. */
  ssoLinksRemoved: RemovedSsoLink[];
}
