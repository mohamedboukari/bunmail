import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import { metricsPlugin } from "../../src/modules/metrics/metrics.plugin.ts";

/**
 * `GET /metrics` (#362): the scrape token guard and the response shape.
 * The token is passed in, so no `mock.module` of the config is needed.
 * The queue gauges read the database; without one here they are absent
 * and `bunmail_metrics_db_up` is 0, which is what an outage looks like.
 */

const TOKEN = "0123456789abcdef".repeat(4);

function scrape(
  app: { handle: (r: Request) => Promise<Response> },
  auth?: string,
): Promise<Response> {
  return app.handle(
    new Request("http://localhost/metrics", {
      headers: auth === undefined ? {} : { authorization: auth },
    }),
  );
}

describe("GET /metrics", () => {
  const app = new Elysia().use(metricsPlugin({ version: "9.9.9", token: TOKEN }));

  test("the right token gets the text format, uncached", async () => {
    const response = await scrape(app, `Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; version=0.0.4; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const text = await response.text();
    expect(text).toContain(
      `bunmail_build_info{version="9.9.9",bun="${Bun.version}"} 1\n`,
    );
    expect(text).toContain("# TYPE bunmail_emails_finished_total counter\n");
    expect(text).toContain("# TYPE bunmail_http_request_duration_seconds histogram\n");
    expect(text).toMatch(/^bunmail_metrics_db_up [01]$/m);
    expect(text).toMatch(/^process_resident_memory_bytes \d+$/m);
  });

  test.each([
    ["no Authorization header", undefined],
    ["a wrong token", `Bearer ${"f".repeat(64)}`],
    ["the token without the Bearer scheme", TOKEN],
  ])("%s gets 401 with a Bearer challenge and no metrics", async (_label, auth) => {
    const response = await scrape(app, auth);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="metrics"');
    expect(await response.text()).not.toContain("bunmail_");
  });

  test("without a token the endpoint is a plain 404", async () => {
    const off = new Elysia().use(metricsPlugin({ version: "9.9.9", token: null }));
    const response = await scrape(off, `Bearer ${TOKEN}`);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("bunmail_");
  });
});
