/**
 * The queue gauges of `GET /metrics` (#362), against a real Postgres:
 * only live (not trashed) `queued` and `sending` rows count, and the
 * overdue age measures `next_attempt_at`, not the email's age, so a
 * scheduled retry is not mistaken for a stuck queue.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { readQueueSnapshot } from "../../src/modules/metrics/services/db-gauges.service.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

/** `minutes` minutes from now (negative: in the past). */
function inMinutes(minutes: number): Date {
  return new Date(Date.now() + minutes * 60_000);
}

describe("readQueueSnapshot", () => {
  test("an empty queue is all zeros", async () => {
    expect(await readQueueSnapshot()).toEqual({
      queued: 0,
      sending: 0,
      due: 0,
      oldestDueAgeSeconds: 0,
    });
  });

  test("counts live queued and sending rows; the overdue age follows next_attempt_at", async () => {
    const apiKey = await seed.apiKey();
    const overdue = await seed.email({ apiKeyId: apiKey.id, status: "queued" });
    const dueNow = await seed.email({ apiKeyId: apiKey.id, status: "queued" });
    const retryLater = await seed.email({ apiKeyId: apiKey.id, status: "queued" });
    await seed.email({ apiKeyId: apiKey.id, status: "sending" });
    await seed.email({ apiKeyId: apiKey.id, status: "sent" });
    await seed.email({ apiKeyId: apiKey.id, status: "failed" });
    const trashed = await seed.email({ apiKeyId: apiKey.id, status: "queued" });

    await db
      .update(emails)
      .set({ nextAttemptAt: inMinutes(-10) })
      .where(eq(emails.id, overdue.id));
    await db
      .update(emails)
      .set({ nextAttemptAt: inMinutes(-1) })
      .where(eq(emails.id, dueNow.id));
    await db
      .update(emails)
      .set({ nextAttemptAt: inMinutes(30) })
      .where(eq(emails.id, retryLater.id));
    await db
      .update(emails)
      .set({ deletedAt: new Date(), nextAttemptAt: inMinutes(-60) })
      .where(eq(emails.id, trashed.id));

    const snapshot = await readQueueSnapshot();
    expect(snapshot.queued).toBe(3);
    expect(snapshot.sending).toBe(1);
    expect(snapshot.due).toBe(2);
    /** The overdue email, not the trashed one an hour overdue. */
    expect(snapshot.oldestDueAgeSeconds).toBeGreaterThan(9 * 60);
    expect(snapshot.oldestDueAgeSeconds).toBeLessThan(11 * 60);
  });
});
