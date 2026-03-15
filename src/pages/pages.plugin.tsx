import { Elysia, t } from "elysia";
import { html } from "@elysiajs/html";
import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";

/* ─── Page Components ─── */
import { LoginPage, DashboardDisabledPage } from "./routes/login.tsx";
import { HomePage } from "./routes/home.tsx";
import { EmailsPage } from "./routes/emails.tsx";
import { EmailDetailPage } from "./routes/email-detail.tsx";
import { ApiKeysPage } from "./routes/api-keys.tsx";
import { DomainsPage } from "./routes/domains.tsx";
import { DomainDetailPage } from "./routes/domain-detail.tsx";

/* ─── Services ─── */
import * as statsService from "../modules/emails/services/stats.service.ts";
import * as emailService from "../modules/emails/services/email.service.ts";
import * as apiKeyService from "../modules/api-keys/services/api-key.service.ts";
import * as domainService from "../modules/domains/services/domain.service.ts";
import { verifyDomain } from "../modules/domains/services/dns-verification.service.ts";

/* ─── Session Helpers ─── */

/** Max session age in seconds (24 hours) */
const SESSION_MAX_AGE = 86400;

/**
 * Creates a signed session cookie value.
 * Format: `<timestamp>.<hmac_hex>` where timestamp is Unix epoch (seconds).
 */
function createSessionCookie(): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const hmac = createHmac("sha256", config.dashboard.sessionSecret)
    .update(String(timestamp))
    .digest("hex");
  return `${timestamp}.${hmac}`;
}

/**
 * Validates a session cookie value.
 * Recomputes HMAC and checks timestamp is within 24h.
 *
 * @returns true if the session is valid
 */
function validateSessionCookie(cookie: string): boolean {
  const dotIndex = cookie.indexOf(".");
  if (dotIndex === -1) return false;

  const timestamp = cookie.substring(0, dotIndex);
  const providedHmac = cookie.substring(dotIndex + 1);

  /** Check timestamp is a valid number and within 24h */
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;

  const now = Math.floor(Date.now() / 1000);
  if (now - ts > SESSION_MAX_AGE) return false;

  /** Recompute HMAC and compare with timing-safe comparison */
  const expectedHmac = createHmac("sha256", config.dashboard.sessionSecret)
    .update(timestamp)
    .digest("hex");

  /** Both must be the same length for timingSafeEqual */
  if (providedHmac.length !== expectedHmac.length) return false;

  return timingSafeEqual(
    Buffer.from(providedHmac),
    Buffer.from(expectedHmac)
  );
}

/**
 * Extracts the bm_session cookie value from the Cookie header.
 *
 * @returns The cookie value, or undefined if not found
 */
function getSessionCookie(request: Request): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  const match = cookieHeader.match(/bm_session=([^;]+)/);
  return match?.[1];
}

/**
 * Validates the dashboard password using timing-safe comparison.
 *
 * @returns true if the password matches DASHBOARD_PASSWORD
 */
function validatePassword(input: string): boolean {
  const expected = config.dashboard.password;
  if (input.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(input), Buffer.from(expected));
}

/* ─── Dashboard Plugin ─── */

/**
 * Pages plugin — server-rendered dashboard under /dashboard.
 *
 * Routes:
 * - GET  /dashboard/login           → login form
 * - POST /dashboard/login           → validate password, set cookie
 * - POST /dashboard/logout          → clear cookie, redirect
 * - GET  /dashboard                 → home (stats overview)
 * - GET  /dashboard/emails          → email list with filters
 * - GET  /dashboard/emails/:id      → email detail
 * - GET  /dashboard/api-keys        → API keys list + create form
 * - POST /dashboard/api-keys        → create API key (form action)
 * - POST /dashboard/api-keys/:id/revoke → revoke API key (form action)
 * - GET  /dashboard/domains         → domains list + add form
 * - POST /dashboard/domains         → add domain (form action)
 * - POST /dashboard/domains/:id/delete → delete domain (form action)
 * - GET  /dashboard/domains/:id     → domain detail
 *
 * Auth: password-based via DASHBOARD_PASSWORD env var + session cookie.
 */
export const pagesPlugin = new Elysia({
  prefix: "/dashboard",
  normalize: true,
})
  /** Enable JSX rendering via @elysiajs/html */
  .use(html())

  /* ─── Public Routes (no session required) ─── */

  /**
   * GET /dashboard/login
   * Shows the login form. If dashboard is disabled (no password set),
   * shows a "Dashboard disabled" page instead.
   */
  .get("/login", ({ query }) => {
    if (!config.dashboard.password) {
      return <DashboardDisabledPage />;
    }
    /** Show error message if redirected after wrong password */
    const error = query.error === "invalid" ? "Invalid password. Please try again." : undefined;
    return <LoginPage error={error} />;
  }, {
    query: t.Object({
      error: t.Optional(t.String()),
    }),
  })

  /**
   * POST /dashboard/login
   * Validates the password and sets a session cookie on success.
   * Redirects back to login with error on failure.
   */
  .post("/login", ({ body, set }) => {
    if (!config.dashboard.password) {
      set.status = 403;
      return <DashboardDisabledPage />;
    }

    if (!validatePassword(body.password)) {
      logger.warn("Dashboard login failed: invalid password");
      set.status = 302;
      set.headers["location"] = "/dashboard/login?error=invalid";
      return "";
    }

    logger.info("Dashboard login successful");

    /** Set session cookie — HttpOnly, SameSite=Lax, 24h expiry */
    const sessionValue = createSessionCookie();
    set.headers["set-cookie"] =
      `bm_session=${sessionValue}; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=${SESSION_MAX_AGE}`;
    set.status = 302;
    set.headers["location"] = "/dashboard";
    return "";
  }, {
    body: t.Object({
      password: t.String(),
    }),
  })

  /**
   * POST /dashboard/logout
   * Clears the session cookie and redirects to login.
   */
  .post("/logout", ({ set }) => {
    logger.info("Dashboard logout");
    /** Clear cookie by setting Max-Age=0 */
    set.headers["set-cookie"] =
      "bm_session=; HttpOnly; SameSite=Lax; Path=/dashboard; Max-Age=0";
    set.status = 302;
    set.headers["location"] = "/dashboard/login";
    return "";
  })

  /* ─── Session Guard ─── */

  /**
   * All routes below this guard require a valid session cookie.
   * If the dashboard is disabled or the session is invalid, redirect to login.
   */
  .onBeforeHandle(({ request, set, path }) => {
    /** Skip auth for login/logout routes (already handled above) */
    if (path === "/dashboard/login" || path === "/dashboard/logout") {
      return;
    }

    /** Dashboard disabled — redirect to login page (shows disabled message) */
    if (!config.dashboard.password) {
      set.status = 302;
      set.headers["location"] = "/dashboard/login";
      return "";
    }

    /** Check session cookie */
    const sessionCookie = getSessionCookie(request);
    if (!sessionCookie || !validateSessionCookie(sessionCookie)) {
      logger.debug("Dashboard session invalid, redirecting to login");
      set.status = 302;
      set.headers["location"] = "/dashboard/login";
      return "";
    }
  })

  /* ─── Protected Routes ─── */

  /**
   * GET /dashboard
   * Dashboard home — shows stat cards with overview counts.
   */
  .get("/", async () => {
    const stats = await statsService.getDashboardStats();
    return <HomePage stats={stats} />;
  })

  /**
   * GET /dashboard/emails
   * Email list with status filter tabs and pagination.
   */
  .get("/emails", async ({ query }) => {
    const page = query.page ? parseInt(query.page, 10) : 1;
    const limit = query.limit ? parseInt(query.limit, 10) : 20;
    const status = query.status || undefined;

    const { data, total } = await emailService.listAllEmails({
      page,
      limit,
      status: status as "queued" | "sending" | "sent" | "failed" | undefined,
    });

    return <EmailsPage emails={data} total={total} page={page} limit={limit} status={status} />;
  }, {
    query: t.Object({
      page: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      status: t.Optional(t.String()),
    }),
  })

  /**
   * GET /dashboard/emails/:id
   * Single email detail view.
   */
  .get("/emails/:id", async ({ params, set }) => {
    const email = await emailService.getEmailByIdUnscoped(params.id);

    if (!email) {
      set.status = 404;
      return "Email not found";
    }

    return <EmailDetailPage email={email} />;
  }, {
    params: t.Object({
      id: t.String(),
    }),
  })

  /**
   * GET /dashboard/api-keys
   * API keys list with create form. Shows flash messages from query params.
   */
  .get("/api-keys", async ({ query }) => {
    const keys = await apiKeyService.listApiKeys();

    /** Parse flash message from query params (set after create/revoke) */
    const flash = query.flash
      ? { message: query.flash, type: (query.flashType ?? "success") as "success" | "error" }
      : undefined;

    return <ApiKeysPage keys={keys} flash={flash} rawKey={query.rawKey} />;
  }, {
    query: t.Object({
      flash: t.Optional(t.String()),
      flashType: t.Optional(t.String()),
      rawKey: t.Optional(t.String()),
    }),
  })

  /**
   * POST /dashboard/api-keys
   * Creates a new API key via form submission.
   * Redirects back to the list with the raw key shown once.
   */
  .post("/api-keys", async ({ body, set }) => {
    try {
      const { rawKey } = await apiKeyService.createApiKey({ name: body.name });

      logger.info("API key created via dashboard", { name: body.name });

      /** Redirect with raw key in query — shown once in a flash message */
      set.status = 302;
      set.headers["location"] = `/dashboard/api-keys?flash=${encodeURIComponent("API key created successfully")}&rawKey=${encodeURIComponent(rawKey)}`;
    } catch (error) {
      logger.error("Failed to create API key via dashboard", {
        error: error instanceof Error ? error.message : String(error),
      });
      set.status = 302;
      set.headers["location"] = `/dashboard/api-keys?flash=${encodeURIComponent("Failed to create API key")}&flashType=error`;
    }
    return "";
  }, {
    body: t.Object({
      name: t.String(),
    }),
  })

  /**
   * POST /dashboard/api-keys/:id/revoke
   * Revokes an API key via form submission.
   */
  .post("/api-keys/:id/revoke", async ({ params, set }) => {
    const apiKey = await apiKeyService.revokeApiKey(params.id);

    if (!apiKey) {
      set.status = 302;
      set.headers["location"] = `/dashboard/api-keys?flash=${encodeURIComponent("API key not found")}&flashType=error`;
      return "";
    }

    logger.info("API key revoked via dashboard", { id: params.id });
    set.status = 302;
    set.headers["location"] = `/dashboard/api-keys?flash=${encodeURIComponent("API key revoked")}`;
    return "";
  }, {
    params: t.Object({
      id: t.String(),
    }),
  })

  /**
   * GET /dashboard/domains
   * Domains list with add form. Shows flash messages from query params.
   */
  .get("/domains", async ({ query }) => {
    const domainList = await domainService.listDomains();

    const flash = query.flash
      ? { message: query.flash, type: (query.flashType ?? "success") as "success" | "error" }
      : undefined;

    return <DomainsPage domains={domainList} flash={flash} />;
  }, {
    query: t.Object({
      flash: t.Optional(t.String()),
      flashType: t.Optional(t.String()),
    }),
  })

  /**
   * POST /dashboard/domains
   * Adds a new domain via form submission.
   */
  .post("/domains", async ({ body, set }) => {
    try {
      await domainService.createDomain({ name: body.name });

      logger.info("Domain added via dashboard", { name: body.name });
      set.status = 302;
      set.headers["location"] = `/dashboard/domains?flash=${encodeURIComponent("Domain added successfully")}`;
    } catch (error) {
      logger.error("Failed to add domain via dashboard", {
        error: error instanceof Error ? error.message : String(error),
      });
      set.status = 302;
      set.headers["location"] = `/dashboard/domains?flash=${encodeURIComponent("Failed to add domain")}&flashType=error`;
    }
    return "";
  }, {
    body: t.Object({
      name: t.String(),
    }),
  })

  /**
   * POST /dashboard/domains/:id/delete
   * Deletes a domain via form submission.
   */
  .post("/domains/:id/delete", async ({ params, set }) => {
    const domain = await domainService.deleteDomain(params.id);

    if (!domain) {
      set.status = 302;
      set.headers["location"] = `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
      return "";
    }

    logger.info("Domain deleted via dashboard", { id: params.id });
    set.status = 302;
    set.headers["location"] = `/dashboard/domains?flash=${encodeURIComponent("Domain deleted")}`;
    return "";
  }, {
    params: t.Object({
      id: t.String(),
    }),
  })

  /**
   * POST /dashboard/domains/:id/verify
   * Triggers DNS verification and redirects back to domain detail.
   */
  .post("/domains/:id/verify", async ({ params, set }) => {
    const domain = await domainService.getDomainById(params.id);

    if (!domain) {
      set.status = 302;
      set.headers["location"] = `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
      return "";
    }

    const result = await verifyDomain(domain);
    const allPassed = result.spf && result.dkim && result.dmarc;
    const message = allPassed
      ? "All DNS records verified successfully!"
      : `Verification: SPF ${result.spf ? "✓" : "✗"}, DKIM ${result.dkim ? "✓" : "✗"}, DMARC ${result.dmarc ? "✓" : "✗"}`;

    logger.info("Domain DNS verification via dashboard", { id: params.id, ...result });

    set.status = 302;
    set.headers["location"] = `/dashboard/domains/${params.id}?flash=${encodeURIComponent(message)}&flashType=${allPassed ? "success" : "error"}`;
    return "";
  }, {
    params: t.Object({
      id: t.String(),
    }),
  })

  /**
   * GET /dashboard/domains/:id
   * Single domain detail view with DNS verification status.
   */
  .get("/domains/:id", async ({ params, set, query }) => {
    const domain = await domainService.getDomainById(params.id);

    if (!domain) {
      set.status = 404;
      return "Domain not found";
    }

    const flash = query.flash
      ? { message: query.flash, type: (query.flashType ?? "success") as "success" | "error" }
      : undefined;

    return <DomainDetailPage domain={domain} flash={flash} />;
  }, {
    params: t.Object({
      id: t.String(),
    }),
    query: t.Object({
      flash: t.Optional(t.String()),
      flashType: t.Optional(t.String()),
    }),
  });
