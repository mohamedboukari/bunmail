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
import { pagesPlugin } from "./pages/pages.plugin.tsx";
import { landingPlugin } from "./pages/landing.plugin.tsx";
import { NotFoundPage } from "./pages/routes/not-found.tsx";
import * as queueService from "./modules/emails/services/queue.service.ts";
import * as smtpReceiver from "./modules/inbound/services/smtp-receiver.service.ts";

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
      documentation: {
        info: {
          title: "BunMail API",
          version: "0.1.0",
          description:
            "Self-hosted email API for developers — free alternative to SendGrid/Resend. " +
            "Send transactional emails with direct SMTP delivery, DKIM/SPF/DMARC signing, " +
            "email queue with retries, templates, and webhooks.",
          license: { name: "MIT", url: "https://github.com/mohamedboukari/bunmail/blob/main/LICENSE" },
          contact: { name: "BunMail", url: "https://github.com/mohamedboukari/bunmail" },
        },
        tags: [
          { name: "Emails", description: "Send and track transactional emails" },
          { name: "API Keys", description: "Create and manage API keys for authentication" },
          { name: "Domains", description: "Register sender domains and verify DNS records" },
          { name: "Webhooks", description: "Subscribe to email delivery events" },
          { name: "Templates", description: "Create reusable email templates with variable substitution" },
          { name: "Inbound", description: "View received inbound emails" },
          { name: "Health", description: "Server health checks" },
        ],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: "http",
              scheme: "bearer",
              description: "API key obtained from the /api/v1/api-keys endpoint or seed script",
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

    const message = error instanceof Error ? error.message : "Internal server error";

    logger.error("Unhandled error", {
      error: message,
      stack: config.env === "development" && error instanceof Error ? error.stack : undefined,
    });

    set.status = 500;
    return { success: false, error: message };
  })
  /** Root — developer-focused landing page */
  .use(landingPlugin)
  /** Health check — used by Docker, load balancers, and uptime monitors */
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }), {
    detail: { tags: ["Health"], summary: "Health check", description: "Returns server health status — used by Docker, load balancers, and uptime monitors." },
  })
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
 * Graceful shutdown handler.
 * Stops the queue processor first (no new emails picked up),
 * then stops the HTTP server.
 */
function shutdown() {
  logger.info("Shutting down...");
  queueService.stop();
  smtpReceiver.stop();
  app.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/** Export the app type for Elysia's type-safe client (Eden) */
export type App = typeof app;
