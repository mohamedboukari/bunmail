import { Elysia, t } from "elysia";
import { createDomainDto } from "./dtos/create-domain.dto.ts";
import { updateDomainDto } from "./dtos/update-domain.dto.ts";
import { serializeDomain } from "./serializations/domain.serialization.ts";
import * as domainService from "./services/domain.service.ts";
import { verifyDomain } from "./services/dns-verification.service.ts";
import {
  cancelDkimRotation,
  completeDkimRotation,
  startDkimRotation,
} from "./services/dkim-rotation.service.ts";
import { pendingDkimDnsRecord } from "./services/required-dns-records.ts";
import {
  getDomainDnsStatus,
  getDomainsDnsStatus,
} from "./services/domain-dns-status.service.ts";
import { authMiddleware, adminMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";
import { recordAuditEvent } from "../audit/services/audit.service.ts";
import { restAuditContext } from "../audit/services/audit-context.service.ts";

/**
 * Domains plugin: registers all domain management routes under /api/v1/domains.
 *
 * Routes:
 * - POST /        → Register a new sender domain
 * - GET /         → List all registered domains
 * - GET /:id      → Get a single domain by ID
 * - DELETE /:id   → Delete a domain
 * - POST /:id/verify                 → Run DNS verification
 * - POST /:id/dkim/rotate            → Start a DKIM key rotation (#250)
 * - POST /:id/dkim/rotate/complete   → Switch to the pending key once published
 * - DELETE /:id/dkim/rotate          → Cancel the pending rotation
 *
 * All routes are protected by Bearer token auth and rate limiting.
 */
export const domainsPlugin = new Elysia({
  prefix: "/api/v1/domains",
  /** Normalize URLs: /api/v1/domains and /api/v1/domains/ both work */
  normalize: true,
})
  /** Apply auth middleware: all routes in this plugin require a valid Bearer token */
  .use(authMiddleware)
  /**
   * Domain management (register / verify / delete / list) is operator-level,
   * so admin-only (#130). Restricted keys get 403. Sending is unaffected:
   * `createEmail` resolves the sender domain internally, and a restricted key's
   * allowed `From` addresses are governed by its allowed-senders list (#126).
   */
  .use(adminMiddleware)
  /** Apply rate limiting: 100 requests per 60 seconds per API key */
  .use(rateLimitMiddleware)

  /**
   * POST /api/v1/domains
   *
   * Registers a new sender domain. Only the domain name is required.
   * DKIM key generation and DNS verification will come in a later phase.
   */
  .post(
    "/",
    async ({ body, apiKeyCreatedByUserId, apiKeyId, apiKeyName, request, server }) => {
      logger.info("POST /api/v1/domains", { name: body.name });

      const domain = await domainService.createDomain({
        name: body.name,
        notifyEmail: body.notifyEmail,
        /** Validated by the DTO but previously never passed on (#243). */
        unsubscribeEmail: body.unsubscribeEmail,
        unsubscribeUrl: body.unsubscribeUrl,
        /** Attributed to the calling key's user (#219). */
        createdByUserId: apiKeyCreatedByUserId,
        /** Validated by the DTO (#250); omitted means `bunmail`. */
        dkimSelector: body.dkimSelector,
      });
      await recordAuditEvent({
        ...restAuditContext({ apiKeyId, apiKeyName, request, server }),
        action: "domain.created",
        target: { type: "domain", id: domain.id, label: domain.name },
      });

      /**
       * Never waits on DNS (#250): `dmarc` and `mx` are null (not checked
       * yet) until the next GET or Verify. A slow resolver must not hold
       * up registering a domain.
       */
      return {
        success: true,
        data: serializeDomain(domain, null),
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
    },
  )

  .get(
    "/",
    async () => {
      logger.info("GET /api/v1/domains");

      const domains = await domainService.listDomains();
      /** At most 8 domains looked up at once (#250). */
      const statuses = await getDomainsDnsStatus(domains.map((domain) => domain.name));

      return {
        success: true,
        data: domains.map((domain, index) =>
          serializeDomain(domain, statuses[index] ?? null),
        ),
      };
    },
    {
      detail: {
        tags: ["Domains"],
        summary: "List domains",
        description:
          "Returns all registered domains with their verification status, the DNS records to publish (dnsRecords), the current DMARC check (dmarc) and where the MX points (mx).",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/:id",
    async ({ params, set }) => {
      logger.info("GET /api/v1/domains/:id", { domainId: params.id });

      const domain = await domainService.getDomainById(params.id);

      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }

      return {
        success: true,
        data: serializeDomain(domain, await getDomainDnsStatus(domain.name)),
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Get domain by ID",
        description:
          "Returns a single domain by its ID, with the DNS records to publish (dnsRecords), the current DMARC check (dmarc) and where the MX points (mx).",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * PATCH /api/v1/domains/:id
   *
   * Edits the domain's `List-Unsubscribe` overrides (#243). Omitted fields
   * stay as they are; `null` clears one.
   */
  .patch(
    "/:id",
    async ({ params, body, set, apiKeyId, apiKeyName, request, server }) => {
      logger.info("PATCH /api/v1/domains/:id", { domainId: params.id });

      const domain = await domainService.updateDomainUnsubscribe(params.id, body);

      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }
      /** An empty body changes nothing, so it records nothing (#221). */
      const fields = Object.keys(body);
      if (fields.length > 0) {
        await recordAuditEvent({
          ...restAuditContext({ apiKeyId, apiKeyName, request, server }),
          action: "domain.updated",
          target: { type: "domain", id: domain.id, label: domain.name },
          metadata: { fields },
        });
      }

      /** A settings change never waits on DNS either: `dmarc` and `mx` are null. */
      return { success: true, data: serializeDomain(domain, null) };
    },
    {
      params: t.Object({ id: t.String() }),
      body: updateDomainDto,
      detail: {
        tags: ["Domains"],
        summary: "Update domain unsubscribe settings",
        description:
          "Sets or clears the List-Unsubscribe mailbox and the RFC 8058 one-click HTTPS URL.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .delete(
    "/:id",
    async ({ params, set, apiKeyId, apiKeyName, request, server }) => {
      logger.info("DELETE /api/v1/domains/:id", { domainId: params.id });

      const domain = await domainService.deleteDomain(params.id);

      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }
      await recordAuditEvent({
        ...restAuditContext({ apiKeyId, apiKeyName, request, server }),
        action: "domain.deleted",
        target: { type: "domain", id: domain.id, label: domain.name },
      });

      /** Gone: no DNS lookup for it. */
      return { success: true, data: serializeDomain(domain, null) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Delete domain",
        description: "Removes a domain from the database (hard delete).",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .post(
    "/:id/verify",
    async ({ params, set, apiKeyId, apiKeyName, request, server }) => {
      logger.info("POST /api/v1/domains/:id/verify", { domainId: params.id });

      const domain = await domainService.getDomainById(params.id);

      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }

      const result = await verifyDomain(domain);
      const updated = await domainService.getDomainById(params.id);
      await recordAuditEvent({
        ...restAuditContext({ apiKeyId, apiKeyName, request, server }),
        action: "domain.verified",
        target: { type: "domain", id: domain.id, label: domain.name },
        metadata: { spf: result.spf, dkim: result.dkim, dmarc: result.dmarc },
      });

      return {
        success: true,
        data: serializeDomain(updated!, await getDomainDnsStatus(domain.name)),
        verification: result,
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Verify domain DNS",
        description:
          "Triggers DNS verification (SPF, DKIM, DMARC) for a domain and returns the updated status.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/domains/:id/dkim/rotate
   *
   * Starts a DKIM key rotation (#250): a new key under a dated selector,
   * pending until completed. Mail stays signed with the active key.
   * `409 DKIM_ROTATION_PENDING` while one is pending.
   */
  .post(
    "/:id/dkim/rotate",
    async ({ params, set, apiKeyId, apiKeyName, request, server }) => {
      logger.info("POST /api/v1/domains/:id/dkim/rotate", { domainId: params.id });

      const domain = await startDkimRotation(
        params.id,
        restAuditContext({ apiKeyId, apiKeyName, request, server }),
      );
      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }

      /** A key change never waits on DNS: `dmarc` and `mx` are null. */
      return {
        success: true,
        data: serializeDomain(domain, null),
        dnsRecord: pendingDkimDnsRecord(domain),
      };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Start DKIM key rotation",
        description:
          "Generates a new DKIM key under a dated selector (bm<YYYYMMDD>) and returns the TXT record to publish (dnsRecord, also in dnsRecords with pending: true). Mail stays signed with the current key until the rotation is completed. 409 DKIM_ROTATION_PENDING when a rotation is already pending.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * POST /api/v1/domains/:id/dkim/rotate/complete
   *
   * Switches to the pending key (#250), only once its TXT record is
   * published with the pending key; otherwise `409
   * DKIM_PENDING_NOT_PUBLISHED` with the reason, and nothing changes.
   */
  .post(
    "/:id/dkim/rotate/complete",
    async ({ params, set, apiKeyId, apiKeyName, request, server }) => {
      logger.info("POST /api/v1/domains/:id/dkim/rotate/complete", {
        domainId: params.id,
      });

      const domain = await completeDkimRotation(
        params.id,
        restAuditContext({ apiKeyId, apiKeyName, request, server }),
      );
      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }

      return { success: true, data: serializeDomain(domain, null) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Complete DKIM key rotation",
        description:
          "Looks up the pending selector's TXT record and, when it carries the pending key, makes that key the active one; the old selector is returned as dkimPrevious. 409 DKIM_PENDING_NOT_PUBLISHED (with the reason), DKIM_NO_PENDING_ROTATION or DKIM_PENDING_KEY_UNREADABLE otherwise, with nothing changed.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  /**
   * DELETE /api/v1/domains/:id/dkim/rotate
   *
   * Cancels the pending rotation (#250): its key is dropped, the active key
   * is untouched. `409 DKIM_NO_PENDING_ROTATION` when none is pending.
   */
  .delete(
    "/:id/dkim/rotate",
    async ({ params, set, apiKeyId, apiKeyName, request, server }) => {
      logger.info("DELETE /api/v1/domains/:id/dkim/rotate", { domainId: params.id });

      const domain = await cancelDkimRotation(
        params.id,
        restAuditContext({ apiKeyId, apiKeyName, request, server }),
      );
      if (!domain) {
        set.status = 404;
        return { success: false, error: "Domain not found" };
      }

      return { success: true, data: serializeDomain(domain, null) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Domains"],
        summary: "Cancel DKIM key rotation",
        description:
          "Drops the pending DKIM key; the active key is untouched. 409 DKIM_NO_PENDING_ROTATION when no rotation is pending.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
