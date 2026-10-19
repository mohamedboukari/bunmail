/**
 * MX resolution, failover and per-recipient RCPT outcomes (#250), end to
 * end: the real mailer and queue against real receiving servers
 * (`test/smtp-fixture.ts`, run under Node) and a real Postgres. No real
 * DNS: the MX route seam (`setMxRouteDeps`) answers every lookup, points
 * every MX host at 127.0.0.1 (allowed here with `MAIL_ALLOW_PRIVATE_MX`)
 * and gives each host the port of its fixture server.
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
import { createServer } from "node:net";
import { and, eq, sql } from "drizzle-orm";
import { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import { setMxRouteDeps } from "../../src/modules/emails/services/mx-route.ts";
import { runQueueCycle } from "../../src/modules/emails/services/queue.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import type { DeliveryState } from "../../src/modules/emails/models/email.schema.ts";
import { config } from "../../src/config.ts";
import {
  startFixtureServer,
  type FixtureMode,
  type FixtureServer,
} from "../smtp-fixture.ts";
import { truncateAll, seed, db, emails, suppressions } from "./_helpers.ts";

const running: FixtureServer[] = [];
const savedAllowPrivate = config.mail.allowPrivateMx;

/** A local port nothing listens on: bound, then released. */
let closedPort = 0;

beforeAll(async () => {
  Object.assign(config.mail, { allowPrivateMx: true });
  const probe = createServer();
  closedPort = await new Promise<number>((resolve) => {
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
});

afterEach(() => {
  setMxRouteDeps(null);
});

afterAll(() => {
  Object.assign(config.mail, { allowPrivateMx: savedAllowPrivate });
  for (const server of running) server.stop();
});

async function startServer(mode: FixtureMode): Promise<FixtureServer> {
  const server = await startFixtureServer(mode);
  running.push(server);
  return server;
}

/** A DNS error with its `code`, as `dns/promises` rejects. */
function dnsError(code: string): Error {
  return Object.assign(new Error(`queryMx ${code}`), { code });
}

/**
 * Routes `example.org` to `mx1.example.test` (preference 10) then
 * `mx2.example.test` (20), each MX host to 127.0.0.1 on the port given
 * (a closed port when none), and every other lookup to NXDOMAIN.
 */
function routeExampleOrg(ports: { mx1?: number; mx2?: number }): void {
  const portOf: Record<string, number | undefined> = {
    "mx1.example.test": ports.mx1,
    "mx2.example.test": ports.mx2,
  };
  setMxRouteDeps({
    resolveMx: async (domain) => {
      if (domain !== "example.org") throw dnsError("ENOTFOUND");
      return [
        { exchange: "mx2.example.test", priority: 20 },
        { exchange: "mx1.example.test", priority: 10 },
      ];
    },
    resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
    resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
    lookup: async () => [{ address: "127.0.0.1" }],
    smtpPort: (mxHost) => portOf[mxHost] ?? closedPort,
  });
}

/** One send of a fixed message, straight through the mailer. */
function send(to: string) {
  return sendMail({
    from: "hello@example.com",
    to,
    subject: "failover",
    text: "hello",
    messageId: `<${crypto.randomUUID()}@bunmail.example.test>`,
  });
}

describe("MX failover against real receiving servers", () => {
  test("the first MX refuses the connection: the second one delivers", async () => {
    const mx2 = await startServer("starttls");
    routeExampleOrg({ mx2: mx2.port });
    const result = await send("user@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "sent",
      mxHost: "mx2.example.test",
      tls: "starttls",
      attempts: 1,
    });
    expect(mx2.messages()).toBe(1);
  });

  test("the first MX greets with 421: the second one delivers", async () => {
    const mx1 = await startServer("busy");
    const mx2 = await startServer("plaintext");
    routeExampleOrg({ mx1: mx1.port, mx2: mx2.port });
    const result = await send("user@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "sent",
      mxHost: "mx2.example.test",
    });
    expect(mx1.connections()).toBe(1);
    expect(mx1.messages()).toBe(0);
    expect(mx2.messages()).toBe(1);
  });

  test("the first MX answers 550 at RCPT: no failover, the recipient fails", async () => {
    const mx1 = await startServer("rcpt-codes");
    const mx2 = await startServer("starttls");
    routeExampleOrg({ mx1: mx1.port, mx2: mx2.port });
    const result = await send("hard@example.org");
    expect(result.deliveryState["example.org"]).toMatchObject({
      status: "failed",
      failureKind: "hard",
      failureCode: "5.1.1",
      mxHost: "mx1.example.test",
    });
    expect(mx2.connections()).toBe(0);
  });
});

describe("MX resolution and RCPT outcomes through the queue", () => {
  let apiKeyId = "";
  let webhookId = "";

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

  /** Makes a requeued email due now, so the next cycle takes it. */
  async function dueNow(emailId: string): Promise<void> {
    await db
      .update(emails)
      .set({ nextAttemptAt: sql`NOW()` })
      .where(eq(emails.id, emailId));
  }

  /** The `data` of every event of `event` enqueued for the test webhook. */
  async function events(event: string): Promise<Record<string, unknown>[]> {
    const rows = await db
      .select({ payload: webhookDeliveries.payload })
      .from(webhookDeliveries)
      .where(
        and(
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

  test("a SERVFAIL retries the email instead of failing it, and resolves again next time", async () => {
    let servfail = true;
    const mx = await startServer("starttls");
    setMxRouteDeps({
      resolveMx: async () => {
        if (servfail) throw dnsError("ESERVFAIL");
        return [{ exchange: "mx.flaky.test", priority: 10 }];
      },
      lookup: async () => [{ address: "127.0.0.1" }],
      smtpPort: () => mx.port,
    });
    const { id } = await seed.email({ apiKeyId, toAddress: "user@flaky.test" });

    await queueCycle();
    const first = await row(id);
    expect(first.status).toBe("queued");
    expect(stateOf(first.deliveryState)["flaky.test"]).toMatchObject({
      status: "retry",
      lastError: "flaky.test: MX lookup failed temporarily (ESERVFAIL); will retry",
    });
    expect(await events("email.failed")).toHaveLength(0);

    servfail = false;
    await dueNow(id);
    await queueCycle();
    const second = await row(id);
    expect(second.status).toBe("sent");
    expect(stateOf(second.deliveryState)["flaky.test"]).toMatchObject({
      status: "sent",
      attempts: 2,
      mxHost: "mx.flaky.test",
    });
    expect(mx.messages()).toBe(1);
  });

  test("an NXDOMAIN fails the email", async () => {
    setMxRouteDeps({
      resolveMx: () => Promise.reject(dnsError("ENOTFOUND")),
      resolve4: () => Promise.reject(dnsError("ENOTFOUND")),
      resolve6: () => Promise.reject(dnsError("ENOTFOUND")),
    });
    const { id } = await seed.email({ apiKeyId, toAddress: "user@nowhere.test" });

    await queueCycle();
    const failed = await row(id);
    expect(failed.status).toBe("failed");
    expect(stateOf(failed.deliveryState)["nowhere.test"]).toMatchObject({
      status: "failed",
      lastError: "nowhere.test: domain does not exist",
    });
    expect(failed.lastError).toContain("domain does not exist");
    /** No SMTP reply: a failure, never a bounce, and nobody suppressed. */
    expect(await events("email.failed")).toHaveLength(1);
    expect(await events("email.bounced")).toHaveLength(0);
    expect(await db.select().from(suppressions)).toHaveLength(0);
  });

  test("one transaction, three recipients: accepted, 4xx and 5xx each get their own outcome", async () => {
    const first = await startServer("rcpt-codes");
    routeExampleOrg({ mx1: first.port });
    const { id } = await seed.email({
      apiKeyId,
      toAddress: "ok@example.org, soft@example.org",
      cc: "hard@example.org",
    });

    await queueCycle();
    /** One transaction carried all three recipients. */
    expect(first.messages()).toBe(1);
    const afterFirst = await row(id);
    expect(afterFirst.status).toBe("queued");
    const state = stateOf(afterFirst.deliveryState);
    expect(state["example.org"]).toMatchObject({
      status: "sent",
      recipients: ["ok@example.org"],
      mxHost: "mx1.example.test",
    });
    expect(state["example.org#1"]).toMatchObject({
      status: "retry",
      recipients: ["soft@example.org"],
      failureKind: "soft",
      failureCode: "4.2.1",
    });
    expect(state["example.org#2"]).toMatchObject({
      status: "failed",
      recipients: ["hard@example.org"],
      failureKind: "hard",
      failureCode: "5.1.1",
    });

    /** A suppression and an `email.bounced` for the 5xx recipient only. */
    const suppressed = await db
      .select({ email: suppressions.email, code: suppressions.diagnosticCode })
      .from(suppressions);
    expect(suppressed).toEqual([{ email: "hard@example.org", code: "5.1.1" }]);
    const bounced = await events("email.bounced");
    expect(bounced).toHaveLength(1);
    expect(bounced[0]).toMatchObject({ recipient: "hard@example.org", status: "5.1.1" });
    expect(await events("email.sent")).toHaveLength(1);

    /** Next attempt: the 4xx recipient goes out alone, to a server that takes it. */
    const second = await startServer("starttls");
    routeExampleOrg({ mx1: second.port });
    await dueNow(id);
    await queueCycle();
    expect(second.messages()).toBe(1);
    const done = await row(id);
    expect(done.status).toBe("sent");
    const finalState = stateOf(done.deliveryState);
    expect(finalState["example.org#1"]).toMatchObject({ status: "sent", attempts: 2 });
    expect(finalState["example.org"]).toMatchObject({ status: "sent", attempts: 1 });
    expect(finalState["example.org#2"]).toMatchObject({ status: "failed", attempts: 1 });
    expect(await events("email.bounced")).toHaveLength(1);
    expect(await events("email.sent")).toHaveLength(1);
  });
});
