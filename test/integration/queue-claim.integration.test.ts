/**
 * Integration test for `claimNextEmails` — the atomic
 * `queued → sending` transition that fixes the race in #20.
 *
 * The old code split the transition into a `SELECT` followed by N
 * separate `UPDATE`s, so two concurrent workers could pick the same
 * rows and end up double-sending the same email. The new code uses
 * Postgres's `FOR UPDATE SKIP LOCKED` inside a single
 * `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING *`
 * statement. Two guarantees we want to lock down here:
 *
 *   1. Each row is claimed by **at most one** caller — no duplicate ids
 *      across concurrent claims (this is the actual bug fix).
 *   2. Every queued row eventually gets claimed when there's enough
 *      demand — `SKIP LOCKED` shouldn't accidentally drop rows.
 *
 * We exercise both with a fan-out: seed 30 queued rows, fire 6
 * concurrent `claimNextEmails(5)` calls, assert the union covers all 30
 * ids exactly once and every claimed row is now `sending` with
 * `attempts = 1`.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { claimNextEmails } from "../../src/modules/emails/services/queue.service.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

describe("claimNextEmails — atomic queued → sending claim", () => {
  test("single call: claims up to N rows, increments attempts, marks sending", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const seeded: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { id } = await seed.email({ apiKeyId, status: "queued" });
      seeded.push(id);
    }

    const claimed = await claimNextEmails(3);

    expect(claimed).toHaveLength(3);
    /** All claimed rows belong to the seeded set — no rogue ids. */
    expect(claimed.every((r) => seeded.includes(r.id))).toBe(true);
    /** Every claimed row is now `sending` with attempts incremented. */
    expect(claimed.every((r) => r.status === "sending")).toBe(true);
    expect(claimed.every((r) => r.attempts === 1)).toBe(true);

    /** The 2 unclaimed rows are still `queued`. */
    const unclaimed = await db.select().from(emails).where(eq(emails.status, "queued"));
    expect(unclaimed).toHaveLength(2);
  });

  test("returns empty when no queued rows exist", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    /** Seed only non-queued statuses — claim should return []. */
    await seed.email({ apiKeyId, status: "sent" });
    await seed.email({ apiKeyId, status: "failed" });
    await seed.email({ apiKeyId, status: "bounced" });

    const claimed = await claimNextEmails(5);

    expect(claimed).toHaveLength(0);
  });

  test("ignores trashed (deleted_at IS NOT NULL) rows", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: live } = await seed.email({ apiKeyId, status: "queued" });
    const { id: trashed } = await seed.email({ apiKeyId, status: "queued" });
    /** Soft-delete one — claim should skip it the same way the dashboard does. */
    await db.update(emails).set({ deletedAt: new Date() }).where(eq(emails.id, trashed));

    const claimed = await claimNextEmails(5);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(live);
  });

  test("oldest first — orders by created_at ascending", async () => {
    const { id: apiKeyId } = await seed.apiKey();

    /** Seed in reverse chronological order: oldest gets inserted first. */
    const { id: oldest } = await seed.email({ apiKeyId, status: "queued" });
    /** Tiny await to guarantee distinct created_at — Postgres timestamptz is
     *  microsecond-precision but seeding in a tight loop can collide on slow
     *  CI runners. 5ms is plenty. */
    await new Promise((r) => setTimeout(r, 5));
    const { id: middle } = await seed.email({ apiKeyId, status: "queued" });
    await new Promise((r) => setTimeout(r, 5));
    const { id: newest } = await seed.email({ apiKeyId, status: "queued" });

    const claimed = await claimNextEmails(2);

    /** Should pick `oldest` and `middle`, leaving `newest`. */
    const claimedIds = claimed.map((r) => r.id).sort();
    expect(claimedIds).toEqual([oldest, middle].sort());

    const stillQueued = await db
      .select({ id: emails.id })
      .from(emails)
      .where(eq(emails.status, "queued"));
    expect(stillQueued.map((r) => r.id)).toEqual([newest]);
  });

  test("concurrent callers never claim the same row twice (the #20 race fix)", async () => {
    /**
     * The actual race regression test. We fire 6 callers each asking for
     * 5 rows in parallel against a pool of 30 queued rows. Without
     * `FOR UPDATE SKIP LOCKED`, you'd see overlapping ids in callers'
     * results — sometimes all 6 callers grabbing the same first 5 rows.
     * With it, each row is claimed by exactly one caller.
     */
    const { id: apiKeyId } = await seed.apiKey();
    const seededIds: string[] = [];
    for (let i = 0; i < 30; i++) {
      const { id } = await seed.email({ apiKeyId, status: "queued" });
      seededIds.push(id);
    }

    /** Fire 6 concurrent claim calls, each asking for 5 rows. */
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claimNextEmails(5)),
    );

    /** Flatten — every id any caller saw, with duplicates if any leaked. */
    const allClaimedIds = results.flatMap((batch) => batch.map((r) => r.id));

    /** Total count should be exactly 30 — every seeded row claimed once. */
    expect(allClaimedIds).toHaveLength(30);

    /** No duplicates: a Set of all claimed ids should be the same size. */
    const uniqueIds = new Set(allClaimedIds);
    expect(uniqueIds.size).toBe(30);

    /** Set equality with the seeded set — no row was missed, none invented. */
    expect([...uniqueIds].sort()).toEqual([...seededIds].sort());

    /** Every claimed row in the DB is now `sending` with attempts=1. */
    const dbRows = await db
      .select({ id: emails.id, status: emails.status, attempts: emails.attempts })
      .from(emails)
      .where(inArray(emails.id, seededIds));
    expect(dbRows.every((r) => r.status === "sending")).toBe(true);
    expect(dbRows.every((r) => r.attempts === 1)).toBe(true);
  });

  test("concurrent claims partition cleanly when demand exceeds supply", async () => {
    /**
     * Same pattern but supply (10 rows) is less than total demand (4 callers × 5
     * = 20). The first claims should drain the pool; later/losing claims see []
     * rather than blocking or doubling up.
     */
    const { id: apiKeyId } = await seed.apiKey();
    const seededIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { id } = await seed.email({ apiKeyId, status: "queued" });
      seededIds.push(id);
    }

    const results = await Promise.all(
      Array.from({ length: 4 }, () => claimNextEmails(5)),
    );
    const allClaimedIds = results.flatMap((batch) => batch.map((r) => r.id));

    /** Exactly 10 claims total — every queued row claimed exactly once. */
    expect(allClaimedIds).toHaveLength(10);
    expect(new Set(allClaimedIds).size).toBe(10);
    expect([...new Set(allClaimedIds)].sort()).toEqual([...seededIds].sort());
  });
});
