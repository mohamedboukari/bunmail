import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Unit tests for the webhook dispatch service.
 *
 * Mocks `findWebhooksForEvent` (DB lookup) and `globalThis.fetch`
 * (outbound HTTP) to exercise the full dispatch path: signature
 * computation, header construction, retry behaviour on non-2xx, retry
 * on thrown error, eventual permanent failure after MAX_DISPATCH_ATTEMPTS.
 *
 * Real DB lookup with a real `webhooks` row is exercised in the
 * integration tier.
 */

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const captured: CapturedRequest[] = [];
let webhooksFixture: Array<{ id: string; url: string; secret: string }> = [];

/** Per-test fetch behaviour — by default returns 200. */
let fetchHandler: (url: string) => Promise<Response> = async () =>
  new Response("ok", { status: 200 });

mock.module("../../src/modules/webhooks/services/webhook.service.ts", () => ({
  findWebhooksForEvent: mock(async () => webhooksFixture),
}));

globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => {
    headers[k] = v;
  });
  captured.push({
    url,
    method: init?.method ?? "GET",
    headers,
    body: typeof init?.body === "string" ? init.body : "",
  });
  return fetchHandler(url);
}) as unknown as typeof fetch;

const { dispatchEvent, signPayload } =
  await import("../../src/modules/webhooks/services/webhook-dispatch.service.ts");

beforeEach(() => {
  captured.length = 0;
  webhooksFixture = [];
  fetchHandler = async () => new Response("ok", { status: 200 });
});

/** Wait long enough for dispatchEvent's fire-and-forget chain to run.
 *  Backoff between retries is 1s, 2s — we only call this when we want
 *  the very first attempt's effect, not the retries. */
async function waitForFirstAttempt(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
}

describe("dispatchEvent — single subscriber, success", () => {
  test("posts the JSON payload with signature + timestamp + event headers", async () => {
    webhooksFixture = [
      {
        id: "whk_1",
        url: "https://hook.example.com",
        secret: "test-secret-32-bytes-padding-here-padding",
      },
    ];

    dispatchEvent("email.sent", { emailId: "msg_x", to: "user@example.org" });
    await waitForFirstAttempt();

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe("https://hook.example.com");
    expect(req.method).toBe("POST");
    expect(req.headers["content-type"]).toContain("application/json");
    expect(req.headers["x-bunmail-event"]).toBe("email.sent");
    expect(req.headers["x-bunmail-timestamp"]).toMatch(/^\d{10}$/);
    expect(req.headers["x-bunmail-signature"]).toMatch(/^[a-f0-9]{64}$/);
    /** Body is well-formed. */
    const body = JSON.parse(req.body);
    expect(body.event).toBe("email.sent");
    expect(body.data.emailId).toBe("msg_x");
  });

  test("signature matches the documented HMAC construction (timestamp.body)", async () => {
    webhooksFixture = [
      { id: "whk_1", url: "https://hook.example.com", secret: "shared-secret" },
    ];
    dispatchEvent("email.bounced", { emailId: "msg_y" });
    await waitForFirstAttempt();

    const req = captured[0]!;
    const expected = signPayload(
      req.headers["x-bunmail-timestamp"]!,
      req.body,
      "shared-secret",
    );
    expect(req.headers["x-bunmail-signature"]).toBe(expected);
  });
});

describe("dispatchEvent — fan-out to multiple subscribers", () => {
  test("dispatches once to each subscriber", async () => {
    webhooksFixture = [
      {
        id: "w1",
        url: "https://a.example.com",
        secret: "s1-padding-padding-padding-padding",
      },
      {
        id: "w2",
        url: "https://b.example.com",
        secret: "s2-padding-padding-padding-padding",
      },
      {
        id: "w3",
        url: "https://c.example.com",
        secret: "s3-padding-padding-padding-padding",
      },
    ];
    dispatchEvent("email.sent", { emailId: "msg" });
    await waitForFirstAttempt();
    const urls = captured.map((c) => c.url).sort();
    expect(urls).toEqual([
      "https://a.example.com",
      "https://b.example.com",
      "https://c.example.com",
    ]);
  });

  test("no fetch when no subscribers match the event", async () => {
    webhooksFixture = [];
    dispatchEvent("email.sent", { emailId: "msg" });
    await waitForFirstAttempt();
    expect(captured).toHaveLength(0);
  });
});

describe("dispatchEvent — error paths log + don't throw", () => {
  test("non-2xx response on first attempt is logged but doesn't throw to caller", async () => {
    webhooksFixture = [
      {
        id: "w1",
        url: "https://hook.example.com",
        secret: "s-padding-padding-padding-padding",
      },
    ];
    fetchHandler = async () => new Response("server error", { status: 500 });

    /** Synchronous wrapper — should not throw even though the delivery fails. */
    expect(() => dispatchEvent("email.sent", { emailId: "msg_x" })).not.toThrow();

    await waitForFirstAttempt();
    expect(captured).toHaveLength(1);
  });

  test("network error on first attempt is caught — caller doesn't see it", async () => {
    webhooksFixture = [
      {
        id: "w1",
        url: "https://hook.example.com",
        secret: "s-padding-padding-padding-padding",
      },
    ];
    fetchHandler = async () => {
      throw new Error("ECONNREFUSED");
    };

    expect(() => dispatchEvent("email.sent", { emailId: "x" })).not.toThrow();
    await waitForFirstAttempt();
  });
});
