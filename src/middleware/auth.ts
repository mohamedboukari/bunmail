import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { apiKeys } from "../modules/api-keys/models/api-key.schema.ts";
import { hashApiKey } from "../utils/crypto.ts";
import { logger } from "../utils/logger.ts";

/**
 * Auth middleware — validates Bearer tokens on every request.
 *
 * Flow:
 * 1. Extract `Authorization: Bearer <token>` from the request header
 * 2. SHA-256 hash the token
 * 3. Look up the hash in the `api_keys` table
 * 4. Reject if missing, inactive, or not found
 * 5. Update `last_used_at` timestamp (fire-and-forget, non-blocking)
 * 6. Derive `apiKeyId` and `apiKeyName` into the request context
 *
 * Usage: `.use(authMiddleware)` on any Elysia plugin that needs protection.
 * Routes without this middleware (e.g. /health) remain public.
 */
export const authMiddleware = new Elysia({ name: "auth-middleware" }).derive(
  async ({ request, set }) => {
    /** Extract the Authorization header */
    const authHeader = request.headers.get("authorization");

    /** Reject if no Authorization header is present */
    if (!authHeader) {
      logger.warn("Auth failed: missing Authorization header");
      set.status = 401;
      throw new Error("Missing Authorization header");
    }

    /** Reject if the header doesn't follow the Bearer scheme */
    if (!authHeader.startsWith("Bearer ")) {
      logger.warn("Auth failed: invalid Authorization scheme");
      set.status = 401;
      throw new Error("Invalid Authorization scheme — expected Bearer token");
    }

    /** Extract the raw token after "Bearer " */
    const rawToken = authHeader.slice(7);

    /** Reject empty tokens */
    if (!rawToken) {
      logger.warn("Auth failed: empty Bearer token");
      set.status = 401;
      throw new Error("Empty Bearer token");
    }

    /** SHA-256 hash the token to compare against stored hashes */
    const tokenHash = hashApiKey(rawToken);

    /** Look up the hashed token in the api_keys table */
    const [apiKey] = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        isActive: apiKeys.isActive,
      })
      .from(apiKeys)
      .where(eq(apiKeys.keyHash, tokenHash));

    /** Reject if no matching key found */
    if (!apiKey) {
      logger.warn("Auth failed: API key not found");
      set.status = 401;
      throw new Error("Invalid API key");
    }

    /** Reject if the key has been revoked */
    if (!apiKey.isActive) {
      logger.warn("Auth failed: API key is revoked", { apiKeyId: apiKey.id });
      set.status = 401;
      throw new Error("API key has been revoked");
    }

    /**
     * Update last_used_at timestamp — fire-and-forget.
     * We don't await this because it's non-critical and shouldn't
     * slow down the request. Errors are logged but swallowed.
     */
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, apiKey.id))
      .then(() => {
        logger.debug("Updated last_used_at", { apiKeyId: apiKey.id });
      })
      .catch((error: unknown) => {
        logger.error("Failed to update last_used_at", {
          apiKeyId: apiKey.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    logger.debug("Auth successful", { apiKeyId: apiKey.id, apiKeyName: apiKey.name });

    /** Derive API key identity into the request context */
    return {
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
    };
  }
);
