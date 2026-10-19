import { Elysia, t } from "elysia";
import { createApiKeyDto } from "./dtos/create-api-key.dto.ts";
import { updateApiKeyDto } from "./dtos/update-api-key.dto.ts";
import { serializeApiKey } from "./serializations/api-key.serialization.ts";
import * as apiKeyService from "./services/api-key.service.ts";
import { authMiddleware, adminMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";
import { recordAuditEvent } from "../audit/services/audit.service.ts";
import { restAuditContext } from "../audit/services/audit-context.service.ts";

/**
 * API Keys plugin: registers all API key management routes under /api/v1/api-keys.
 *
 * Routes:
 * - POST /        → Create a new API key (returns raw key once)
 * - GET /         → List all API keys (hashes hidden)
 * - PATCH /:id    → Update name / allowed-senders allowlist (#126)
 * - DELETE /:id   → Revoke (soft-delete) an API key
 *
 * All routes are protected by auth middleware and rate limiting.
 * This means you need an existing API key to manage keys: the first
 * key is created via the seed script.
 */
export const apiKeysPlugin = new Elysia({
  prefix: "/api/v1/api-keys",
  /** Normalize URLs: /api/v1/api-keys and /api/v1/api-keys/ both work */
  normalize: true,
})
  /** Apply auth middleware: all routes in this plugin require a valid Bearer token */
  .use(authMiddleware)
  /** Management plane: admin keys only (#130). Restricted keys get 403. */
  .use(adminMiddleware)
  /** Apply rate limiting: 100 requests per 60 seconds per API key */
  .use(rateLimitMiddleware)

  /**
   * POST /api/v1/api-keys
   *
   * Creates a new API key. The raw key is returned in the response:
   * this is the ONLY time it will be visible. Store it securely.
   */
  .post(
    "/",
    async ({ body, apiKeyCreatedByUserId, apiKeyId, apiKeyName, request, server }) => {
      logger.info("POST /api/v1/api-keys", { name: body.name });

      const { apiKey, rawKey } = await apiKeyService.createApiKey({
        name: body.name,
        allowedSenders: body.allowedSenders,
        /** The new key belongs to the calling key's user (#219). */
        createdByUserId: apiKeyCreatedByUserId,
      });
      await recordAuditEvent({
        ...restAuditContext({ apiKeyId, apiKeyName, request, server }),
        action: "api_key.created",
        target: { type: "api_key", id: apiKey.id, label: apiKey.name },
        metadata: {
          isAdmin: apiKey.isAdmin,
          allowedSenders: apiKey.allowedSenders.length,
        },
      });

      return {
        success: true,
        data: {
          ...serializeApiKey(apiKey),
          /** The raw key: shown once at creation time, never again */
          key: rawKey,
        },
      };
    },
    {
      body: createApiKeyDto,
      detail: {
        tags: ["API Keys"],
        summary: "Create API key",
        description:
          "Creates a new API key. The raw key is returned once: store it securely.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/",
    async () => {
      logger.info("GET /api/v1/api-keys");

      const keys = await apiKeyService.listApiKeys();

      return {
        success: true,
        data: keys.map(serializeApiKey),
      };
    },
    {
      detail: {
        tags: ["API Keys"],
        summary: "List API keys",
        description: "Returns all API keys (active and revoked). Key hashes are hidden.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .patch(
    "/:id",
    async ({ params, body, set, apiKeyId, apiKeyName, request, server }) => {
      logger.info("PATCH /api/v1/api-keys/:id", {
        apiKeyId: params.id,
        fields: Object.keys(body),
      });

      const apiKey = await apiKeyService.updateApiKey(params.id, {
        name: body.name,
        allowedSenders: body.allowedSenders,
      });

      if (!apiKey) {
        set.status = 404;
        return { success: false, error: "API key not found" };
      }

      /** An empty body changes nothing, so it records nothing (#221). */
      const fields = [
        ...(body.name === undefined ? [] : ["name"]),
        ...(body.allowedSenders === undefined ? [] : ["allowedSenders"]),
      ];
      if (fields.length > 0) {
        await recordAuditEvent({
          ...restAuditContext({ apiKeyId, apiKeyName, request, server }),
          action: "api_key.updated",
          target: { type: "api_key", id: apiKey.id, label: apiKey.name },
          metadata: {
            fields,
            ...(body.allowedSenders === undefined
              ? {}
              : { allowedSenders: apiKey.allowedSenders.length }),
          },
        });
      }

      return { success: true, data: serializeApiKey(apiKey) };
    },
    {
      params: t.Object({ id: t.String() }),
      body: updateApiKeyDto,
      detail: {
        tags: ["API Keys"],
        summary: "Update API key",
        description:
          "Update a key's name and/or its allowed-senders allowlist (#126). `allowedSenders` replaces the whole list: add an address by including it, remove one by omitting it. Empty list = unrestricted.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .delete(
    "/:id",
    async ({ params, set, apiKeyId, apiKeyName, request, server }) => {
      logger.info("DELETE /api/v1/api-keys/:id", { apiKeyId: params.id });

      const apiKey = await apiKeyService.revokeApiKey(params.id);

      if (!apiKey) {
        set.status = 404;
        return {
          success: false,
          error: "API key not found",
        };
      }

      await recordAuditEvent({
        ...restAuditContext({ apiKeyId, apiKeyName, request, server }),
        action: "api_key.revoked",
        target: { type: "api_key", id: apiKey.id, label: apiKey.name },
      });

      return {
        success: true,
        data: serializeApiKey(apiKey),
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      detail: {
        tags: ["API Keys"],
        summary: "Revoke API key",
        description:
          "Soft-deletes an API key by setting is_active to false. The key remains for audit purposes.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
