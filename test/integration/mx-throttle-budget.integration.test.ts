/**
 * Provider buckets and the rate budget (#250), end to end: the real mailer
 * and queue against real receiving servers (`test/smtp-fixture.ts`, run
 * under Node) and a real Postgres. No real DNS: the MX route seam
 * (`setMxRouteDeps`) answers every lookup and points every MX host at
 * 127.0.0.1 (allowed here with `MAIL_ALLOW_PRIVATE_MX`), on the port of a
 * fixture server. The rate budget runs on a clock the test moves.
 */
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { setMxRouteDeps } from "../../src/modules/emails/services/mx-route.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import {
  createRateBudget,
  setMxRateBudget,
  type RateBudget,
} from "../../src/modules/emails/services/rate-budget.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import type { DeliveryState } from "../../src/modules/emails/models/email.schema.ts";
import { config } from "../../src/config.ts";
import { _inspectLock } from "../../src/utils/mx-throttle.ts";
import {
  startFixtureServer,
  type FixtureMode,
  type FixtureServer,
} from "../smtp-fixture.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

const running: FixtureServer[] = [];
const saved = {
  allowPrivateMx: config.mail.allowPrivateMx,
  mxConcurrency: config.mail.mxConcurrency,
};

beforeAll(() => {
  Object.assign(config.mail, { allowPrivateMx: true, mxConcurrency: 1 });
});

afterEach(() => {
  setMxRouteDeps(null);
  setMxRateBudget(null);
});

afterAll(() => {
  Object.assign(config.mail, saved);
  for (const server of running) server.stop();
});

async function startServer(mode: FixtureMode): Promise<FixtureServer> {
  const server = await startFixtureServer(mode);
  running.push(server);
  return server;
}

/** A DNS error with its `code`, as `dns/promises` rejects. */
function dnsError(code: string): Error {
  return Object.assign(new Error(`query ${code}`), { code });
}

/**
 * Routes each recipient domain of `mxByDomain` to its one MX host, every
 * MX host to 127.0.0.1 on `port`, and anything else to NXDOMAIN.
 */
function route(mxByDomain: Record<string, string>, port: number): void {
  setMxRouteDeps({
    resolveMx: async (domain) => {
      const exchange = mxByDomain[domain];
      if (exchange === undefined) throw dnsError("ENOTFOUND");
      return [{ exchange, priority: 10 }];
    },
    resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
    lookup: async () => [{ address: "127.0.0.1" }],
    smtpPort: () => port,
  });
}

/** A clock the test moves by hand, for the rate budget. */
function fakeClock() {
  let at = 1_000_000;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe("provider buckets", () => {
  test("two MX hosts of one bucket share one lock: their sessions never overlap", async () => {
    /** Answers the end of DATA after 300 ms: overlapping sessions would show in `peak`. */
    const server = await startServer("slow");
    route({ "a.test": "mx1.bucket.test", "b.test": "mx2.bucket.test" }, server.port);

    let sawWaiter = false;
    const watching = setInterval(() => {
      if ((_inspectLock("bucket.test")?.waiting ?? 0) > 0) sawWaiter = true;
    }, 5);
    const results = await Promise.all(
      ["user@a.test", "user@b.test"].map((to) =>
        sendMail({
          from: "hello@example.com",
          to,
          subject: "bucket",
          text: "hello",
          messageId: `<${crypto.randomUUID()}@bunmail.example.test>`,
        }),
      ),
    );
    clearInterval(watching);

    expect(results[0]?.deliveryState["a.test"]).toMatchObject({
      status: "sent",
      mxHost: "mx1.bucket.test",
    });
    expect(results[1]?.deliveryState["b.test"]).toMatchObject({
      status: "sent",
      mxHost: "mx2.bucket.test",
    });
    expect(server.messages()).toBe(2);
    /** One session at a time across both host names (`MAIL_MX_CONCURRENCY=1`). */
    expect(server.peak()).toBe(1);
    expect(sawWaiter).toBe(true);
    expect(_inspectLock("mx1.bucket.test")).toBeUndefined();
  });
});

describe("rate budget through the queue", () => {
  let apiKeyId = "";
  let webhookId = "";
  let clock = fakeClock();
  let budget: RateBudget = createRateBudget(1, clock.now);

  beforeEach(async () => {
    await truncateAll();
    apiKeyId = (await seed.apiKey()).id;
    webhookId = (
      await seed.webhook({
        apiKeyId,
        url: "https://hooks.example.com/bunmail",
        events: ["email.sent", "email.bounced", "email.failed"],
      })
    ).id;
    /** `MAIL_MX_RATE_PER_MIN=1`, on the test's clock. */
    clock = fakeClock();
    budget = createRateBudget(1, clock.now);
    setMxRateBudget(budget);
  });

  /** One queue cycle with the real mailer and plain envelopes (no return paths). */
  function queueCycle(): Promise<void> {
    return runQueueCycle({ sendMail, signedReturnPath: async () => false });
  }

  async function row(emailId: string) {
    const [found] = await db.select().from(emails).where(eq(emails.id, emailId));
    if (!found) throw new Error("email row missing");
    return found;
  }

  /** Seconds from now (database clock) to the row's `next_attempt_at`. */
  async function dueInSeconds(emailId: string): Promise<number> {
    const [found] = await db
      .select({
        seconds:
          sql<number>`extract(epoch from (${emails.nextAttemptAt} - NOW()))::float8`.mapWith(
            Number,
          ),
      })
      .from(emails)
      .where(eq(emails.id, emailId));
    if (!found) throw new Error("email row missing");
    return found.seconds;
  }

  /** Makes a requeued email due now, so the next cycle takes it. */
  async function dueNow(emailId: string): Promise<void> {
    await db
      .update(emails)
      .set({ nextAttemptAt: sql`NOW()` })
      .where(eq(emails.id, emailId));
  }

  /** The `data` of every event enqueued for the test webhook, by event. */
  async function events(event?: string): Promise<Record<string, unknown>[]> {
    const rows = await db
      .select({ payload: webhookDeliveries.payload })
      .from(webhookDeliveries)
      .where(
        event === undefined
          ? eq(webhookDeliveries.webhookId, webhookId)
          : and(
              eq(webhookDeliveries.event, event),
              eq(webhookDeliveries.webhookId, webhookId),
            ),
      );
    return rows.map((r) => {
      const parsed: unknown = JSON.parse(r.payload);
      const data: unknown =
        typeof parsed === "object" && parsed !== null
          ? Reflect.get(parsed, "data")
          : null;
      return typeof data === "object" && data !== null
        ? Object.fromEntries(Object.entries(data))
        : {};
    });
  }

  function stateOf(state: DeliveryState | null): DeliveryState {
    if (state === null) throw new Error("no delivery state");
    return state;
  }

  test("a second email to the same bucket within the minute is deferred, then sent after the wait", async () => {
    const server = await startServer("plaintext");
    route({ "a.test": "mx1.bucket.test", "b.test": "mx2.bucket.test" }, server.port);
    const first = await seed.email({ apiKeyId, toAddress: "user@a.test" });
    await queueCycle();
    expect((await row(first.id)).status).toBe("sent");

    const second = await seed.email({ apiKeyId, toAddress: "user@b.test" });
    await queueCycle();
    const deferred = await row(second.id);
    expect(deferred.status).toBe("queued");
    /** Not an attempt: the claim's increment was undone. */
    expect(deferred.attempts).toBe(0);
    expect(deferred.lastError).toBeNull();
    expect(deferred.lockedBy).toBeNull();
    /** The group was not touched: no attempt, no error. */
    expect(stateOf(deferred.deliveryState)["b.test"]).toEqual({
      status: "retry",
      recipients: ["user@b.test"],
      attempts: 0,
      domain: "b.test",
    });
    /** A token in 60 s (1 a minute), plus at most 10% jitter. */
    const wait = await dueInSeconds(second.id);
    expect(wait).toBeGreaterThan(55);
    expect(wait).toBeLessThan(70);
    expect(server.messages()).toBe(1);
    /** No failure, and no webhook event of any kind for the deferred email. */
    expect(await events("email.failed")).toHaveLength(0);
    expect((await events()).filter((e) => e["emailId"] === second.id)).toHaveLength(0);

    /** Not due yet: the next cycle leaves it alone. */
    await queueCycle();
    expect((await row(second.id)).attempts).toBe(0);

    /** A minute later the bucket has a token again. */
    clock.advance(60_000);
    await dueNow(second.id);
    await queueCycle();
    const sent = await row(second.id);
    expect(sent.status).toBe("sent");
    expect(sent.attempts).toBe(1);
    expect(stateOf(sent.deliveryState)["b.test"]).toMatchObject({
      status: "sent",
      attempts: 1,
      mxHost: "mx2.bucket.test",
    });
    expect(server.messages()).toBe(2);
    const sentEvents = await events("email.sent");
    expect(sentEvents).toHaveLength(2);
    expect(new Set(sentEvents.map((e) => e["emailId"]))).toEqual(
      new Set([first.id, second.id]),
    );
  });

  test("two recipient domains, one bucket limited: the other is delivered at once", async () => {
    const server = await startServer("plaintext");
    route(
      { "limited.test": "mx.limited.test", "free.test": "mx.free.test" },
      server.port,
    );
    /** Spend the limited bucket's only token. */
    expect(budget.take("limited.test", 1).granted).toBe(1);

    const { id } = await seed.email({
      apiKeyId,
      toAddress: "a@limited.test",
      cc: "b@free.test",
    });
    await queueCycle();
    const afterFirst = await row(id);
    expect(afterFirst.status).toBe("queued");
    expect(afterFirst.lastError).toContain(
      "limited.test (1 rcpt): deferred by the provider rate budget",
    );
    const state = stateOf(afterFirst.deliveryState);
    expect(state["free.test"]).toMatchObject({
      status: "sent",
      attempts: 1,
      mxHost: "mx.free.test",
    });
    expect(state["limited.test"]).toEqual({
      status: "retry",
      recipients: ["a@limited.test"],
      attempts: 0,
      domain: "limited.test",
    });
    expect(server.messages()).toBe(1);
    const wait = await dueInSeconds(id);
    expect(wait).toBeGreaterThan(55);
    expect(wait).toBeLessThan(70);
    expect(await events("email.sent")).toHaveLength(1);
    expect(await events("email.failed")).toHaveLength(0);

    clock.advance(60_000);
    await dueNow(id);
    await queueCycle();
    const done = await row(id);
    expect(done.status).toBe("sent");
    expect(stateOf(done.deliveryState)["limited.test"]).toMatchObject({
      status: "sent",
      attempts: 1,
    });
    expect(server.messages()).toBe(2);
    /** `email.sent` fired once, on the attempt that landed the first group. */
    expect(await events("email.sent")).toHaveLength(1);
  });

  test("a deferral past the retry window ends the email like a retry would", async () => {
    const server = await startServer("plaintext");
    route({ "limited.test": "mx.limited.test" }, server.port);
    expect(budget.take("limited.test", 1).granted).toBe(1);
    const { id } = await seed.email({ apiKeyId, toAddress: "a@limited.test" });
    /** Queued long enough ago that a minute's wait lands past the window. */
    await db
      .update(emails)
      .set({
        createdAt: sql`NOW() - interval ${sql.raw(`'${config.mail.retryMaxAgeHours} hours'`)} + interval '30 seconds'`,
      })
      .where(eq(emails.id, id));

    await queueCycle();
    const failed = await row(id);
    expect(failed.status).toBe("failed");
    expect(stateOf(failed.deliveryState)["limited.test"]).toMatchObject({
      status: "failed",
      lastError:
        "Not sent within the retry window: provider rate budget (MAIL_MX_RATE_PER_MIN)",
    });
    expect(server.messages()).toBe(0);
    expect(await events("email.failed")).toHaveLength(1);
  });
});
