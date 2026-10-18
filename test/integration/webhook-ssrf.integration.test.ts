/**
 * Integration tests for the webhook SSRF guard (#128) against a real
 * Postgres + real config. Uses literal IPs (no DNS) so it's deterministic.
 * Covers: rejection at create, and re-validation (+ no fetch, + manual
 * redirect) at delivery time, and that the request is sent to the address
 * that was validated (one resolution, pinned connection).
 */

import { describe, test, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createWebhook } from "../../src/modules/webhooks/services/webhook.service.ts";
import { performHttpAttempt } from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { BlockedUrlError, type ResolveAll } from "../../src/utils/ssrf-guard.ts";
import { truncateAll, seed, db } from "./_helpers.ts";
import { webhooks } from "../../src/modules/webhooks/models/webhook.schema.ts";

beforeEach(async () => {
  await truncateAll();
});

describe("createWebhook: SSRF guard", () => {
  test("rejects cloud-metadata / private / loopback URLs (nothing stored)", async () => {
    const { id: apiKeyId } = await seed.apiKey({ isAdmin: true });

    for (const url of [
      "http://169.254.169.254/latest/meta-data/",
      "https://10.0.0.5/hook",
      "https://127.0.0.1/hook",
    ]) {
      expect(
        createWebhook({ url, events: ["email.sent"] }, apiKeyId),
      ).rejects.toBeInstanceOf(BlockedUrlError);
    }

    const rows = await db.select().from(webhooks).where(eq(webhooks.apiKeyId, apiKeyId));
    expect(rows).toHaveLength(0);
  });

  test("rejects http when insecure http isn't opted in (default)", async () => {
    const { id: apiKeyId } = await seed.apiKey({ isAdmin: true });
    expect(
      createWebhook({ url: "http://1.1.1.1/hook", events: ["email.sent"] }, apiKeyId),
    ).rejects.toThrow(/https/);
  });

  test("accepts a public https URL", async () => {
    const { id: apiKeyId } = await seed.apiKey({ isAdmin: true });
    const { webhook } = await createWebhook(
      { url: "https://1.1.1.1/hook", events: ["email.sent"] },
      apiKeyId,
    );
    expect(webhook.url).toBe("https://1.1.1.1/hook");
  });
});

describe("performHttpAttempt: delivery-time re-validation", () => {
  const base = { secret: "s", body: "{}", event: "email.sent" };

  test("does NOT fetch a blocked URL; returns a failed outcome", async () => {
    let fetchCalled = false;
    const spyFetch = Object.assign(
      () => {
        fetchCalled = true;
        throw new Error("fetch must not be called for a blocked URL");
      },
      { preconnect: fetch.preconnect },
    );

    const outcome = await performHttpAttempt({
      ...base,
      url: "http://169.254.169.254/latest/meta-data/",
      fetchImpl: spyFetch,
    });

    expect(fetchCalled).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/private|reserved|https/i);
  });

  test("fetches an allowed URL with redirect:'manual'", async () => {
    let seenInit: RequestInit | undefined;
    const stubFetch = Object.assign(
      (_url: string | URL | Request, init?: RequestInit) => {
        seenInit = init;
        return Promise.resolve(
          new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
        );
      },
      { preconnect: fetch.preconnect },
    );

    const outcome = await performHttpAttempt({
      ...base,
      url: "https://1.1.1.1/hook",
      fetchImpl: stubFetch,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe(200);
    expect(seenInit?.redirect).toBe("manual");
  });
});

/** What one `fetch` call received. */
interface FetchCall {
  url: string;
  init: BunFetchRequestInit | undefined;
}

/** A fetch stub that records its arguments and answers 200. */
function recordingFetch(calls: FetchCall[]): typeof fetch {
  return Object.assign(
    (input: string | URL | Request, init?: BunFetchRequestInit) => {
      calls.push({ url: input instanceof Request ? input.url : String(input), init });
      return Promise.resolve(new Response("ok", { status: 200 }));
    },
    { preconnect: fetch.preconnect },
  );
}

/**
 * A resolver whose answer changes after the first call: public first,
 * loopback on every later call (what a short-TTL record could do).
 */
function rebindingResolver(): { resolve: ResolveAll; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve: (host) => {
      calls.push(host);
      const address = calls.length === 1 ? "93.184.216.34" : "127.0.0.1";
      return Promise.resolve([{ address }]);
    },
  };
}

/** The request headers a recorded call carried. */
function headersOf(call: FetchCall | undefined): Headers {
  return new Headers(call?.init?.headers);
}

describe("performHttpAttempt: connects to the validated address", () => {
  const base = { secret: "s", body: "{}", event: "email.sent" };

  test("resolves once; fetch gets the validated IP, the original Host and SNI", async () => {
    const resolver = rebindingResolver();
    const calls: FetchCall[] = [];

    const outcome = await performHttpAttempt({
      ...base,
      url: "https://hook.example.test/path?q=1",
      resolver: resolver.resolve,
      fetchImpl: recordingFetch(calls),
    });

    expect(outcome.ok).toBe(true);
    expect(resolver.calls).toEqual(["hook.example.test"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://93.184.216.34/path?q=1");
    expect(calls[0]?.url).not.toContain("hook.example.test");
    expect(headersOf(calls[0]).get("host")).toBe("hook.example.test");
    expect(calls[0]?.init?.tls).toEqual({ serverName: "hook.example.test" });
    expect(calls[0]?.init?.redirect).toBe("manual");
    expect(calls[0]?.init?.keepalive).toBe(false);
  });

  test("each attempt resolves afresh, and a private answer means no fetch", async () => {
    const resolver = rebindingResolver();
    const calls: FetchCall[] = [];
    const attempt = (): ReturnType<typeof performHttpAttempt> =>
      performHttpAttempt({
        ...base,
        url: "https://hook.example.test/",
        resolver: resolver.resolve,
        fetchImpl: recordingFetch(calls),
      });

    expect((await attempt()).ok).toBe(true);
    const second = await attempt();
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/private|reserved/);
    expect(second.error).not.toContain("127.0.0.1");
    expect(resolver.calls).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual(["https://93.184.216.34/"]);
  });

  test("a scoped (zone id) answer is a failed attempt; fetch is never called", async () => {
    const calls: FetchCall[] = [];
    const resolve: ResolveAll = () =>
      Promise.resolve([{ address: "2606:4700:4700::1111%eth0" }]);

    const outcome = await performHttpAttempt({
      ...base,
      url: "https://hook.example.test/",
      resolver: resolve,
      fetchImpl: recordingFetch(calls),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatch(/private|reserved/);
    expect(calls).toHaveLength(0);
  });

  test("keeps a non-default port in the URL and the Host header", async () => {
    const calls: FetchCall[] = [];
    const resolve: ResolveAll = () => Promise.resolve([{ address: "93.184.216.34" }]);

    await performHttpAttempt({
      ...base,
      url: "https://hook.example.test:8443/h",
      resolver: resolve,
      fetchImpl: recordingFetch(calls),
    });
    expect(calls[0]?.url).toBe("https://93.184.216.34:8443/h");
    expect(headersOf(calls[0]).get("host")).toBe("hook.example.test:8443");
  });
});

/**
 * The same request, through Bun's real fetch, against a local TLS server
 * that presents the TEST-ONLY certificate for `hook.example.test`
 * (`test/fixtures/tls/`). The guard validates the public answer; the
 * fetch stub only swaps the validated public IP for the local server and
 * adds the fixture as a trusted CA, passing every other option through.
 */
describe("performHttpAttempt: pinned TLS request against a local server", () => {
  const base = { secret: "s", body: "{}", event: "email.sent" };
  const fixtures = join(import.meta.dir, "..", "fixtures", "tls");
  const seenHosts: Array<string | null> = [];
  let cert = "";
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    const key = await Bun.file(join(fixtures, "hook.example.test.key.pem")).text();
    cert = await Bun.file(join(fixtures, "hook.example.test.cert.pem")).text();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { key, cert },
      fetch(req) {
        seenHosts.push(req.headers.get("host"));
        return new Response("received");
      },
    });
  });
  afterAll(async () => {
    await server.stop(true);
  });

  /** Real fetch, sent to the local server instead of the pinned address. */
  const toLocal: typeof fetch = Object.assign(
    (input: string | URL | Request, init?: BunFetchRequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.hostname).toBe("93.184.216.34");
      url.hostname = "127.0.0.1";
      url.port = String(server.port);
      return fetch(url, { ...init, tls: { ...init?.tls, ca: cert } });
    },
    { preconnect: fetch.preconnect },
  );
  const resolve: ResolveAll = () => Promise.resolve([{ address: "93.184.216.34" }]);

  test("matching host name: delivered, receiver sees the original Host", async () => {
    seenHosts.length = 0;
    const outcome = await performHttpAttempt({
      ...base,
      url: "https://hook.example.test/hook",
      resolver: resolve,
      fetchImpl: toLocal,
    });
    expect(outcome).toMatchObject({ ok: true, status: 200, bodyPreview: "received" });
    expect(seenHosts).toEqual(["hook.example.test"]);
  });

  test("certificate for another name: refused before anything is sent", async () => {
    seenHosts.length = 0;
    const outcome = await performHttpAttempt({
      ...base,
      url: "https://other.example.test/hook",
      resolver: resolve,
      fetchImpl: toLocal,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBeNull();
    expect(outcome.bodyPreview).toBeNull();
    expect(seenHosts).toEqual([]);
  });
});
