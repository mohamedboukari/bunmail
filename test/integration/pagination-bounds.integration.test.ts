/**
 * Pagination bounds on the two API list routes that used raw parseInt
 * (#172), against a real Postgres over HTTP (real auth, no mocks).
 *
 * Before the fix, `?page=0` reached Postgres as a negative OFFSET (500),
 * and `?limit=abc` / huge limits read the whole table (the driver treats a
 * NaN limit as no limit). Now invalid values are rejected with 422 before
 * any query runs, matching the other API list endpoints.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { emailsPlugin } from "../../src/modules/emails/emails.plugin.ts";
import { webhooksPlugin } from "../../src/modules/webhooks/webhooks.plugin.ts";
import { suppressionsPlugin } from "../../src/modules/suppressions/suppressions.plugin.ts";
import { dmarcReportsPlugin } from "../../src/modules/dmarc-reports/dmarc-reports.plugin.ts";
import { inboundPlugin } from "../../src/modules/inbound/inbound.plugin.ts";
import { truncateAll, seed } from "./_helpers.ts";
import { readJson } from "../read-json.ts";

const app = new Elysia()
  .use(emailsPlugin)
  .use(webhooksPlugin)
  .use(suppressionsPlugin)
  .use(dmarcReportsPlugin)
  .use(inboundPlugin);

function get(path: string, key: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { authorization: `Bearer ${key}` },
    }),
  );
}

let rawKey: string;
let webhookId: string;

beforeEach(async () => {
  await truncateAll();
  const key = await seed.apiKey({ isAdmin: true });
  rawKey = key.rawKey;
  const hook = await seed.webhook({
    apiKeyId: key.id,
    url: "https://example.com/hook",
    events: ["email.sent"],
  });
  webhookId = hook.id;
});

const BAD = [
  "page=0",
  "page=-1",
  "page=abc",
  "limit=0",
  "limit=abc",
  "limit=101",
  "limit=99999999",
];

describe("GET /api/v1/emails/tombstones pagination (#172)", () => {
  for (const qs of BAD) {
    test(`?${qs} is rejected with 422, never a 500 or an unbounded read`, async () => {
      expect((await get(`/api/v1/emails/tombstones?${qs}`, rawKey)).status).toBe(422);
    });
  }

  test("valid bounds succeed and echo the pagination", async () => {
    const res = await get("/api/v1/emails/tombstones?page=2&limit=100", rawKey);
    expect(res.status).toBe(200);
    const body = await readJson<{ pagination: { page: number; limit: number } }>(res);
    expect(body.pagination).toMatchObject({ page: 2, limit: 100 });
  });

  test("defaults apply when params are omitted", async () => {
    const res = await get("/api/v1/emails/tombstones", rawKey);
    expect(res.status).toBe(200);
    const body = await readJson<{ pagination: { page: number; limit: number } }>(res);
    expect(body.pagination).toMatchObject({ page: 1, limit: 20 });
  });
});

describe("GET /api/v1/webhooks/:id/deliveries pagination (#172)", () => {
  for (const qs of BAD) {
    test(`?${qs} is rejected with 422, never a 500 or an unbounded read`, async () => {
      expect(
        (await get(`/api/v1/webhooks/${webhookId}/deliveries?${qs}`, rawKey)).status,
      ).toBe(422);
    });
  }

  test("valid bounds succeed", async () => {
    const res = await get(
      `/api/v1/webhooks/${webhookId}/deliveries?page=1&limit=100`,
      rawKey,
    );
    expect(res.status).toBe(200);
  });
});

/**
 * A huge page pushed OFFSET past Postgres's bigint range and returned 500
 * on every bounded list endpoint, including ones whose DTOs looked correct.
 * Page is now capped at 1,000,000 everywhere.
 */
describe("page cap on all API list routes (#172)", () => {
  const routes = (): string[] => [
    "/api/v1/emails",
    "/api/v1/emails/trash",
    "/api/v1/emails/tombstones",
    "/api/v1/inbound",
    "/api/v1/inbound/trash",
    `/api/v1/webhooks/${webhookId}/deliveries`,
    "/api/v1/suppressions",
    "/api/v1/dmarc-reports",
  ];

  test("a page beyond 1,000,000 is a 422 everywhere, never a 500", async () => {
    for (const path of routes()) {
      for (const page of ["1000001", "99999999999999999999"]) {
        const res = await get(`${path}?page=${page}`, rawKey);
        expect({ path, page, status: res.status }).toEqual({ path, page, status: 422 });
      }
    }
  });

  test("page 1,000,000 itself is accepted everywhere", async () => {
    for (const path of routes()) {
      const res = await get(`${path}?page=1000000&limit=100`, rawKey);
      expect({ path, status: res.status }).toEqual({ path, status: 200 });
    }
  });
});
