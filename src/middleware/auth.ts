import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { apiKeys } from "../modules/api-keys/models/api-key.schema.ts";
import { hashApiKey } from "../utils/crypto.ts";
import { logger } from "../utils/logger.ts";

/**
 * Per-request stash for the looked-up API key, keyed on the Request
 * object. `onBeforeHandle` populates it after a single hash + query;
 * `resolve` reads from it instead of re-hashing and re-querying. The
 * `WeakMap` auto-evicts when the request is garbage-collected so there
 * is no leak risk.
 */
interface AuthenticatedKey {
  id: string;
  name: string;
}
const authCache = new WeakMap<Request, AuthenticatedKey>();

/**
 * Auth middleware — validates Bearer tokens on every request.
 *
 * Flow:
 * 1. `onBeforeHandle` — validates the token, rejects invalid requests,
 *    caches the matched API key on the Request.
 * 2. `resolve` — reads the cached key and injects `apiKeyId` /
 *    `apiKeyName` into the context. Performs no DB or crypto work.
 *
 * Usage: `.use(authMiddleware)` on any Elysia plugin that needs protection.
 * Routes without this middleware (e.g. /health) remain public.
 */
export const authMiddleware = new Elysia({ name: "auth-middleware" })
  /**
   * Guard — rejects requests with missing, invalid, or revoked API keys.
   * Returning a value short-circuits the request.
   */
  .onBeforeHandle(async ({ request, set }) => {
    /** Extract the Authorization header */
    const authHeader = request.headers.get("authorization");

    /** Reject if no Authorization header is present */
    if (!authHeader) {
      logger.warn("Auth failed: missing Authorization header");
      set.status = 401;
      return { success: false, error: "Missing Authorization header" };
    }

    /** Reject if the header doesn't follow the Bearer scheme */
    if (!authHeader.startsWith("Bearer ")) {
      logger.warn("Auth failed: invalid Authorization scheme");
      set.status = 401;
      return {
        success: false,
        error: "Invalid Authorization scheme — expected Bearer token",
      };
    }

    /** Extract the raw token after "Bearer " */
    const rawToken = authHeader.slice(7);

    /** Reject empty tokens */
    if (!rawToken) {
      logger.warn("Auth failed: empty Bearer token");
      set.status = 401;
      return { success: false, error: "Empty Bearer token" };
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
      return { success: false, error: "Invalid API key" };
    }

    /** Reject if the key has been revoked */
    if (!apiKey.isActive) {
      logger.warn("Auth failed: API key is revoked", { apiKeyId: apiKey.id });
      set.status = 401;
      return { success: false, error: "API key has been revoked" };
    }

    /** Stash for `resolve` so it doesn't re-hash + re-query */
    authCache.set(request, { id: apiKey.id, name: apiKey.name });
  })
  /**
   * Resolve — injects API key identity into the request context.
   * Reads from the per-request cache populated by `onBeforeHandle`.
   * Never reaches here unless the guard already passed.
   */
  .resolve(({ request }) => {
    const cached = authCache.get(request);
    if (!cached) {
      /**
       * Defensive: this should be unreachable. `onBeforeHandle` either
       * populates the cache or short-circuits with a 401 response, so
       * `resolve` only runs when the cache is set.
       */
      throw new Error("auth: cached API key missing in resolve");
    }

    /**
     * Update last_used_at timestamp — fire-and-forget.
     * Non-critical and shouldn't slow down the request. Errors logged.
     */
    db.update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, cached.id))
      .then(() => {
        logger.debug("Updated last_used_at", { apiKeyId: cached.id });
      })
      .catch((error: unknown) => {
        logger.error("Failed to update last_used_at", {
          apiKeyId: cached.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    logger.debug("Auth successful", { apiKeyId: cached.id, apiKeyName: cached.name });

    return {
      apiKeyId: cached.id,
      apiKeyName: cached.name,
    };
  })
  /**
   * Lift hooks to the parent plugin scope — without this, onBeforeHandle
   * and resolve() stay encapsulated inside this plugin and don't apply
   * to routes defined in the parent (e.g. emailsPlugin).
   */
  .as("scoped");
