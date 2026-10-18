import { describe, test, expect, spyOn, afterEach } from "bun:test";
import { Elysia } from "elysia";
import {
  requestLogLevel,
  requestLogPath,
  withRequestContext,
} from "../../src/middleware/request-context.ts";
import { getLogContext } from "../../src/utils/log-context.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The HTTP request context (#284): Elysia's `wrap` runs each request in
 * its own log context, returns `X-Request-Id`, and writes one line per
 * request. The app here mirrors `src/index.ts` (`.wrap(withRequestContext)`
 * first); a test pins that the context really reaches handlers, so an
 * Elysia upgrade that changes `wrap` fails CI instead of silently losing
 * the IDs.
 */

const app = new Elysia()
  .wrap(withRequestContext)
  .get("/seen", async () => {
    await Bun.sleep(1);
    return { requestId: getLogContext()?.requestId ?? null };
  })
  .get("/missing", ({ set }) => {
    set.status = 404;
    return "nope";
  })
  .get("/denied", ({ set }) => {
    set.status = 403;
    return "no";
  })
  .get("/boom", () => {
    throw new Error("kaboom");
  });

const spies: Array<{ mockRestore: () => void }> = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

type Level = "debug" | "info" | "warn" | "error";

/** Captures every logger call by level. */
function captureLogs(): Record<Level, unknown[][]> {
  const calls: Record<Level, unknown[][]> = { debug: [], info: [], warn: [], error: [] };
  for (const level of ["debug", "info", "warn", "error"] as const) {
    const spy = spyOn(logger, level).mockImplementation((...args: unknown[]) => {
      calls[level].push(args);
    });
    spies.push(spy);
  }
  return calls;
}

/** The `requestId` a `/seen` response body reports, or null. */
async function reportedId(response: Response): Promise<string | null> {
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("requestId" in body)) return null;
  return typeof body.requestId === "string" ? body.requestId : null;
}

/** The data object of a captured logger call (its second argument), or {}. */
function fieldsOf(call: unknown[] | undefined): Record<string, unknown> {
  const data = call?.[1];
  return data !== null && typeof data === "object"
    ? Object.fromEntries(Object.entries(data))
    : {};
}

describe("withRequestContext", () => {
  test("the handler sees the request ID, which comes back as X-Request-Id", async () => {
    captureLogs();
    const response = await app.handle(new Request("http://localhost/seen"));
    const header = response.headers.get("x-request-id");
    expect(header).toMatch(/^req_[0-9a-f]{32}$/);
    expect(await reportedId(response)).toBe(header);
  });

  test("parallel requests each keep their own ID", async () => {
    captureLogs();
    const responses = await Promise.all(
      Array.from({ length: 20 }, () => app.handle(new Request("http://localhost/seen"))),
    );
    const pairs = await Promise.all(
      responses.map(async (r) => ({
        header: r.headers.get("x-request-id"),
        body: await reportedId(r),
      })),
    );
    expect(pairs.every((p) => p.header !== null && p.header === p.body)).toBe(true);
    expect(new Set(pairs.map((p) => p.header)).size).toBe(20);
  });

  test("a valid incoming X-Request-Id is reused, an invalid one replaced", async () => {
    captureLogs();
    const reused = await app.handle(
      new Request("http://localhost/seen", {
        headers: { "x-request-id": "proxy-abc.123" },
      }),
    );
    expect(reused.headers.get("x-request-id")).toBe("proxy-abc.123");

    const replaced = await app.handle(
      new Request("http://localhost/seen", { headers: { "x-request-id": "bad id" } }),
    );
    expect(replaced.headers.get("x-request-id")).toMatch(/^req_[0-9a-f]{32}$/);
  });

  test("one line per request: method, path without the query, status, duration", async () => {
    const logs = captureLogs();
    await app.handle(new Request("http://localhost/seen?token=secret-value"));
    const lines = logs.info.filter(([message]) => message === "HTTP request");
    expect(lines).toHaveLength(1);
    const fields = fieldsOf(lines[0]);
    expect(fields).toMatchObject({ method: "GET", path: "/seen", status: 200 });
    expect(typeof fields["durationMs"]).toBe("number");
    expect(JSON.stringify(lines)).not.toContain("secret-value");
  });

  test("levels: 403 is warn, 404 info, a thrown error 500 error", async () => {
    const logs = captureLogs();
    await app.handle(new Request("http://localhost/denied"));
    await app.handle(new Request("http://localhost/missing"));
    const boom = await app.handle(new Request("http://localhost/boom"));
    expect(boom.status).toBe(500);
    const statusOf = (calls: unknown[][]) =>
      calls.filter(([m]) => m === "HTTP request").map((call) => fieldsOf(call)["status"]);
    expect(statusOf(logs.warn)).toEqual([403]);
    expect(statusOf(logs.info)).toEqual([404]);
    expect(statusOf(logs.error)).toEqual([500]);
  });
});

describe("requestLogPath", () => {
  test("drops the query string and masks token-like segments", () => {
    expect(requestLogPath("http://x/dashboard/setup?token=abc")).toBe("/dashboard/setup");
    expect(requestLogPath(`http://x/reveal/${"a".repeat(43)}/view`)).toBe(
      "/reveal/:token/view",
    );
    expect(requestLogPath("http://x/api/v1/emails/msg_123")).toBe(
      "/api/v1/emails/msg_123",
    );
  });
});

describe("requestLogLevel", () => {
  test("maps statuses and quiet paths", () => {
    expect(requestLogLevel(200, "/api/v1/emails")).toBe("info");
    expect(requestLogLevel(404, "/x")).toBe("info");
    expect(requestLogLevel(401, "/x")).toBe("warn");
    expect(requestLogLevel(403, "/x")).toBe("warn");
    expect(requestLogLevel(429, "/x")).toBe("warn");
    expect(requestLogLevel(500, "/x")).toBe("error");
    expect(requestLogLevel(200, "/health")).toBe("debug");
    expect(requestLogLevel(503, "/health")).toBe("error");
  });
});
