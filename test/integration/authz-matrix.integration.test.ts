/**
 * Authorization matrix for every REST API route (#228), through the real
 * auth, admin and rate-limit middleware against real Postgres.
 *
 * The e2e suites stub the middleware, so they can't see a route that
 * forgets a guard or a guard that stops applying. This mounts exactly the
 * plugins production mounts (`apiPlugins`), reads the routes from the
 * router, and requires an entry in `ROUTES` for each: a new route without
 * one fails the test. Every route is then called as:
 *
 * - no key, an invalid key, a revoked key → 401
 * - a restricted key on an admin-only route → 403
 * - another tenant's key on a tenant-owned resource → 404, resource intact
 * - an allowed key → not 401/403
 *
 * Request bodies are validated before the auth hooks run, so write routes
 * get a minimal valid body: otherwise an unauthenticated call would get
 * 422 and the test would never reach the auth layer.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { apiPlugins } from "../../src/modules/api-plugins.ts";
import { enqueueDelivery } from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { emailTombstones } from "../../src/modules/emails/models/email-tombstone.schema.ts";
import {
  truncateAll,
  seed,
  db,
  apiKeys,
  emails,
  templates,
  webhooks,
  suppressions,
} from "./_helpers.ts";

const app = new Elysia().use(apiPlugins);

/** Kinds of tenant-owned resources a route can take in its path. */
type Owned = "email" | "tombstone" | "template" | "webhook" | "delivery" | "suppression";

interface RouteSpec {
  /** `admin`: admin keys only. `key`: any active key. */
  access: "admin" | "key";
  /** Minimal valid body for write routes. */
  body?: unknown;
  /** The path id is a resource owned by one API key. */
  owned?: Owned;
}

const HOOK_URL = "https://93.184.216.34/hook";

/** Every route, keyed by `METHOD path` exactly as the router reports it. */
const ROUTES: Record<string, RouteSpec> = {
  "POST /api/v1/emails/send": {
    access: "key",
    body: { from: "hello@example.com", to: "user@example.org", subject: "x", text: "x" },
  },
  "GET /api/v1/emails/": { access: "key" },
  "GET /api/v1/emails/trash": { access: "key" },
  "GET /api/v1/emails/tombstones": { access: "key" },
  "GET /api/v1/emails/tombstones/:id": { access: "key", owned: "tombstone" },
  "GET /api/v1/emails/:id": { access: "key", owned: "email" },
  "DELETE /api/v1/emails/:id": { access: "key", owned: "email" },
  "DELETE /api/v1/emails/:id/permanent": { access: "key", owned: "email" },
  "POST /api/v1/emails/:id/restore": { access: "key", owned: "email" },
  "POST /api/v1/emails/bulk-delete": { access: "key", body: { ids: ["msg_missing"] } },
  "POST /api/v1/emails/trash/empty": { access: "key" },

  "GET /api/v1/api-keys/": { access: "admin" },
  "POST /api/v1/api-keys/": { access: "admin", body: { name: "matrix" } },
  "PATCH /api/v1/api-keys/:id": { access: "admin", body: { name: "renamed" } },
  "DELETE /api/v1/api-keys/:id": { access: "admin" },

  "POST /api/v1/domains/": { access: "admin", body: { name: "matrix.acme.io" } },
  "GET /api/v1/domains/": { access: "admin" },
  "GET /api/v1/domains/:id": { access: "admin" },
  "PATCH /api/v1/domains/:id": { access: "admin", body: { unsubscribeUrl: null } },
  "DELETE /api/v1/domains/:id": { access: "admin" },
  "POST /api/v1/domains/:id/verify": { access: "admin" },

  "POST /api/v1/webhooks/": {
    access: "key",
    body: { url: HOOK_URL, events: ["email.sent"] },
  },
  "GET /api/v1/webhooks/": { access: "key" },
  "DELETE /api/v1/webhooks/:id": { access: "key", owned: "webhook" },
  "GET /api/v1/webhooks/:id/deliveries": { access: "key", owned: "webhook" },
  "GET /api/v1/webhooks/deliveries/:deliveryId": { access: "key", owned: "delivery" },
  "POST /api/v1/webhooks/deliveries/:deliveryId/replay": {
    access: "key",
    owned: "delivery",
  },

  "POST /api/v1/templates/": { access: "key", body: { name: "t", subject: "Hi" } },
  "GET /api/v1/templates/": { access: "key" },
  "GET /api/v1/templates/:id": { access: "key", owned: "template" },
  "PUT /api/v1/templates/:id": {
    access: "key",
    owned: "template",
    body: { name: "renamed" },
  },
  "DELETE /api/v1/templates/:id": { access: "key", owned: "template" },

  "GET /api/v1/inbound/": { access: "admin" },
  "GET /api/v1/inbound/trash": { access: "admin" },
  "GET /api/v1/inbound/:id": { access: "admin" },
  "DELETE /api/v1/inbound/:id": { access: "admin" },
  "DELETE /api/v1/inbound/:id/permanent": { access: "admin" },
  "POST /api/v1/inbound/:id/restore": { access: "admin" },
  "POST /api/v1/inbound/bulk-delete": { access: "admin", body: { ids: ["inb_missing"] } },
  "POST /api/v1/inbound/trash/empty": { access: "admin" },

  "POST /api/v1/suppressions/": {
    access: "key",
    body: { email: "nobody@example.org", reason: "manual" },
  },
  "GET /api/v1/suppressions/": { access: "key" },
  "GET /api/v1/suppressions/:id": { access: "key", owned: "suppression" },
  "DELETE /api/v1/suppressions/:id": { access: "key", owned: "suppression" },

  "GET /api/v1/smtp-submission/stats": { access: "key" },

  "GET /api/v1/dmarc-reports/": { access: "admin" },
  "GET /api/v1/dmarc-reports/:id": { access: "admin" },
};

const routes = app.routes.map((r) => `${r.method} ${r.path}`);

/** Raw keys and the resources tenant A owns. */
const keys = { admin: "", tenantA: "", tenantB: "", revoked: "" };
const ownedByA: Record<Owned, string> = {
  email: "",
  tombstone: "",
  template: "",
  webhook: "",
  delivery: "",
  suppression: "",
};

/** Fills path params with `id` (or the matching owned id). */
function concretePath(path: string, id: string): string {
  return path.replace(/:[A-Za-z]+/g, id);
}

function call(route: string, key: string | null, id = "x_missing"): Promise<Response> {
  const spec = ROUTES[route];
  const space = route.indexOf(" ");
  const method = route.slice(0, space);
  const path = route.slice(space + 1);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["authorization"] = `Bearer ${key}`;
  return app.handle(
    new Request(`http://localhost${concretePath(path, id)}`, {
      method,
      headers,
      body: spec?.body === undefined ? undefined : JSON.stringify(spec.body),
    }),
  );
}

beforeAll(async () => {
  await truncateAll();
  keys.admin = (await seed.apiKey({ isAdmin: true })).rawKey;
  const a = await seed.apiKey({ isAdmin: false });
  keys.tenantA = a.rawKey;
  keys.tenantB = (await seed.apiKey({ isAdmin: false })).rawKey;
  const revoked = await seed.apiKey({ isAdmin: true });
  keys.revoked = revoked.rawKey;
  await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, revoked.id));

  ownedByA.email = (await seed.email({ apiKeyId: a.id, status: "sent" })).id;
  ownedByA.tombstone = "msg_tombstone00000000000000";
  await db.insert(emailTombstones).values({
    id: ownedByA.tombstone,
    apiKeyId: a.id,
    fromAddress: "hello@example.com",
    toAddress: "user@example.org",
    status: "sent",
  });
  ownedByA.template = (await seed.template({ apiKeyId: a.id })).id;
  const hook = await seed.webhook({
    apiKeyId: a.id,
    url: HOOK_URL,
    events: ["email.sent"],
  });
  ownedByA.webhook = hook.id;
  ownedByA.delivery = (
    await enqueueDelivery({
      webhookId: hook.id,
      envelope: { event: "email.sent", timestamp: "2026-01-01T00:00:00.000Z", data: {} },
    })
  ).id;
  ownedByA.suppression = (
    await seed.suppression({ apiKeyId: a.id, email: "blocked@example.org" })
  ).id;
});

describe("route inventory", () => {
  test("every mounted route has an expectation, and every expectation a route", () => {
    expect(routes.toSorted()).toEqual(Object.keys(ROUTES).toSorted());
  });
});

describe("unauthenticated, invalid and revoked keys get 401 on every route", () => {
  for (const route of routes) {
    test(route, async () => {
      expect((await call(route, null)).status).toBe(401);
      expect((await call(route, "bm_live_not_a_real_key")).status).toBe(401);
      expect((await call(route, keys.revoked)).status).toBe(401);
    });
  }
});

describe("restricted keys get 403 on admin-only routes", () => {
  for (const route of routes.filter((r) => ROUTES[r]?.access === "admin")) {
    test(route, async () => {
      expect((await call(route, keys.tenantB)).status).toBe(403);
    });
  }
});

describe("allowed keys pass the auth layer", () => {
  for (const route of routes) {
    test(route, async () => {
      const key = ROUTES[route]?.access === "admin" ? keys.admin : keys.tenantB;
      expect([401, 403]).not.toContain((await call(route, key)).status);
    });
  }
});

describe("another tenant's resources are invisible (404) and untouched", () => {
  for (const route of routes.filter((r) => ROUTES[r]?.owned)) {
    test(route, async () => {
      const owned = ROUTES[route]!.owned!;
      expect((await call(route, keys.tenantB, ownedByA[owned])).status).toBe(404);
    });
  }

  test("tenant A's resources all survived tenant B's calls", async () => {
    const [email] = await db.select().from(emails).where(eq(emails.id, ownedByA.email));
    expect(email?.deletedAt).toBeNull();
    expect(
      await db.select().from(templates).where(eq(templates.id, ownedByA.template)),
    ).toHaveLength(1);
    expect(
      await db.select().from(webhooks).where(eq(webhooks.id, ownedByA.webhook)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(suppressions)
        .where(eq(suppressions.id, ownedByA.suppression)),
    ).toHaveLength(1);
  });

  test("bulk-delete with another tenant's ids trashes nothing", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/emails/bulk-delete", {
        method: "POST",
        headers: {
          authorization: `Bearer ${keys.tenantB}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ids: [ownedByA.email] }),
      }),
    );
    expect(res.status).toBe(200);
    const [email] = await db.select().from(emails).where(eq(emails.id, ownedByA.email));
    expect(email?.deletedAt).toBeNull();
  });

  test("the owner still sees its own resource", async () => {
    expect(
      (await call("GET /api/v1/emails/:id", keys.tenantA, ownedByA.email)).status,
    ).toBe(200);
  });
});
