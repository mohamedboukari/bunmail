import { eq, sql } from "drizzle-orm";
import { users } from "../models/user.schema.ts";
import { hasSecondFactor, hasSsoLink } from "../models/user-credential.schema.ts";
import {
  SECOND_FACTOR_TYPES,
  literals,
  type DbExecutor,
  type SessionClient,
  type Tx,
} from "../types/user.types.ts";
import { recordAuditEvent } from "../../audit/services/audit.service.ts";

/**
 * The owner rule of SSO (#224), kept true at every write that could break
 * it: **an owner with an SSO link always has a BunMail second factor**, so
 * a takeover at the provider (or by its administrator) never becomes a
 * one-factor way into the owner account.
 *
 * - Linking: the owner needs a second factor (`sso-link.service.ts`).
 * - Turning TOTP off and removing a passkey: refused for the owner when it
 *   would leave no second factor next to a link
 *   ({@link removalBreaksOwnerSsoRule}); the owner unlinks first.
 * - Transferring ownership: refused to an account holding a link without a
 *   second factor ({@link ssoLinkWithoutSecondFactor}).
 *
 * Resets (an admin-issued reset link, `reset-owner`) are not refused: they
 * remove the account's second factors on purpose (recovery), and they will
 * remove its SSO links with them (#224, part 4). Database errors are the
 * caller's (`withSanitizedErrors` around its transaction).
 */

/**
 * Locks the account's row (`FOR UPDATE`, inside the caller's transaction,
 * so a link or another removal racing this one waits) and says whether
 * removing the second factor `credentialId` would leave the owner with an
 * SSO link and no second factor. `false` for any other role, for an
 * account without a link, or when another second factor remains.
 */
export async function removalBreaksOwnerSsoRule(
  tx: Tx,
  userId: string,
  credentialId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({
      role: users.role,
      linked: hasSsoLink(users.id),
      othersRemain: sql<boolean>`EXISTS (SELECT 1 FROM "user_credentials" AS "other_factor" WHERE "other_factor"."user_id" = "users"."id" AND "other_factor"."type" IN (${literals(SECOND_FACTOR_TYPES)}) AND "other_factor"."id" <> ${credentialId})`,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  return row !== undefined && row.role === "owner" && row.linked && !row.othersRemain;
}

/**
 * Whether an account holds an SSO link without a BunMail second factor:
 * such an account may not become the owner. Read in the caller's
 * transaction when it holds the row lock (the ownership transfer does).
 */
export async function ssoLinkWithoutSecondFactor(
  executor: DbExecutor,
  userId: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ linked: hasSsoLink(users.id), factor: hasSecondFactor(users.id) })
    .from(users)
    .where(eq(users.id, userId));
  return row !== undefined && row.linked && !row.factor;
}

/**
 * Records a refused second-factor removal (`auth.two_factor.removal_refused`,
 * outcome `failure`) on its own, after the refusing transaction: never
 * fails the caller.
 */
export async function recordFactorRemovalRefused(
  userId: string,
  factor: "totp" | "passkey",
  client: SessionClient,
): Promise<void> {
  await recordAuditEvent({
    action: "auth.two_factor.removal_refused",
    outcome: "failure",
    actor: { type: "user", id: userId },
    ...client,
    target: { type: "user", id: userId },
    metadata: { factor, reason: "owner_sso_link" },
  });
}
