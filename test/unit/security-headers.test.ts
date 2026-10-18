import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import {
  BASELINE_CSP,
  securityHeaders,
  securityHeadersPlugin,
} from "../../src/middleware/security-headers.ts";

/**
 * Browser security headers (#255, part 1). The module is config-free, so
 * the test builds a small app with the real plugin and checks every kind
 * of response it can produce.
 */

describe("securityHeaders", () => {
  test("baseline headers on every path", () => {
    expect(securityHeaders("/api/v1/emails", { httpsBaseUrl: false })).toEqual({
      "content-security-policy": BASELINE_CSP,
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    });
  });

  test("the CSP forbids plugins, base rewriting, foreign form targets and framing", () => {
    expect(BASELINE_CSP).toContain("object-src 'none'");
    expect(BASELINE_CSP).toContain("base-uri 'none'");
    expect(BASELINE_CSP).toContain("form-action 'self'");
    expect(BASELINE_CSP).toContain("frame-ancestors 'none'");
  });

  test.each(["/dashboard", "/dashboard/", "/dashboard/api-keys"])(
    "%p is never cached",
    (path) => {
      expect(securityHeaders(path, { httpsBaseUrl: false })["cache-control"]).toBe(
        "no-store",
      );
    },
  );

  test.each(["/", "/favicon.svg", "/api/v1/emails", "/dashboardx"])(
    "%p keeps its own caching",
    (path) => {
      expect(
        securityHeaders(path, { httpsBaseUrl: false })["cache-control"],
      ).toBeUndefined();
    },
  );

  test("HSTS only when the dashboard is served over HTTPS", () => {
    expect(
      securityHeaders("/", { httpsBaseUrl: true })["strict-transport-security"],
    ).toBe("max-age=31536000");
    expect(
      securityHeaders("/", { httpsBaseUrl: false })["strict-transport-security"],
    ).toBeUndefined();
  });
});

describe("securityHeadersPlugin", () => {
  const app = new Elysia()
    .onError(({ code }) => {
      if (code === "NOT_FOUND") {
        return new Response("<p>not found</p>", {
          status: 404,
          headers: { "content-type": "text/html" },
        });
      }
    })
    .use(securityHeadersPlugin({ httpsBaseUrl: true }))
    .get("/dashboard/page", () => "page")
    .get("/dashboard/own-response", () => new Response("r"))
    .get("/dashboard/redirect", ({ set }) => {
      set.status = 302;
      set.headers["location"] = "/dashboard/page";
      return "";
    })
    .get("/dashboard/override", ({ set }) => {
      set.headers["referrer-policy"] = "strict-origin";
      return "auth page";
    });

  test.each([
    ["/dashboard/page", 200],
    ["/dashboard/own-response", 200],
    ["/dashboard/redirect", 302],
    ["/dashboard/missing", 404],
  ])("%p (%p) carries every header", async (path, status) => {
    const response = await app.handle(new Request(`http://localhost${path}`));
    expect(response.status).toBe(status);
    expect(response.headers.get("content-security-policy")).toBe(BASELINE_CSP);
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("strict-transport-security")).toBe("max-age=31536000");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("a handler can still override a header", async () => {
    const response = await app.handle(new Request("http://localhost/dashboard/override"));
    expect(response.headers.get("referrer-policy")).toBe("strict-origin");
  });
});
