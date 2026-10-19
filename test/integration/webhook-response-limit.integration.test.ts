/**
 * Webhook receivers are untrusted: their responses must not be able to
 * exhaust the worker's memory, and an attempt that crashes the process
 * must still count toward the retry limit.
 *
 * Responses come from a local receiver process and are fetched with the
 * real `fetch` (so real streaming and decompression), routed through the
 * `fetchImpl` hook: the URL under test stays a public IP literal, which
 * the SSRF guard accepts without DNS.
 */
import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  claimDueDeliveries,
  MAX_DELIVERY_ATTEMPTS,
  performHttpAttempt,
} from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { truncateAll, seed, db, enqueueDelivery } from "./_helpers.ts";

/**
 * The hostile receiver runs in its own process, like a real one: a server
 * in the test process would share its event loop with the client. Bodies
 * are endless, throttled to about 64 MB/s so that running these tests
 * against an unbounded reader fails on time instead of exhausting memory.
 * `/accept-encoding` echoes the request's Accept-Encoding header.
 */
const SERVER_SOURCE = `
/** 64 KB of 'a': endless bodies are text, as previews strip NUL bytes. */
const CHUNK = new Uint8Array(64 * 1024).fill(97);
/** 256 MB of zeros, gzipped to about 250 KB: a classic decompression bomb. */
const BOMB = Bun.gzipSync(new Uint8Array(256 * 1024 * 1024));
const endless = () => new ReadableStream({
  async pull(controller) { controller.enqueue(CHUNK); await Bun.sleep(1); },
});
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/endless") return new Response(endless());
    if (path === "/endless-gzip") {
      return new Response(endless().pipeThrough(new CompressionStream("gzip")), {
        headers: { "content-encoding": "gzip" },
      });
    }
    if (path === "/bomb") return new Response(BOMB, { headers: { "content-encoding": "gzip" } });
    if (path === "/accept-encoding") return new Response(req.headers.get("accept-encoding") ?? "");
    return new Response("ok");
  },
});
process.stdout.write("PORT " + server.port + "\\n");
`;

const serverProcess = Bun.spawn([process.execPath, "-e", SERVER_SOURCE], {
  stdout: "pipe",
});

/** Waits for the subprocess to print its port. */
async function readPort(): Promise<number> {
  const reader = serverProcess.stdout.getReader();
  let text = "";
  while (!/PORT \d+\n/.test(text)) {
    const { done, value } = await reader.read();
    if (done) throw new Error("receiver process exited before listening");
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return Number(/PORT (\d+)/.exec(text)?.[1]);
}

const port = await readPort();

afterAll(() => {
  serverProcess.kill();
});

/** Real fetch, sent to the receiver's `path` whatever URL is asked for. */
function localFetch(path: string): typeof fetch {
  return Object.assign(
    (_input: string | URL | Request, init?: RequestInit) =>
      fetch(`http://127.0.0.1:${port}${path}`, init),
    { preconnect: fetch.preconnect },
  );
}

function attempt(path: string) {
  return performHttpAttempt({
    url: "https://93.184.216.34/hook",
    secret: "test-secret",
    body: "{}",
    event: "email.sent",
    fetchImpl: localFetch(path),
    timeoutMs: 5_000,
  });
}

describe("webhook response reading is bounded", () => {
  test("an endless body is cut off at the preview size", async () => {
    const start = performance.now();
    const outcome = await attempt("/endless");

    expect(performance.now() - start).toBeLessThan(2_000);
    expect(outcome.status).toBe(200);
    expect(outcome.bodyPreview).toHaveLength(2048);
  });

  test("an endless compressed body is never decompressed", async () => {
    const start = performance.now();
    const outcome = await attempt("/endless-gzip");

    expect(performance.now() - start).toBeLessThan(2_000);
    expect(outcome.bodyPreview).toBe("[gzip-encoded response body not shown]");
  });

  test("a gzip bomb does not inflate in the worker's memory", async () => {
    /** Bun inflates compressed bodies in native code whatever JavaScript
     *  reads, so this only stays flat if the body is never decompressed. */
    const before = process.memoryUsage().rss;
    let peak = before;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 5);
    try {
      const outcome = await attempt("/bomb");
      await Bun.sleep(200);
      expect(outcome.bodyPreview).toBe("[gzip-encoded response body not shown]");
    } finally {
      clearInterval(sampler);
    }
    peak = Math.max(peak, process.memoryUsage().rss);
    /** Inflating would add over 256 MB; allow plenty of noise below that. */
    expect(peak - before).toBeLessThan(100 * 1024 * 1024);
  });

  test("asks the receiver not to compress", async () => {
    expect((await attempt("/accept-encoding")).bodyPreview).toBe("identity");
  });

  test("a small body is captured in full", async () => {
    expect((await attempt("/small")).bodyPreview).toBe("ok");
  });
});

describe("attempts are counted when claimed", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  /** Makes every pending row due again, as if its claim lock expired. */
  async function expireLocks(): Promise<void> {
    await db
      .update(webhookDeliveries)
      .set({ nextAttemptAt: sql`NOW() - interval '1 second'` })
      .where(eq(webhookDeliveries.status, "pending"));
  }

  test("a delivery whose attempts never finish (process crash) ends at failed", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: webhookId } = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.sent"],
    });
    const { id } = await enqueueDelivery({
      webhookId,
      envelope: { event: "email.sent", timestamp: "2026-05-10T12:00:00.000Z", data: {} },
    });

    /** Claim and "crash" (never call recordAttempt), as many times as allowed. */
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) {
      const claimed = await claimDueDeliveries(10);
      expect(claimed.map((r) => r.id)).toEqual([id]);
      /** The worker sees the count from before this attempt. */
      expect(claimed[0]!.attempts).toBe(i);
      await expireLocks();
    }

    /** The next claim finds the limit exceeded and stops retrying. */
    expect(await claimDueDeliveries(10)).toEqual([]);
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id));
    expect(row?.status).toBe("failed");
    expect(row?.attempts).toBe(MAX_DELIVERY_ATTEMPTS);
    expect(row?.lastError).toContain("interrupted");
  });
});
