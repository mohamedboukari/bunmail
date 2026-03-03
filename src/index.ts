import { Elysia } from "elysia";
import { html } from "@elysiajs/html";
import { config } from "./config.ts";
import { logger } from "./utils/logger.ts";
import { emailsPlugin } from "./modules/emails/emails.plugin.ts";
import { apiKeysPlugin } from "./modules/api-keys/api-keys.plugin.ts";
import { domainsPlugin } from "./modules/domains/domains.plugin.ts";
import { pagesPlugin } from "./pages/pages.plugin.tsx";
import { LandingPage } from "./pages/routes/landing.tsx";
import * as queueService from "./modules/emails/services/queue.service.ts";

/**
 * Main Elysia application.
 *
 * Registers all plugins (route groups) and starts listening.
 * Each module exposes an Elysia plugin that gets .use()'d here.
 */
const app = new Elysia()
  /** Enable JSX rendering for the landing page */
  .use(html())
  /** Root — developer-focused landing page */
  .get("/", () => LandingPage())
  /** Health check — used by Docker, load balancers, and uptime monitors */
  .get("/health", () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }))
  /** Emails module — POST /send, GET /, GET /:id */
  .use(emailsPlugin)
  /** API Keys module — POST /, GET /, DELETE /:id */
  .use(apiKeysPlugin)
  /** Domains module — POST /, GET /, GET /:id, DELETE /:id */
  .use(domainsPlugin)
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
 * Graceful shutdown handler.
 * Stops the queue processor first (no new emails picked up),
 * then stops the HTTP server.
 */
function shutdown() {
  logger.info("Shutting down...");
  queueService.stop();
  app.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/** Export the app type for Elysia's type-safe client (Eden) */
export type App = typeof app;
