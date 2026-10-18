import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import type { ApiKeyDisabledReason } from "../../api-keys/types/api-key.types.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { templates } from "../../templates/models/template.schema.ts";
import { webhooks } from "../../webhooks/models/webhook.schema.ts";
import type { ContentRecordCounts, RecordCounts, Tx } from "../types/user.types.ts";

/**
 * Who owns the records users create (#219): `api_keys`, `templates`,
 * `domains` and `webhooks` each carry a nullable `created_by_user_id`.
 *
 * The rule everywhere: a row with no creator belongs to the owner. These
 * helpers keep that true across the account lifecycle. They take the
 * caller's transaction, which always holds the `bunmail:owner` advisory
 * lock (owner bootstrap, account management), so they never interleave
 * with a role change, a removal or an ownership transfer. They do not
 * log: the caller logs the counts with its own outcome line.
 */

/**
 * Sets `created_by_user_id = toUserId` on every template, domain and
 * webhook matching `where`, and returns how many rows of each changed.
 */
async function assignContentRecords(
  tx: Tx,
  toUserId: string,
  where: (column: AnyPgColumn) => SQL | undefined,
): Promise<ContentRecordCounts> {
  const templateRows = await tx
    .update(templates)
    .set({ createdByUserId: toUserId })
    .where(where(templates.createdByUserId))
    .returning({ id: templates.id });
  const domainRows = await tx
    .update(domains)
    .set({ createdByUserId: toUserId })
    .where(where(domains.createdByUserId))
    .returning({ id: domains.id });
  const webhookRows = await tx
    .update(webhooks)
    .set({ createdByUserId: toUserId })
    .where(where(webhooks.createdByUserId))
    .returning({ id: webhooks.id });
  return {
    templates: templateRows.length,
    domains: domainRows.length,
    webhooks: webhookRows.length,
  };
}

/**
 * Boot backfill (#219): every row with no creator, API keys included, is
 * assigned to the owner. Runs inside the owner bootstrap on every boot,
 * once an owner row exists (setup complete or still pending): on the
 * first boot after the upgrade it links every record made before
 * accounts existed, later boots find nothing (or only the rows of users
 * removed since).
 */
export async function assignUnownedRecords(
  tx: Tx,
  ownerId: string,
): Promise<RecordCounts> {
  const keys = await tx
    .update(apiKeys)
    .set({ createdByUserId: ownerId })
    .where(isNull(apiKeys.createdByUserId))
    .returning({ id: apiKeys.id });
  const content = await assignContentRecords(tx, ownerId, (column) => isNull(column));
  return { keys: keys.length, ...content };
}

/**
 * Ownership transfer (#219): the previous owner's templates, domains and
 * webhooks, and those with no creator (which belonged to the previous
 * owner by the rule), move to the new owner.
 *
 * API keys deliberately do NOT move: a key stays attributed to the user
 * who created it (and so may hold its secret), so demoting, deactivating
 * or removing the former owner later still reaches its admin keys.
 */
export function moveOwnerRecords(
  tx: Tx,
  fromUserId: string,
  toUserId: string,
): Promise<ContentRecordCounts> {
  return assignContentRecords(tx, toUserId, (column) =>
    or(eq(column, fromUserId), isNull(column)),
  );
}

/**
 * Disables every active API key `userId` created (#219), recording why
 * (`creator_deactivated` or `creator_removed`). Keys already inactive keep
 * their reason. Removal calls this before the user row is deleted, so a
 * key whose creator becomes null is never a live key of a removed user.
 * Reactivating the user re-enables nothing.
 *
 * @returns how many keys were disabled
 */
export async function disableKeysCreatedBy(
  tx: Tx,
  userId: string,
  reason: Exclude<ApiKeyDisabledReason, "revoked">,
): Promise<number> {
  const rows = await tx
    .update(apiKeys)
    .set({ isActive: false, disabledReason: reason })
    .where(and(eq(apiKeys.createdByUserId, userId), eq(apiKeys.isActive, true)))
    .returning({ id: apiKeys.id });
  return rows.length;
}

/**
 * Demotion of an admin to member (#219): every key `userId` created
 * becomes restricted (`is_admin = false`), active or not, so a member
 * never holds a management-plane key. Keys stay active: their sending
 * keeps working. Promotion back to admin restores nothing.
 *
 * @returns how many admin keys were downgraded
 */
export async function downgradeAdminKeysCreatedBy(
  tx: Tx,
  userId: string,
): Promise<number> {
  const rows = await tx
    .update(apiKeys)
    .set({ isAdmin: false })
    .where(and(eq(apiKeys.createdByUserId, userId), eq(apiKeys.isAdmin, true)))
    .returning({ id: apiKeys.id });
  return rows.length;
}
