/**
 * The HTTP application (#387, split from `src/index.ts`): the Elysia app
 * with the request context, security headers, OpenAPI document, global
 * error handler and every route group. `startApp` builds it and starts
 * listening; `src/index.ts` calls it once the boot steps are done.
 */
import { Elysia, ValidationError } from "elysia";
import { apiPlugins } from "./modules/api-plugins.ts";
import { openapi } from "@elysiajs/openapi";
import { config } from "./config.ts";
import { logger } from "./utils/logger.ts";
import { ApiKeyCreatorInactiveError } from "./modules/api-keys/errors.ts";
import { serializeSendError } from "./modules/emails/serializations/send-error.serialization.ts";
import {
  DkimRotationError,
  DomainAlreadyRegisteredError,
  InvalidDkimSelectorError,
} from "./modules/domains/errors.ts";
import { BlockedUrlError } from "./utils/ssrf-guard.ts";
import {
  InboundEventsRequireAdminError,
  ReplayLimitReachedError,
  WebhookLimitReachedError,
} from "./modules/webhooks/errors.ts";
import { pagesPlugin } from "./pages/pages.plugin.tsx";
import { withRequestContext } from "./middleware/request-context.ts";
import { securityHeadersPlugin } from "./middleware/security-headers.ts";
import { landingPlugin } from "./pages/landing.plugin.tsx";
import { unsubscribePlugin } from "./pages/unsubscribe.plugin.tsx";
import { faviconPlugin } from "./pages/favicon.ts";
import { notFoundResponse } from "./pages/routes/not-found.tsx";
import { metricsPlugin } from "./modules/metrics/metrics.plugin.ts";

export function startApp(appVersion: string) {
  /**
   * Main Elysia application.
   *
   * Registers all plugins (route groups) and starts listening.
   * Each module exposes an Elysia plugin that gets .use()'d here.
   */
  const app = new Elysia()
    /**
     * Every request runs in its own log context (#284): each log line it
     * writes carries its `requestId`, the response gets `X-Request-Id`, and
     * one `HTTP request` line records method, path, status and duration.
     */
    .wrap(withRequestContext)
    /** Browser security headers on every response (#255). */
    .use(
      securityHeadersPlugin({ httpsBaseUrl: config.appBaseUrl.startsWith("https://") }),
    )
    .use(
      openapi({
        path: "/api/docs",
        scalar: {
          spec: { url: "/api/docs/json" },
        },
        documentation: {
          info: {
            title: "BunMail API",
            version: appVersion,
            description:
              "Self-hosted email API for developers: free alternative to SendGrid/Resend. " +
              "Send transactional emails with direct SMTP delivery, DKIM/SPF/DMARC signing, " +
              "email queue with retries, templates, and webhooks.",
            license: {
              name: "MIT",
              url: "https://github.com/mohamedboukari/bunmail/blob/main/LICENSE",
            },
            contact: {
              name: "BunMail",
              url: "https://github.com/mohamedboukari/bunmail",
            },
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
                "Manage the per-API-key suppression list: addresses that should never receive mail",
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
     * Global error handler: catches unhandled errors from all routes
     * and returns a consistent JSON response. Prevents stack traces
     * from leaking in production.
     */
    .onError(async ({ error, code, set, request }) => {
      /**
       * Request validation failed → 422 with a short list of what is wrong.
       * Bodies are validated before the auth hooks run, so this is reachable
       * without a key: the response never echoes the submitted values (only
       * each failing path and TypeBox's fixed message, capped), and it is not
       * logged as a server error. It used to fall through to the 500 path,
       * which logged the whole request body.
       */
      if (code === "VALIDATION" && error instanceof ValidationError) {
        set.status = 422;
        return {
          success: false,
          error: "Request validation failed",
          code: "VALIDATION_ERROR",
          details: error.all.slice(0, 10).map((e) => ({
            path: e.path,
            message: e.message.slice(0, 200),
          })),
        };
      }

      /** Malformed body (e.g. invalid JSON) → 400, same reasoning. */
      if (code === "PARSE") {
        set.status = 400;
        return { success: false, error: "Malformed request body", code: "INVALID_BODY" };
      }

      if (code === "NOT_FOUND") {
        set.status = 404;

        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("text/html")) {
          return notFoundResponse();
        }

        return { success: false, error: "Not found" };
      }

      /**
       * A send refused on its input: the suppression gate (#25), the sender
       * domain (#245), the template, a custom header, a tag, an attachment,
       * the recipients (#178), a revoked key, the allowed senders (#126).
       * Mapped in `serializeSendError`, which the batch endpoint (#178) also
       * uses per item, so both answer a refusal the same way.
       */
      const sendError = serializeSendError(error);
      if (sendError) {
        set.status = sendError.status;
        return sendError.body;
      }

      /** A domain name already registered (case-insensitive) → 409. */
      if (error instanceof DomainAlreadyRegisteredError) {
        set.status = 409;
        return { success: false, error: error.message, code: error.code };
      }

      /** A DKIM selector that is not one lowercase DNS label (#250) → 422. */
      if (error instanceof InvalidDkimSelectorError) {
        set.status = 422;
        return { success: false, error: error.message, code: error.code };
      }

      /** A DKIM key rotation step refused on the domain's state (#250) → 409. */
      if (error instanceof DkimRotationError) {
        set.status = error.status;
        return { success: false, error: error.message, code: error.code };
      }

      /**
       * The new key's creator (#219: the calling key's user) is deactivated
       * or gone → 403; nothing was created.
       */
      if (error instanceof ApiKeyCreatorInactiveError) {
        set.status = 403;
        return { success: false, error: error.message, code: "API_KEY_CREATOR_INACTIVE" };
      }

      /**
       * Webhook URL rejected by the SSRF guard (#128) → 422. Surfaces at
       * create time so the caller sees why the URL was refused.
       */
      /**
       * Non-admin key subscribing to inbound or domain events → 403. Inbound
       * mail and domains have no owning key and are admin-only (#130, #250).
       */
      if (error instanceof InboundEventsRequireAdminError) {
        set.status = 403;
        return {
          success: false,
          error: error.message,
          code: "INBOUND_EVENTS_REQUIRE_ADMIN",
        };
      }

      /** The key already has `WEBHOOKS_MAX_PER_API_KEY` webhooks (#258) → 422. */
      if (error instanceof WebhookLimitReachedError) {
        set.status = error.status;
        return { success: false, error: error.message, code: error.code };
      }

      /** A delivery replayed 5 times this hour (#258) → 429 with `Retry-After`. */
      if (error instanceof ReplayLimitReachedError) {
        set.status = error.status;
        set.headers["retry-after"] = String(error.retryAfterSec);
        return { success: false, error: error.message, code: error.code };
      }

      if (error instanceof BlockedUrlError) {
        set.status = 422;
        return { success: false, error: error.message, code: "WEBHOOK_URL_BLOCKED" };
      }

      const message = error instanceof Error ? error.message : "Internal server error";

      logger.error("Unhandled error", {
        error: message,
        stack:
          config.env === "development" && error instanceof Error
            ? error.stack
            : undefined,
      });

      set.status = 500;
      /**
       * Never return the raw exception message in production (#133). Driver
       * errors embed table/column/query fragments → schema disclosure. The
       * detail is logged server-side above; the client gets a generic string.
       * Mapped errors (suppression / unauthorized-sender / blocked-URL) are
       * handled and returned before this fall-through, so this only masks the
       * genuinely unexpected 500s. In development we keep the message to aid
       * debugging.
       */
      return {
        success: false,
        error: config.env === "production" ? "Internal server error" : message,
      };
    })
    /** Favicon: SVG served at /favicon.svg */
    .use(faviconPlugin)
    /** Root: developer-focused landing page */
    .use(landingPlugin)
    /** Public one-click unsubscribe pages at /u/:token (#249): no auth, token-verified */
    .use(unsubscribePlugin())
    /** Health check: used by Docker, load balancers, and uptime monitors */
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
            "Returns server health status: used by Docker, load balancers, and uptime monitors.",
        },
      },
    )
    /** Prometheus metrics at /metrics (#362), only with METRICS_TOKEN set */
    .use(metricsPlugin({ version: appVersion }))
    /** Every REST API module under /api/v1 (see src/modules/api-plugins.ts) */
    .use(apiPlugins)
    /** Dashboard: server-rendered UI under /dashboard */
    .use(pagesPlugin)
    .listen({
      port: config.server.port,
      hostname: config.server.host,
      maxRequestBodySize: config.server.maxRequestBodyBytes,
    });

  return app;
}
