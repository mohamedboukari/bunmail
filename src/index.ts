import { Elysia, ValidationError } from "elysia";
import { apiPlugins } from "./modules/api-plugins.ts";
import { openapi } from "@elysiajs/openapi";
import { config } from "./config.ts";
import { logger } from "./utils/logger.ts";
import { SuppressedRecipientError } from "./modules/suppressions/errors.ts";
import {
  ApiKeyCreatorInactiveError,
  InactiveApiKeyError,
  UnauthorizedSenderError,
} from "./modules/api-keys/errors.ts";
import { TemplateTooLargeError } from "./modules/templates/errors.ts";
import { EmailSendRejectedError } from "./modules/emails/errors.ts";
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
import * as queueService from "./modules/emails/services/queue.service.ts";
import * as smtpReceiver from "./modules/inbound/services/smtp-receiver.service.ts";
import * as smtpSubmission from "./modules/smtp-submission/services/smtp-submission.service.ts";
import * as trashPurge from "./modules/trash/services/purge.service.ts";
import * as webhookDeliveryWorker from "./modules/webhooks/services/webhook-delivery-worker.service.ts";
import * as domainReverify from "./modules/domains/services/domain-reverify.service.ts";
import { startRateLimitCleanup, stopRateLimitCleanup } from "./middleware/rate-limit.ts";
import {
  startLoginRateLimitCleanup,
  stopLoginRateLimitCleanup,
} from "./middleware/login-rate-limit.ts";
import {
  encryptDomainKeys,
  findUndecryptableDomainKeys,
} from "./db/encrypt-domain-keys.ts";
import { encryptWebhookSecrets } from "./db/encrypt-webhook-secrets.ts";
import { logReverseDnsAtBoot } from "./modules/domains/services/sending-ips.service.ts";
import { bootstrapOwner } from "./modules/users/services/owner.service.ts";
import { buildSetupUrl } from "./modules/users/services/owner-setup-policy.service.ts";
import { redactEmail } from "./utils/redact.ts";

/**
 * Encrypt any DKIM private keys still stored as plaintext PEM (legacy
 * rows from before #23). Idempotent: already-encrypted rows are
 * skipped. Runs before the queue starts so the first send after a
 * restart can never read a plaintext row.
 */
await encryptDomainKeys();

/**
 * Every stored DKIM key must decrypt with the current key (#244). A wrong
 * `DKIM_ENCRYPTION_KEY` would hold every send from those domains (the
 * queue never sends unsigned in production), so production refuses to
 * start, naming the domains, like the other boot guards. Development
 * warns and sends unsigned.
 */
const undecryptableKeys = await findUndecryptableDomainKeys();
const undecryptableDomains = undecryptableKeys.active;
if (undecryptableDomains.length > 0) {
  const detail = {
    domains: undecryptableDomains,
    hint: "DKIM_ENCRYPTION_KEY differs from the key these were encrypted with (SECURITY.md, Rotation)",
  };
  if (config.env === "production") {
    logger.error("[boot] DKIM private keys do not decrypt: refusing to start", detail);
    throw new Error(
      `[boot] DKIM private keys of ${undecryptableDomains.length} domain(s) do not decrypt with DKIM_ENCRYPTION_KEY`,
    );
  }
  logger.warn(
    "DKIM private keys do not decrypt: those domains send unsigned (development only)",
    detail,
  );
}

/**
 * A pending rotation key (#250) that does not decrypt holds no mail: mail
 * is signed with the active key, and completing the rotation refuses such
 * a key. Reported on its own, in every environment, so the boot goes on.
 */
if (undecryptableKeys.pending.length > 0) {
  logger.warn(
    "Pending DKIM rotation keys do not decrypt: cancel those rotations and start new ones",
    {
      domains: undecryptableKeys.pending,
      hint: "DKIM_ENCRYPTION_KEY differs from the key these were encrypted with (SECURITY.md, Rotation)",
    },
  );
}

/** Same for webhook signing secrets from before #259, before the webhook worker starts. */
await encryptWebhookSecrets();

/**
 * Owner bootstrap (#215): create the dashboard owner from
 * `BUNMAIL_OWNER_EMAIL`, or replace a still-unused setup link, and log the
 * one-time link. Runs on every boot and is idempotent (see
 * `bootstrapOwner`). Non-fatal: the API and mail delivery do not depend on
 * the dashboard owner, so a failure is logged and the boot continues; the
 * operator can retry with a restart or `bun run src/db/reset-owner.ts`.
 */
async function runOwnerBootstrap(): Promise<void> {
  const ownerEmail = config.dashboard.ownerEmail;
  if (ownerEmail === null) {
    /** Only reachable in development: production refuses to boot (config.ts). */
    logger.warn(
      "BUNMAIL_OWNER_EMAIL is not set: owner bootstrap skipped; the dashboard has no account to sign in with until BUNMAIL_OWNER_EMAIL is set",
    );
    return;
  }

  try {
    const result = await bootstrapOwner(ownerEmail);
    switch (result.kind) {
      case "created":
      case "reissued": {
        /** Logged only now, after the transaction committed, and once per
         *  minted token. `warn` so LOG_LEVEL=warn does not hide it, raised to
         *  `error` when LOG_LEVEL=error so the link is never filtered out. */
        const { url, usedFallback } = buildSetupUrl(
          config.appBaseUrl,
          config.server.port,
          result.token,
        );
        const fields = {
          note: "single use, open it to set the owner password; only the most recent link works",
          url,
          owner: redactEmail(result.email),
          expiresAt: result.expiresAt.toISOString(),
          ...(usedFallback
            ? {
                hint: "APP_BASE_URL is not set to an http(s) URL: the link uses localhost, set it to this server's public URL",
              }
            : {}),
        };
        if (config.logLevel === "error") logger.error("Owner setup link", fields);
        else logger.warn("Owner setup link", fields);
        break;
      }
      case "complete":
        break;
      case "mismatch":
        logger.warn(
          "BUNMAIL_OWNER_EMAIL differs from the stored owner; ignored. Ownership moves only by transfer.",
          {
            configured: redactEmail(ownerEmail),
            stored: redactEmail(result.storedEmail),
          },
        );
        break;
      case "email-taken":
        logger.error(
          "Owner bootstrap skipped: BUNMAIL_OWNER_EMAIL belongs to an existing non-owner account, which is never promoted",
          { configured: redactEmail(ownerEmail) },
        );
        break;
    }
  } catch (error: unknown) {
    logger.error("Owner bootstrap failed; run `bun run src/db/reset-owner.ts` to retry", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await runOwnerBootstrap();

/**
 * Account login (#216) replaced the shared dashboard password and the HMAC
 * session secret. A value left in `.env` does nothing; say so once, so the
 * operator removes it instead of believing it still protects anything.
 */
if (config.dashboard.legacyAuthEnv.length > 0) {
  logger.warn("Dashboard auth env vars are no longer used since #216, remove from .env", {
    vars: config.dashboard.legacyAuthEnv,
    note: "the dashboard signs in with the owner account (BUNMAIL_OWNER_EMAIL and the setup link)",
  });
}

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
  .use(securityHeadersPlugin({ httpsBaseUrl: config.appBaseUrl.startsWith("https://") }))
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
            "Self-hosted email API for developers: free alternative to SendGrid/Resend. " +
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

    /**
     * Send refused on its input (#245): sender domain not registered or
     * not DKIM-verified, template not found, subject missing. Each class
     * carries its own status (404 or 422) and code.
     */
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

    if (error instanceof EmailSendRejectedError) {
      set.status = error.status;
      return { success: false, error: error.message, code: error.code };
    }

    /**
     * Variables would make the rendered template larger than allowed → 422.
     */
    if (error instanceof TemplateTooLargeError) {
      set.status = 422;
      return { success: false, error: error.message, code: "TEMPLATE_OUTPUT_TOO_LARGE" };
    }

    /**
     * The sending key was revoked after it was resolved (dashboard, or a
     * race with revocation) → 401, same as auth rejecting a revoked key.
     */
    if (error instanceof InactiveApiKeyError) {
      set.status = 401;
      return { success: false, error: error.message, code: "API_KEY_REVOKED" };
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
     * Sender-authorization rejection (#126). The key is valid (so not 401)
     * but isn't permitted to send from this `From` address → 403.
     */
    if (error instanceof UnauthorizedSenderError) {
      set.status = 403;
      return {
        success: false,
        error: error.message,
        code: "UNAUTHORIZED_SENDER",
        sender: error.sender,
      };
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
        config.env === "development" && error instanceof Error ? error.stack : undefined,
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
  /** Every REST API module under /api/v1 (see src/modules/api-plugins.ts) */
  .use(apiPlugins)
  /** Dashboard: server-rendered UI under /dashboard */
  .use(pagesPlugin)
  .listen({
    port: config.server.port,
    hostname: config.server.host,
    maxRequestBodySize: config.server.maxRequestBodyBytes,
  });

logger.info("BunMail server started", {
  port: config.server.port,
  host: config.server.host,
});

/** Forward-confirmed reverse DNS of the sending IPs (#248): reported, never fatal. */
void logReverseDnsAtBoot();

/**
 * Start the email queue processor.
 * It polls the DB every 2 seconds for queued emails and sends them.
 */
queueService.start().catch((error: unknown) => {
  logger.error("Failed to start email queue processor", {
    error: error instanceof Error ? error.message : String(error),
  });
});

/**
 * Start the inbound SMTP server (if enabled).
 *
 * Inbound is opt-in (`SMTP_ENABLED=true`). When it's off we log an
 * explicit info line so the silent-fail mode ("I set up MX records
 * but nothing arrives") is one `grep` away from a diagnosis instead
 * of a head-scratch. (#93)
 */
if (config.smtp.enabled) {
  smtpReceiver.start();
} else {
  logger.info(
    "Inbound SMTP receiver disabled: set SMTP_ENABLED=true (and publish the SMTP port in docker-compose.override.yml, see docker-compose.override.example.yml) to enable",
  );
}

/**
 * Start the SMTP submission server (#120) if enabled. This is the
 * AUTH-required endpoint that lets SMTP-capable apps (Infisical, Netbird,
 * Dify, a Nodemailer backend, …) send *through* BunMail. Opt-in and
 * separate from the inbound receiver above, see docs/smtp-submission.md.
 */
if (config.smtpSubmission.enabled) {
  smtpSubmission.start();
} else {
  logger.info(
    "SMTP submission server disabled: set SMTP_SUBMISSION_ENABLED=true (and publish the submission port in docker-compose.override.yml, see docker-compose.override.example.yml) to let apps send via SMTP",
  );
}

/**
 * Start the trash purge: periodically removes soft-deleted emails
 * older than TRASH_RETENTION_DAYS.
 */
trashPurge.start();

/**
 * Start the webhook delivery worker: drains the persisted
 * `webhook_deliveries` queue, retries on a schedule of 1m / 5m / 15m /
 * 1h / 6h, and prunes delivered rows older than the retention cutoff.
 */
webhookDeliveryWorker.start();

/**
 * Start the scheduled DNS re-verification of domains (#250): every few
 * minutes, checks the domains due (daily by default) and flips one whose
 * records keep failing. Off with DOMAIN_REVERIFY_ENABLED=false.
 */
domainReverify.start();

/**
 * Start the periodic sweep that drops expired entries from the HTTP
 * rate-limit map (prevents unbounded growth under many distinct keys).
 */
startRateLimitCleanup();

/**
 * Start the periodic sweep for the dashboard login brute-force limiter
 * (#109): prunes expired per-IP failed-attempt entries so a long-lived
 * server doesn't accumulate them unbounded under attacker IP rotation.
 */
startLoginRateLimitCleanup(config.dashboard.loginRateLimit.windowSec * 1000);

/**
 * Graceful shutdown handler.
 * Stops the queue processor first (no new emails picked up),
 * then stops the HTTP server.
 */
function shutdown() {
  logger.info("Shutting down...");
  queueService.stop();
  /** Hand this process's in-flight emails back before exiting (#180),
   *  instead of leaving them leased for 15 minutes. Best effort. */
  void queueService
    .releaseOwnLeases()
    .catch(() => undefined)
    .finally(() => finishShutdown());
}

function finishShutdown() {
  smtpReceiver.stop();
  smtpSubmission.stop();
  trashPurge.stop();
  webhookDeliveryWorker.stop();
  domainReverify.stop();
  stopRateLimitCleanup();
  stopLoginRateLimitCleanup();
  void app.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

/** Export the app type for Elysia's type-safe client (Eden) */
export type App = typeof app;
