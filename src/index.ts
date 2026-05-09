import { Elysia } from "elysia";
import { openapi } from "@elysiajs/openapi";
import { config } from "./config.ts";
import { logger } from "./utils/logger.ts";
import { emailsPlugin } from "./modules/emails/emails.plugin.ts";
import { apiKeysPlugin } from "./modules/api-keys/api-keys.plugin.ts";
import { domainsPlugin } from "./modules/domains/domains.plugin.ts";
import { webhooksPlugin } from "./modules/webhooks/webhooks.plugin.ts";
import { templatesPlugin } from "./modules/templates/templates.plugin.ts";
import { inboundPlugin } from "./modules/inbound/inbound.plugin.ts";
import { suppressionsPlugin } from "./modules/suppressions/suppressions.plugin.ts";
import { SuppressedRecipientError } from "./modules/suppressions/errors.ts";
import { dmarcReportsPlugin } from "./modules/dmarc-reports/dmarc-reports.plugin.ts";
import { pagesPlugin } from "./pages/pages.plugin.tsx";
import { landingPlugin } from "./pages/landing.plugin.tsx";
import { faviconPlugin } from "./pages/favicon.ts";
import { NotFoundPage } from "./pages/routes/not-found.tsx";
import * as queueService from "./modules/emails/services/queue.service.ts";
import * as smtpReceiver from "./modules/inbound/services/smtp-receiver.service.ts";
import * as trashPurge from "./modules/trash/services/purge.service.ts";
import * as webhookDeliveryWorker from "./modules/webhooks/services/webhook-delivery-worker.service.ts";
import { startRateLimitCleanup, stopRateLimitCleanup } from "./middleware/rate-limit.ts";
import { encryptDomainKeys } from "./db/encrypt-domain-keys.ts";

/**
 * Encrypt any DKIM private keys still stored as plaintext PEM (legacy
 * rows from before #23). Idempotent — already-encrypted rows are
 * skipped. Runs before the queue starts so the first send after a
 * restart can never read a plaintext row.
 */
await encryptDomainKeys();

/**
 * Main Elysia application.
 *
 * Registers all plugins (route groups) and starts listening.
 * Each module exposes an Elysia plugin that gets .use()'d here.
 */
const app = new Elysia()
  .use(
    openapi({
      path: "/api/docs",
      scalar: {
        spec: { url: "/api/docs/json" },
      },
      documentation: {
        info: {
          title: "BunMail API",
          version: "0.1.0",
          description:
            "Self-hosted email API for developers — free alternative to SendGrid/Resend. " +
            "Send transactional emails with direct SMTP delivery, DKIM/SPF/DMARC signing, " +
            "email queue with retries, templates, and webhooks.",
          license: {
            name: "MIT",
            url: "https://github.com/mohamedboukari/bunmail/blob/main/LICENSE",
          },
          contact: { name: "BunMail", url: "https://github.com/mohamedboukari/bunmail" },
        },
        tags: [
          { name: "Emails", description: "Send and track transactional emails" },
          {
            name: "API Keys",
            description: "Create and manage API keys for authentication",
          },
          {
            name: "Domains",
            description: "Register sender domains and verify DNS records",
          },
          { name: "Webhooks", description: "Subscribe to email delivery events" },
          {
            name: "Templates",
            description: "Create reusable email templates with variable substitution",
          },
          { name: "Inbound", description: "View received inbound emails" },
          {
            name: "Suppressions",
            description:
              "Manage the per-API-key suppression list — addresses that should never receive mail",
          },
          {
            name: "DMARC Reports",
            description:
              "Inspect parsed DMARC aggregate (rua) reports received from remote receivers",
          },
          { name: "Health", description: "Server health checks" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              description:
                "API key obtained from the /api/v1/api-keys endpoint or seed script",
            },
          },
        },
      },
    }),
  )
  /**
   * Global error handler — catches unhandled errors from all routes
   * and returns a consistent JSON response. Prevents stack traces
   * from leaking in production.
   */
  .onError(({ error, code, set, request }) => {
    if (code === "NOT_FOUND") {
      set.status = 404;

      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("text/html")) {
        return new Response("<!doctype html>" + NotFoundPage(), {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }

      return { success: false, error: "Not found" };
    }

    /**
     * Suppression-list rejection (#25). The service throws
     * `SuppressedRecipientError`; map to 422 with structured body so
     * clients can pivot to `DELETE /api/v1/suppressions/:id` via the
     * `suppressionId` field.
     */
    if (error instanceof SuppressedRecipientError) {
      set.status = 422;
      return {
        success: false,
        error: error.message,
        code: "RECIPIENT_SUPPRESSED",
        suppressionId: error.suppressionId,
      };
    }

    const message = error instanceof Error ? error.message : "Internal server error";

    logger.error("Unhandled error", {
      error: message,
      stack:
        config.env === "development" && error instanceof Error ? error.stack : undefined,
    });

    set.status = 500;
    return { success: false, error: message };
  })
  /** Favicon — SVG served at /favicon.svg */
  .use(faviconPlugin)
  /** Root — developer-focused landing page */
  .use(landingPlugin)
  /** Health check — used by Docker, load balancers, and uptime monitors */
  .get(
    "/health",
    () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
    {
      detail: {
        tags: ["Health"],
        summary: "Health check",
        description:
          "Returns server health status — used by Docker, load balancers, and uptime monitors.",
      },
    },
  )
  /** Emails module — POST /send, GET /, GET /:id */
  .use(emailsPlugin)
  /** API Keys module — POST /, GET /, DELETE /:id */
  .use(apiKeysPlugin)
  /** Domains module — POST /, GET /, GET /:id, DELETE /:id, POST /:id/verify */
  .use(domainsPlugin)
  /** Webhooks module — POST /, GET /, DELETE /:id */
  .use(webhooksPlugin)
  /** Templates module — POST /, GET /, GET /:id, PUT /:id, DELETE /:id */
  .use(templatesPlugin)
  /** Inbound module — GET / (list), GET /:id */
  .use(inboundPlugin)
  /** Suppressions module — POST /, GET /, GET /:id, DELETE /:id */
  .use(suppressionsPlugin)
  /** DMARC reports module — GET /, GET /:id */
  .use(dmarcReportsPlugin)
  /** Dashboard — server-rendered UI under /dashboard */
  .use(pagesPlugin)
  .listen({
    port: config.server.port,
    hostname: config.server.host,
  });

logger.info("BunMail server started", {
  port: config.server.port,
  host: config.server.host,
});

/**
 * Start the email queue processor.
 * It polls the DB every 2 seconds for queued emails and sends them.
 */
queueService.start();

/**
 * Start the inbound SMTP server (if enabled).
 * Listens for incoming emails and stores them in the database.
 */
if (config.smtp.enabled) {
  smtpReceiver.start();
}

/**
 * Start the trash purge — periodically removes soft-deleted emails
 * older than TRASH_RETENTION_DAYS.
 */
trashPurge.start();

/**
 * Start the webhook delivery worker — drains the persisted
 * `webhook_deliveries` queue, retries on a schedule of 1m / 5m / 15m /
 * 1h / 6h, and prunes delivered rows older than the retention cutoff.
 */
webhookDeliveryWorker.start();

/**
 * Start the periodic sweep that drops expired entries from the HTTP
 * rate-limit map (prevents unbounded growth under many distinct keys).
 */
startRateLimitCleanup();

/**
 * Graceful shutdown handler.
 * Stops the queue processor first (no new emails picked up),
 * then stops the HTTP server.
 */
function shutdown() {
  logger.info("Shutting down...");
  queueService.stop();
  smtpReceiver.stop();
  trashPurge.stop();
  webhookDeliveryWorker.stop();
  stopRateLimitCleanup();
  app.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/** Export the app type for Elysia's type-safe client (Eden) */
export type App = typeof app;
