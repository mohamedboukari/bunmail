import { Elysia, t } from "elysia";
import { createApiKeyDto } from "./dtos/create-api-key.dto.ts";
import { serializeApiKey } from "./serializations/api-key.serialization.ts";
import * as apiKeyService from "./services/api-key.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * API Keys plugin — registers all API key management routes under /api/v1/api-keys.
 *
 * Routes:
 * - POST /        → Create a new API key (returns raw key once)
 * - GET /         → List all API keys (hashes hidden)
 * - DELETE /:id   → Revoke (soft-delete) an API key
 *
 * All routes are protected by auth middleware and rate limiting.
 * This means you need an existing API key to manage keys — the first
 * key is created via the seed script.
 */
export const apiKeysPlugin = new Elysia({
  prefix: "/api/v1/api-keys",
  /** Normalize URLs — /api/v1/api-keys and /api/v1/api-keys/ both work */
  normalize: true,
})
  /** Apply auth middleware — all routes in this plugin require a valid Bearer token */
  .use(authMiddleware)
  /** Apply rate limiting — 100 requests per 60 seconds per API key */
  .use(rateLimitMiddleware)

  /**
   * POST /api/v1/api-keys
   *
   * Creates a new API key. The raw key is returned in the response —
   * this is the ONLY time it will be visible. Store it securely.
   */
  .post(
    "/",
    async ({ body }) => {
      logger.info("POST /api/v1/api-keys", { name: body.name });

      const { apiKey, rawKey } = await apiKeyService.createApiKey({ name: body.name });

      return {
        success: true,
        data: {
          ...serializeApiKey(apiKey),
          /** The raw key — shown once at creation time, never again */
          key: rawKey,
        },
      };
    },
    {
      /** Validate request body against the create API key DTO */
      body: createApiKeyDto,
    }
  )

  /**
   * GET /api/v1/api-keys
   *
   * Returns all API keys (active and revoked). Hashes are stripped by
   * the serializer — only the prefix is shown for identification.
   */
  .get("/", async () => {
    logger.info("GET /api/v1/api-keys");

    const keys = await apiKeyService.listApiKeys();

    return {
      success: true,
      data: keys.map(serializeApiKey),
    };
  })

  /**
   * DELETE /api/v1/api-keys/:id
   *
   * Revokes an API key by setting `is_active` to false.
   * The key stays in the DB for audit — it just stops working.
   * Returns 404 if the key ID doesn't exist.
   */
  .delete(
    "/:id",
    async ({ params, set }) => {
      logger.info("DELETE /api/v1/api-keys/:id", { apiKeyId: params.id });

      const apiKey = await apiKeyService.revokeApiKey(params.id);

      /** Return 404 if no key matches the given ID */
      if (!apiKey) {
        set.status = 404;
        return {
          success: false,
          error: "API key not found",
        };
      }

      return {
        success: true,
        data: serializeApiKey(apiKey),
      };
    },
    {
      /** Validate the :id URL parameter */
      params: t.Object({
        id: t.String(),
      }),
    }
  );
