/**
 * Queue backoff and leases (#180), against real Postgres.
 *
 * - Temporary failures are retried later (escalating backoff), not
 *   within seconds, until the email is older than the retry window.
 * - A claim takes a lease; only an expired lease makes a `sending` row
 *   claimable again. This replaces the boot-time reset of every
 *   `sending` row, which resent emails another replica was still sending.
 *
 * The mailer is injected into `runQueueCycle`, so no SMTP is involved.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  claimNextEmails,
  releaseOwnLeases,
  runQueueCycle,
} from "../../src/modules/emails/services/queue.service.ts";
import { apiKeys } from "../../src/modules/api-keys/models/api-key.schema.ts";
import type { sendMail } from "../../src/modules/emails/services/mailer.service.ts";
import type { DeliveryGroupStatus } from "../../src/modules/emails/models/email.schema.ts";
import { truncateAll, seed, db, emails, suppressions } from "./_helpers.ts";

/** A mailer that reports one MX group with the given outcome. */
function fakeMailer(status: DeliveryGroupStatus, lastError?: string): typeof sendMail {
  return async (options) => ({
    messageId: options.messageId,
    deliveryState: {
      "mx.example.org": {
        status,
        recipients: ["user@example.org"],
        attempts: 1,
        ...(lastError ? { lastError } : {}),
      },
    },
  });
}

/** Polls `done` every 10 ms for up to 2 s. */
async function waitUntil(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(10);
}

async function row(id: string) {
  const [r] = await db.select().from(emails).where(eq(emails.id, id));
  if (!r) throw new Error(`email ${id} not found`);
  return r;
}

beforeEach(async () => {
  await truncateAll();
});

describe("backoff on temporary failures", () => {
  test("a 4xx requeues the email minutes later, not on the next poll", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });

    await runQueueCycle({ sendMail: fakeMailer("retry", "421 4.7.0 Try again later") });

    const r = await row(id);
    expect(r.status).toBe("queued");
    expect(r.attempts).toBe(1);
    expect(r.lockedBy).toBeNull();
    expect(r.leaseUntil).toBeNull();
    /** First retry after about 5 minutes. */
    const waitMs = r.nextAttemptAt.getTime() - Date.now();
    expect(waitMs).toBeGreaterThan(4 * 60_000);
    expect(waitMs).toBeLessThan(6 * 60_000);

    /** Not due yet: the next cycle does not pick it up. */
    expect(await claimNextEmails(10)).toEqual([]);
  });

  test("an email older than the retry window fails for good", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });
    await db
      .update(emails)
      .set({ createdAt: sql`NOW() - interval '49 hours'` })
      .where(eq(emails.id, id));

    await runQueueCycle({ sendMail: fakeMailer("retry", "421 4.7.0 Try again later") });

    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.lockedBy).toBeNull();
  });

  test("a delivered email releases its lease", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });

    await runQueueCycle({ sendMail: fakeMailer("sent") });

    const r = await row(id);
    expect(r.status).toBe("sent");
    expect(r.lockedBy).toBeNull();
    expect(r.leaseUntil).toBeNull();
  });
});

describe("leases", () => {
  test("a claim takes a lease of about 15 minutes", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId });

    await claimNextEmails(10);

    const r = await row(id);
    expect(r.status).toBe("sending");
    expect(r.lockedBy).not.toBeNull();
    const leaseMs = (r.leaseUntil?.getTime() ?? 0) - Date.now();
    expect(leaseMs).toBeGreaterThan(14 * 60_000);
    expect(leaseMs).toBeLessThan(16 * 60_000);
  });

  test("a sending row with a live lease is never reclaimed", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.email({ apiKeyId });

    expect(await claimNextEmails(10)).toHaveLength(1);
    /** Another worker (or a restarted process) must not take it. */
    expect(await claimNextEmails(10)).toEqual([]);
  });

  test("a sending row whose lease expired is reclaimed, counting the lost attempt", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId });
    await claimNextEmails(10);
    await db
      .update(emails)
      .set({ leaseUntil: sql`NOW() - interval '1 second'` })
      .where(eq(emails.id, id));

    const reclaimed = await claimNextEmails(10);
    expect(reclaimed.map((r) => r.id)).toEqual([id]);
    expect(reclaimed[0]!.attempts).toBe(2);
  });

  test("an outcome is not saved once another worker holds the row", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });

    /** While this worker is sending, the row moves to another worker. */
    const stolen: typeof sendMail = async (options) => {
      await db.update(emails).set({ lockedBy: "other-worker" }).where(eq(emails.id, id));
      return fakeMailer("sent")(options);
    };
    await runQueueCycle({ sendMail: stolen });

    const r = await row(id);
    expect(r.status).toBe("sending");
    expect(r.lockedBy).toBe("other-worker");
  });
});

describe("review follow-ups", () => {
  test("a sending row with no lease (old version) is reclaimed 15 minutes after its last update", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, status: "sending" });

    /** Recently claimed by an old replica: left alone. */
    await db
      .update(emails)
      .set({ leaseUntil: null, updatedAt: new Date() })
      .where(eq(emails.id, id));
    expect(await claimNextEmails(10)).toEqual([]);

    /** Untouched for 16 minutes: its claim is treated as expired. */
    await db
      .update(emails)
      .set({ updatedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(emails.id, id));
    expect((await claimNextEmails(10)).map((r) => r.id)).toEqual([id]);
  });

  test("an outcome is not saved when the same process reclaimed the row meanwhile", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });

    /** Same worker id, newer claim: only `attempts` differs. */
    const reclaimed: typeof sendMail = async (options) => {
      await db
        .update(emails)
        .set({ attempts: sql`${emails.attempts} + 1` })
        .where(eq(emails.id, id));
      return fakeMailer("sent")(options);
    };
    await runQueueCycle({ sendMail: reclaimed });

    expect((await row(id)).status).toBe("sending");
  });

  test("on shutdown the process hands its rows back immediately", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId });
    await claimNextEmails(10);
    expect(await claimNextEmails(10)).toEqual([]);

    await releaseOwnLeases();

    expect((await claimNextEmails(10)).map((r) => r.id)).toEqual([id]);
  });

  test("a retry for a key revoked in the meantime is failed without sending", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });
    await db.update(apiKeys).set({ isActive: false }).where(eq(apiKeys.id, apiKeyId));

    let sent = false;
    await runQueueCycle({
      sendMail: async (options) => {
        sent = true;
        return fakeMailer("sent")(options);
      },
    });

    expect(sent).toBe(false);
    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("revoked");
  });

  test("a partially delivered email that is still retrying records when it was first delivered", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({
      apiKeyId,
      toAddress: "a@one.example",
      status: "queued",
    });
    const deliveredAt = "2026-10-17T10:00:00.000Z";

    await runQueueCycle({
      sendMail: async (options) => ({
        messageId: options.messageId,
        deliveryState: {
          "mx.one.example": {
            status: "sent",
            recipients: ["a@one.example"],
            attempts: 1,
            deliveredAt,
          },
          "mx.two.example": {
            status: "retry",
            recipients: ["b@two.example"],
            attempts: 1,
            lastError: "451 4.7.500 later",
          },
        },
      }),
    });

    const r = await row(id);
    expect(r.status).toBe("queued");
    expect(r.sentAt?.toISOString()).toBe(deliveredAt);
  });
});

describe("sender policy blocks (#246)", () => {
  test("a blocklist rejection fails the email without suppressing the recipient", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "user@example.org" });

    await runQueueCycle({
      sendMail: async (options) => ({
        messageId: options.messageId,
        deliveryState: {
          "mx.example.org": {
            status: "failed",
            recipients: ["user@example.org"],
            attempts: 1,
            blocked: true,
            lastError:
              "550 5.7.1 Service unavailable; Client host blocked using Spamhaus",
          },
        },
      }),
    });

    expect((await row(id)).status).toBe("failed");
    expect(await db.select().from(suppressions)).toEqual([]);
  });
});

describe("bounded concurrency (#176)", () => {
  test("a cycle claims only free slots: slow sends never grow the number in flight", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    for (let i = 0; i < 6; i++) {
      await seed.email({ apiKeyId, toAddress: `user${i}@example.org` });
    }

    /** A receiver that holds every send until released. */
    let started = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: typeof sendMail = async (options) => {
      started++;
      await gate;
      return fakeMailer("sent")(options);
    };
    const limits = { batchSize: 5, maxConcurrentSends: 3 };

    const first = runQueueCycle({ sendMail: slow }, limits);
    await waitUntil(() => started >= 3);
    expect(started).toBe(3);

    /** Every slot is taken: the next cycle claims nothing. */
    await runQueueCycle({ sendMail: slow }, limits);
    expect(started).toBe(3);
    const statuses = (await db.select({ status: emails.status }).from(emails)).map(
      (r) => r.status,
    );
    expect(statuses.filter((s) => s === "sending")).toHaveLength(3);
    expect(statuses.filter((s) => s === "queued")).toHaveLength(3);

    /** Slots free up once the sends finish, and the rest drains. */
    release();
    await first;
    await runQueueCycle({ sendMail: fakeMailer("sent") }, limits);
    const after = (await db.select({ status: emails.status }).from(emails)).map(
      (r) => r.status,
    );
    expect(after).toEqual(["sent", "sent", "sent", "sent", "sent", "sent"]);
  });
});

describe("suppression re-check on retry (#262)", () => {
  /** Puts the email in its state after a first pass that left one MX group in retry. */
  async function retryingWith(id: string, recipients: string[]): Promise<void> {
    await db
      .update(emails)
      .set({
        attempts: 1,
        deliveryState: {
          "mx.example.org": {
            status: "retry",
            recipients,
            attempts: 1,
            lastError: "421 later",
          },
        },
      })
      .where(eq(emails.id, id));
  }

  /** A mailer that records the state it was handed and delivers every retry group. */
  function recordingMailer(): {
    mailer: typeof sendMail;
    seen: Array<Parameters<typeof sendMail>[0]["existingState"]>;
  } {
    const seen: Array<Parameters<typeof sendMail>[0]["existingState"]> = [];
    const mailer: typeof sendMail = async (options) => {
      seen.push(options.existingState);
      const state = structuredClone(options.existingState ?? {});
      for (const group of Object.values(state)) {
        if (group.status === "retry") group.status = "sent";
      }
      return { messageId: options.messageId, deliveryState: state };
    };
    return { mailer, seen };
  }

  test("a recipient suppressed since the first pass is not sent; the others are", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({
      apiKeyId,
      toAddress: "a@example.org, b@example.org",
    });
    await retryingWith(id, ["a@example.org", "b@example.org"]);
    await seed.suppression({ apiKeyId, email: "b@example.org", reason: "unsubscribe" });
    const { mailer, seen } = recordingMailer();

    await runQueueCycle({ sendMail: mailer });

    expect(seen[0]?.["mx.example.org"]?.recipients).toEqual(["a@example.org"]);
    expect((await row(id)).status).toBe("sent");
  });

  test("a group whose recipients are all suppressed fails without sending", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "b@example.org" });
    await retryingWith(id, ["b@example.org"]);
    await seed.suppression({ apiKeyId, email: "B@Example.org", reason: "bounce" });
    const { mailer, seen } = recordingMailer();

    await runQueueCycle({ sendMail: mailer });

    expect(seen[0]?.["mx.example.org"]?.status).toBe("failed");
    const r = await row(id);
    expect(r.status).toBe("failed");
    expect(r.lastError).toContain("suppressed before this retry");
  });

  test("another key's suppression does not apply", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: otherKey } = await seed.apiKey();
    const { id } = await seed.email({ apiKeyId, toAddress: "b@example.org" });
    await retryingWith(id, ["b@example.org"]);
    await seed.suppression({ apiKeyId: otherKey, email: "b@example.org" });
    const { mailer, seen } = recordingMailer();

    await runQueueCycle({ sendMail: mailer });

    expect(seen[0]?.["mx.example.org"]?.recipients).toEqual(["b@example.org"]);
    expect((await row(id)).status).toBe("sent");
  });
});
