/**
 * Fair claiming for the email queue and the webhook delivery worker
 * (#258), against a real Postgres.
 *
 * Both claims used to take a global FIFO batch, so one API key with a
 * large backlog filled every batch and another key's single email (or
 * event) waited behind all of it. Each batch is now shared across API
 * keys round-robin: every key's oldest due row ranks 1, its next one 2,
 * and the batch takes the lowest ranks first, oldest first within a rank.
 * A single key keeps plain FIFO order.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { inArray } from "drizzle-orm";
import { claimNextEmails } from "../../src/modules/emails/services/queue.service.ts";
import { claimDueDeliveries } from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { generateId } from "../../src/utils/id.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

/** `minutesAgo` minutes before now, plus `ms` milliseconds. */
function ago(minutesAgo: number, ms = 0): Date {
  return new Date(Date.now() - minutesAgo * 60_000 + ms);
}

/**
 * Inserts `count` due queued emails for `apiKeyId` in one statement, the
 * i-th due at `dueFrom + i` ms. Returns their ids in due order.
 */
async function queueEmails(
  apiKeyId: string,
  count: number,
  dueFrom: Date,
): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: generateId("msg"),
    apiKeyId,
    fromAddress: "hello@example.com",
    toAddress: "user@example.com",
    subject: "test",
    html: "<p>test</p>",
    status: "queued",
    nextAttemptAt: new Date(dueFrom.getTime() + i),
  }));
  await db.insert(emails).values(rows);
  return rows.map((r) => r.id);
}

/**
 * Inserts `count` due pending deliveries for `webhookId`, the i-th due at
 * `dueFrom + i` ms. Returns their ids in due order.
 */
async function queueDeliveries(
  webhookId: string,
  count: number,
  dueFrom: Date,
): Promise<string[]> {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: generateId("wdl"),
    webhookId,
    event: "email.sent",
    payload: "{}",
    status: "pending",
    nextAttemptAt: new Date(dueFrom.getTime() + i),
  }));
  await db.insert(webhookDeliveries).values(rows);
  return rows.map((r) => r.id);
}

/** A webhook for `apiKeyId` (the URL is never called by a claim). */
async function hookFor(apiKeyId: string): Promise<string> {
  const { id } = await seed.webhook({
    apiKeyId,
    url: "https://93.184.216.34/hook",
    events: ["email.sent"],
  });
  return id;
}

describe("claimNextEmails: fair across API keys (#258)", () => {
  test("a key's large backlog does not starve another key's single email", async () => {
    const { id: noisy } = await seed.apiKey({ name: "noisy" });
    const { id: quiet } = await seed.apiKey({ name: "quiet" });
    /** 500 emails due an hour ago, then one email due just now. */
    await queueEmails(noisy, 500, ago(60));
    const single = await queueEmails(quiet, 1, ago(0, -1000));

    const batch = await claimNextEmails(5);

    expect(batch).toHaveLength(5);
    expect(batch.map((r) => r.id)).toEqual(expect.arrayContaining(single));
    expect(batch.filter((r) => r.apiKeyId === noisy)).toHaveLength(4);
  });

  test("the batch is shared round-robin, oldest first within a round", async () => {
    const { id: a } = await seed.apiKey({ name: "a" });
    const { id: b } = await seed.apiKey({ name: "b" });
    const { id: c } = await seed.apiKey({ name: "c" });
    const aIds = await queueEmails(a, 10, ago(30));
    const bIds = await queueEmails(b, 10, ago(20));
    const cIds = await queueEmails(c, 1, ago(10));

    const batch = await claimNextEmails(5);

    /** Round 1: each key's oldest; round 2: the next of A and B. */
    expect(batch.map((r) => r.id).toSorted()).toEqual(
      [...aIds.slice(0, 2), ...bIds.slice(0, 2), ...cIds].toSorted(),
    );
  });

  test("a single key keeps FIFO order by due time", async () => {
    const { id: only } = await seed.apiKey();
    /** Inserted newest first, so insertion order is not due order. */
    const late = await queueEmails(only, 3, ago(5));
    const early = await queueEmails(only, 3, ago(50));

    const first = await claimNextEmails(3);
    expect(first.map((r) => r.id).toSorted()).toEqual([...early].toSorted());
    const second = await claimNextEmails(3);
    expect(second.map((r) => r.id).toSorted()).toEqual([...late].toSorted());
  });

  test("rows not yet due are never claimed, whatever the key", async () => {
    const { id: a } = await seed.apiKey();
    const { id: b } = await seed.apiKey();
    await queueEmails(a, 3, new Date(Date.now() + 60 * 60_000));
    const due = await queueEmails(b, 1, ago(1));

    const batch = await claimNextEmails(5);
    expect(batch.map((r) => r.id)).toEqual(due);
  });

  test("concurrent claims stay disjoint and drain every key", async () => {
    const { id: a } = await seed.apiKey();
    const { id: b } = await seed.apiKey();
    const seeded = [
      ...(await queueEmails(a, 20, ago(30))),
      ...(await queueEmails(b, 5, ago(20))),
    ];

    const results = await Promise.all(
      Array.from({ length: 5 }, () => claimNextEmails(5)),
    );
    const claimed = results.flatMap((batch) => batch.map((r) => r.id));
    /** Every claim is disjoint (no id twice). */
    expect(new Set(claimed).size).toBe(claimed.length);
    /** Drain whatever concurrent skips left behind: nothing is lost. */
    for (let i = 0; i < 10 && claimed.length < seeded.length; i++) {
      claimed.push(...(await claimNextEmails(5)).map((r) => r.id));
    }
    expect(claimed.toSorted()).toEqual(seeded.toSorted());
    const rows = await db
      .select({ status: emails.status })
      .from(emails)
      .where(inArray(emails.id, seeded));
    expect(rows.every((r) => r.status === "sending")).toBe(true);
  });
});

describe("claimDueDeliveries: fair across API keys (#258)", () => {
  test("a key's large backlog does not starve another key's single delivery", async () => {
    const { id: noisy } = await seed.apiKey({ name: "noisy" });
    const { id: quiet } = await seed.apiKey({ name: "quiet" });
    /** The noisy key spreads its backlog over two webhooks. */
    await queueDeliveries(await hookFor(noisy), 200, ago(60));
    await queueDeliveries(await hookFor(noisy), 200, ago(59));
    const single = await queueDeliveries(await hookFor(quiet), 1, ago(0, -1000));

    const batch = await claimDueDeliveries(25);

    expect(batch).toHaveLength(25);
    expect(batch.map((r) => r.id)).toEqual(expect.arrayContaining(single));
  });

  test("a key's webhooks share one rank, so more webhooks buy no larger share", async () => {
    const { id: a } = await seed.apiKey({ name: "a" });
    const { id: b } = await seed.apiKey({ name: "b" });
    const a1 = await queueDeliveries(await hookFor(a), 5, ago(30));
    const a2 = await queueDeliveries(await hookFor(a), 5, ago(29));
    const bIds = await queueDeliveries(await hookFor(b), 5, ago(20));

    const batch = await claimDueDeliveries(4);

    /** Two rounds: A's two oldest overall (both on its first webhook), B's two oldest. */
    expect(batch.map((r) => r.id).toSorted()).toEqual(
      [...a1.slice(0, 2), ...bIds.slice(0, 2)].toSorted(),
    );
    expect(batch.map((r) => r.id)).not.toEqual(expect.arrayContaining(a2.slice(0, 1)));
  });

  test("a single key keeps FIFO order by due time across its webhooks", async () => {
    const { id: only } = await seed.apiKey();
    const late = await queueDeliveries(await hookFor(only), 2, ago(5));
    const early = await queueDeliveries(await hookFor(only), 2, ago(50));

    const first = await claimDueDeliveries(2);
    expect(first.map((r) => r.id).toSorted()).toEqual([...early].toSorted());
    const second = await claimDueDeliveries(2);
    expect(second.map((r) => r.id).toSorted()).toEqual([...late].toSorted());
  });

  test("concurrent claims stay disjoint", async () => {
    const { id: a } = await seed.apiKey();
    const { id: b } = await seed.apiKey();
    await queueDeliveries(await hookFor(a), 30, ago(30));
    await queueDeliveries(await hookFor(b), 10, ago(20));

    const results = await Promise.all(
      Array.from({ length: 4 }, () => claimDueDeliveries(10)),
    );
    const claimed = results.flatMap((batch) => batch.map((r) => r.id));
    expect(claimed.length).toBeGreaterThan(0);
    expect(new Set(claimed).size).toBe(claimed.length);
  });
});
