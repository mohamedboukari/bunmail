import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { apiKeys } from "../models/api-key.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { generateApiKey } from "../../../utils/crypto.ts";
import { logger } from "../../../utils/logger.ts";
import type { ApiKey, CreateApiKeyInput } from "../types/api-key.types.ts";

/**
 * Creates a new API key.
 *
 * Generates a cryptographically random key (`bm_live_<hex>`), hashes it
 * with SHA-256, and stores only the hash. The raw key is returned once
 * in the response — it cannot be retrieved again.
 *
 * @param input - Contains the human-readable name for the key
 * @returns The created API key row AND the raw key (shown once)
 */
export async function createApiKey(
  input: CreateApiKeyInput,
): Promise<{ apiKey: ApiKey; rawKey: string }> {
  /** Generate a unique prefixed ID for this key */
  const id = generateId("key");

  /** Generate the raw key, its SHA-256 hash, and the display prefix */
  const { raw, hash, prefix } = generateApiKey();

  logger.info("Creating API key", { id, name: input.name, prefix });

  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      id,
      name: input.name,
      keyHash: hash,
      keyPrefix: prefix,
    })
    .returning();

  logger.info("API key created", { id: apiKey!.id, name: apiKey!.name });

  return { apiKey: apiKey!, rawKey: raw };
}

/**
 * Lists all API keys (without hashes).
 *
 * Returns every key in the database — active and revoked. The serializer
 * strips keyHash from the response so no secrets are leaked.
 *
 * @returns Array of all API key rows
 */
export async function listApiKeys(): Promise<ApiKey[]> {
  logger.debug("Listing all API keys");

  const keys = await db.select().from(apiKeys);

  logger.debug("API keys listed", { count: keys.length });

  return keys;
}

/**
 * Revokes (soft-deletes) an API key by setting `is_active` to false.
 *
 * The key row stays in the database for audit purposes, but the auth
 * middleware will reject any request using this key.
 *
 * @param id - The API key ID to revoke (e.g. "key_a1b2c3...")
 * @returns The updated API key row, or undefined if not found
 */
export async function revokeApiKey(id: string): Promise<ApiKey | undefined> {
  logger.info("Revoking API key", { id });

  const [apiKey] = await db
    .update(apiKeys)
    .set({ isActive: false })
    .where(eq(apiKeys.id, id))
    .returning();

  if (!apiKey) {
    logger.warn("API key not found for revocation", { id });
    return undefined;
  }

  logger.info("API key revoked", { id: apiKey.id, name: apiKey.name });

  return apiKey;
}

/**
 * Finds an API key by the SHA-256 hash of its raw token.
 *
 * Used by the auth middleware to look up the key from an incoming
 * Bearer token: hash the token → find the matching row.
 *
 * @param hash - SHA-256 hex digest of the raw API key
 * @returns The matching API key row, or undefined if not found
 */
export async function findByHash(hash: string): Promise<ApiKey | undefined> {
  const [apiKey] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash));

  return apiKey;
}
