import { Elysia, t } from "elysia";
import { createDomainDto } from "./dtos/create-domain.dto.ts";
import { serializeDomain } from "./serializations/domain.serialization.ts";
import * as domainService from "./services/domain.service.ts";
import { verifyDomain } from "./services/dns-verification.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Domains plugin — registers all domain management routes under /api/v1/domains.
 *
 * Routes:
 * - POST /        → Register a new sender domain
 * - GET /         → List all registered domains
 * - GET /:id      → Get a single domain by ID
 * - DELETE /:id   → Delete a domain
 *
 * All routes are protected by Bearer token auth and rate limiting.
 */
export const domainsPlugin = new Elysia({
  prefix: "/api/v1/domains",
  /** Normalize URLs — /api/v1/domains and /api/v1/domains/ both work */
  normalize: true,
})
  /** Apply auth middleware — all routes in this plugin require a valid Bearer token */
  .use(authMiddleware)
  /** Apply rate limiting — 100 requests per 60 seconds per API key */
  .use(rateLimitMiddleware)

  /**
   * POST /api/v1/domains
   *
   * Registers a new sender domain. Only the domain name is required.
   * DKIM key generation and DNS verification will come in a later phase.
   */
  .post(
    "/",
    async ({ body }) => {
      logger.info("POST /api/v1/domains", { name: body.name });

      const domain = await domainService.createDomain({ name: body.name });

      return {
        success: true,
        data: serializeDomain(domain),
      };
    },
    {
      body: createDomainDto,
      detail: {
        tags: ["Domains"],
        summary: "Register domain",
        description: "Registers a new sender domain and generates DKIM keys.",
        security: [{ bearerAuth: [] }],
      },
    }
  )

  .get("/", async () => {
    logger.info("GET /api/v1/domains");

    const domains = await domainService.listDomains();

    return {
      success: true,
      data: domains.map(serializeDomain),
    };
  }, {
    detail: {
      tags: ["Domains"],
      summary: "List domains",
      description: "Returns all registered domains with their verification status.",
      security: [{ bearerAuth: [] }],
    },
  })

  .get(
    "/:id",
    async ({ params, set }) => {
      logger.info("GET /api/v1/domains/:id", { domainId: params.id });

      const domain = await domainService.getDomainById(params.id);

      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }

      return { success: true, data: serializeDomain(domain) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Get domain by ID",
        description: "Returns a single domain by its ID.",
        security: [{ bearerAuth: [] }],
      },
    }
  )

  .delete(
    "/:id",
    async ({ params, set }) => {
      logger.info("DELETE /api/v1/domains/:id", { domainId: params.id });

      const domain = await domainService.deleteDomain(params.id);

      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }

      return { success: true, data: serializeDomain(domain) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Delete domain",
        description: "Removes a domain from the database (hard delete).",
        security: [{ bearerAuth: [] }],
      },
    }
  )

  .post(
    "/:id/verify",
    async ({ params, set }) => {
      logger.info("POST /api/v1/domains/:id/verify", { domainId: params.id });

      const domain = await domainService.getDomainById(params.id);

      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }

      const result = await verifyDomain(domain);
      const updated = await domainService.getDomainById(params.id);

      return {
        success: true,
        data: serializeDomain(updated!),
        verification: result,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Verify domain DNS",
        description: "Triggers DNS verification (SPF, DKIM, DMARC) for a domain and returns the updated status.",
        security: [{ bearerAuth: [] }],
      },
    }
  );
