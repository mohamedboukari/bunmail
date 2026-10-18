import { and, asc, eq, exists, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { apiKeys } from "../models/api-key.schema.ts";
import { users } from "../../users/models/user.schema.ts";
import { ApiKeyCreatorInactiveError } from "../errors.ts";
import { generateId } from "../../../utils/id.ts";
import { generateApiKey } from "../../../utils/crypto.ts";
import { logger } from "../../../utils/logger.ts";
import type {
  ApiKey,
  CreateApiKeyInput,
  KeyActor,
  SetApiKeyAdminResult,
  UpdateApiKeyInput,
} from "../types/api-key.types.ts";

/** Roles whose keys may be admin keys (#219). */
const ADMIN_ROLES = ["admin", "owner"];

/**
 * True when `actor` manages every key (#219): admins and the owner. A
 * member manages only the keys it created.
 */
function managesAllKeys(actor: KeyActor): boolean {
  return actor.role === "admin" || actor.role === "owner";
}

/**
 * The extra `WHERE` condition that confines a dashboard actor to the keys
 * it may see and change (#219): a member's own keys
 * (`created_by_user_id` = its id); nothing extra for admins and the
 * owner, or when there is no actor (REST management plane, admin keys
 * only). A key a member does not own then matches no row, exactly like a
 * key that does not exist, so its existence never leaks.
 */
function keyScope(actor: KeyActor | undefined): SQL | undefined {
  if (!actor || managesAllKeys(actor)) return undefined;
  return eq(apiKeys.createdByUserId, actor.id);
}

/**
 * Normalises an allowed-senders list: trims, lower-cases, drops empties,
 * and de-duplicates. Stored form is lower-cased so the `createEmail` gate
 * can compare case-insensitively against the message's `From`. (#126)
 */
function normaliseAllowedSenders(list: string[] | undefined): string[] {
  if (!list) return [];
  const seen = new Set<string>();
  for (const raw of list) {
    const addr = raw?.trim().toLowerCase();
    if (addr) seen.add(addr);
  }
  return Array.from(seen);
}

/**
 * Creates a new API key.
 *
 * Generates a cryptographically random key (`bm_live_<hex>`), hashes it
 * with SHA-256, and stores only the hash. The raw key is returned once
 * in the response: it cannot be retrieved again.
 *
 * Ownership (#219): with an `actor` (the dashboard), the key belongs to
 * that user; without one (REST, seed script), `input.createdByUserId` is
 * recorded (REST: the calling key's creator; null = the owner).
 *
 * When the key has a creator, the insert runs in a transaction that
 * first reads the creator's row `FOR SHARE`, which conflicts with the
 * account actions' `FOR NO KEY UPDATE`: a create cannot interleave with a
 * deactivation, removal or demotion of its creator. A creator that is
 * gone or deactivated is refused (`ApiKeyCreatorInactiveError`), and the
 * key is an admin key only when `isAdmin` was asked for AND the creator's
 * LIVE role is admin or owner (a member's key is always restricted,
 * whatever the form or the session said).
 *
 * @param input - Contains the human-readable name for the key
 * @param actor - The signed-in dashboard account creating the key, if any
 * @returns The created API key row AND the raw key (shown once)
 * @throws ApiKeyCreatorInactiveError when the creator is gone or deactivated
 */
export async function createApiKey(
  input: CreateApiKeyInput,
  actor?: KeyActor,
): Promise<{ apiKey: ApiKey; rawKey: string }> {
  /** Generate a unique prefixed ID for this key */
  const id = generateId("key");

  /** Generate the raw key, its SHA-256 hash, and the display prefix */
  const { raw, hash, prefix } = generateApiKey();

  const createdByUserId = actor ? actor.id : (input.createdByUserId ?? null);
  /** Default restricted; only the dashboard (admins, owner) and seed ask for `true` (#130). */
  const requestedAdmin = input.isAdmin ?? false;

  logger.info("Creating API key", { id, name: input.name, prefix, createdByUserId });

  const values = {
    id,
    name: input.name,
    keyHash: hash,
    keyPrefix: prefix,
    allowedSenders: normaliseAllowedSenders(input.allowedSenders),
    createdByUserId,
  };

  let apiKey: ApiKey | undefined;
  if (createdByUserId === null) {
    /** The owner's key (no creator row to check): as requested. */
    [apiKey] = await db
      .insert(apiKeys)
      .values({ ...values, isAdmin: requestedAdmin })
      .returning();
  } else {
    apiKey = await db.transaction(async (tx) => {
      const [creator] = await tx
        .select({ role: users.role, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, createdByUserId))
        .for("share");
      if (!creator || creator.disabledAt !== null) {
        logger.warn("API key create refused: creator missing or deactivated", {
          id,
          createdByUserId,
        });
        throw new ApiKeyCreatorInactiveError();
      }
      const isAdmin = requestedAdmin && ADMIN_ROLES.includes(creator.role);
      const [row] = await tx
        .insert(apiKeys)
        .values({ ...values, isAdmin })
        .returning();
      return row;
    });
  }
  if (!apiKey) throw new Error("API key insert returned no row");

  logger.info("API key created", {
    id: apiKey.id,
    name: apiKey.name,
    isAdmin: apiKey.isAdmin,
    allowedSenders: apiKey.allowedSenders.length,
    createdByUserId: apiKey.createdByUserId,
    ...(requestedAdmin && !apiKey.isAdmin ? { adminRequestIgnored: true } : {}),
  });

  return { apiKey, rawKey: raw };
}

/**
 * The key a dashboard create attaches a template or webhook to (#219):
 * the actor's own oldest active key; for admins and the owner, when they
 * have none, the oldest active key of anyone. A member never borrows
 * another account's key, so it gets `undefined` without one of its own.
 *
 * @param actor - The signed-in dashboard account
 * @returns The key to use, or undefined when there is none
 */
export async function findDashboardKeyFor(actor: KeyActor): Promise<ApiKey | undefined> {
  const active = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.isActive, true), keyScope(actor)))
    .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id));
  return active.find((key) => key.createdByUserId === actor.id) ?? active[0];
}

/**
 * Updates mutable fields on an API key (#126): `name` and/or the
 * `allowedSenders` allowlist. Only provided fields change; `allowedSenders`
 * replaces the whole list (add = include, remove = omit), normalised.
 *
 * With a dashboard `actor` (#219), a member can only update its own keys:
 * anyone else's key is "not found".
 *
 * @param id - The API key ID to update
 * @param input - Fields to change (all optional)
 * @param actor - The signed-in dashboard account, if any
 * @returns The updated row, or undefined if no key with that ID exists
 *          (or the actor may not see it)
 */
export async function updateApiKey(
  id: string,
  input: UpdateApiKeyInput,
  actor?: KeyActor,
): Promise<ApiKey | undefined> {
  const set: Partial<typeof apiKeys.$inferInsert> = {};
  if (input.name !== undefined) set.name = input.name;
  if (input.allowedSenders !== undefined) {
    set.allowedSenders = normaliseAllowedSenders(input.allowedSenders);
  }

  /** Nothing to change: return the current row (or undefined if missing). */
  if (Object.keys(set).length === 0) {
    const [current] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), keyScope(actor)));
    return current;
  }

  logger.info("Updating API key", { id, fields: Object.keys(set), actorId: actor?.id });

  const [apiKey] = await db
    .update(apiKeys)
    .set(set)
    .where(and(eq(apiKeys.id, id), keyScope(actor)))
    .returning();

  if (!apiKey) {
    logger.warn("API key not found for update", { id, actorId: actor?.id });
    return undefined;
  }

  return apiKey;
}

/**
 * Lists API keys (without hashes).
 *
 * Returns every key in the database, active and revoked, or with a
 * member `actor` (#219, dashboard) only the keys that member created. The
 * serializer strips keyHash from the response so no secrets are leaked.
 *
 * @param actor - The signed-in dashboard account, if any
 * @returns Array of API key rows
 */
export async function listApiKeys(actor?: KeyActor): Promise<ApiKey[]> {
  logger.debug("Listing API keys", { actorId: actor?.id });

  const keys = await db.select().from(apiKeys).where(keyScope(actor));

  logger.debug("API keys listed", { count: keys.length });

  return keys;
}

/**
 * Revokes (soft-deletes) an API key by setting `is_active` to false.
 *
 * The key row stays in the database for audit purposes, but the auth
 * middleware will reject any request using this key.
 *
 * The reason is recorded as `revoked` (#219), unless the key was already
 * disabled for another reason, which is kept. With a dashboard `actor`,
 * a member can only revoke its own keys: anyone else's is "not found".
 *
 * @param id - The API key ID to revoke (e.g. "key_a1b2c3...")
 * @param actor - The signed-in dashboard account, if any
 * @returns The updated API key row, or undefined if not found (or the
 *          actor may not see it)
 */
export async function revokeApiKey(
  id: string,
  actor?: KeyActor,
): Promise<ApiKey | undefined> {
  logger.info("Revoking API key", { id, actorId: actor?.id });

  const [apiKey] = await db
    .update(apiKeys)
    .set({
      isActive: false,
      disabledReason: sql`COALESCE(${apiKeys.disabledReason}, 'revoked')`,
    })
    .where(and(eq(apiKeys.id, id), keyScope(actor)))
    .returning();

  if (!apiKey) {
    logger.warn("API key not found for revocation", { id, actorId: actor?.id });
    return undefined;
  }

  logger.info("API key revoked", { id: apiKey.id, name: apiKey.name });

  return apiKey;
}

/**
 * Finds an API key by the SHA-256 hash of its raw token.
 *
 * Used by the SMTP submission AUTH to look up the key from the password
 * a client presents: hash the token → find the matching row. A key whose
 * creator exists but is deactivated (#219) is treated as unknown, even if
 * `is_active` were somehow still true; a key with no creator (the
 * owner's) is unaffected.
 *
 * @param hash - SHA-256 hex digest of the raw API key
 * @returns The matching API key row, or undefined if not found or unusable
 */
export async function findByHash(hash: string): Promise<ApiKey | undefined> {
  const [row] = await db
    .select({ apiKey: apiKeys, creatorDisabledAt: users.disabledAt })
    .from(apiKeys)
    .leftJoin(users, eq(users.id, apiKeys.createdByUserId))
    .where(eq(apiKeys.keyHash, hash));

  if (!row) return undefined;
  if (row.creatorDisabledAt !== null) {
    logger.warn("API key lookup refused: creator deactivated", {
      apiKeyId: row.apiKey.id,
    });
    return undefined;
  }
  return row.apiKey;
}

/**
 * Finds an API key by its ID. Used by the `createEmail` sender-authorization
 * gate (#126) to read the key's `allowedSenders`, and by `updateApiKey`.
 *
 * @param id - The API key ID (e.g. "key_a1b2c3...")
 * @returns The matching API key row, or undefined if not found
 */
export async function findById(id: string): Promise<ApiKey | undefined> {
  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));

  return apiKey;
}

/**
 * Promotes/demotes a key's admin flag (#130). **Operator-only**: this is a
 * privilege boundary, so it is deliberately NOT reachable from any REST DTO;
 * only the dashboard (operator session) calls it. Keeping it off
 * `updateApiKey` (which the REST `PATCH` uses) guarantees an API key can
 * never grant itself or another key admin.
 *
 * Promotion (#219) is one conditional `UPDATE`: it applies only when the
 * key has no creator (the owner's) or its creator is an active admin or
 * the owner, checked in the same statement, so it cannot race a demotion
 * or deactivation of the creator. A member's key is never made admin.
 * Demotion is unconditional.
 *
 * @param id - The API key ID
 * @param isAdmin - New admin state
 * @returns The updated row, or why nothing changed
 */
export async function setApiKeyAdmin(
  id: string,
  isAdmin: boolean,
): Promise<SetApiKeyAdminResult> {
  logger.info("Setting API key admin flag", { id, isAdmin });

  const creatorMayHoldAdmin = or(
    isNull(apiKeys.createdByUserId),
    exists(
      db
        .select({ one: sql`1` })
        .from(users)
        .where(
          and(
            eq(users.id, apiKeys.createdByUserId),
            inArray(users.role, ADMIN_ROLES),
            isNull(users.disabledAt),
          ),
        ),
    ),
  );

  const [apiKey] = await db
    .update(apiKeys)
    .set({ isAdmin })
    .where(isAdmin ? and(eq(apiKeys.id, id), creatorMayHoldAdmin) : eq(apiKeys.id, id))
    .returning();

  if (apiKey) return { ok: true, apiKey };

  const current = await findById(id);
  if (!current) {
    logger.warn("API key not found for admin flag update", { id });
    return { ok: false, reason: "not_found" };
  }
  logger.warn("API key promotion refused: creator is not an active admin or owner", {
    id,
    createdByUserId: current.createdByUserId,
  });
  return { ok: false, reason: "creator_not_admin" };
}
