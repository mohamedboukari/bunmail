/**
 * Integration test for the queue's boot-time recovery path.
 *
 * `recoverInterrupted` runs once when `start()` is called. It transitions
 * any `sending` rows back to `queued` so emails caught mid-SMTP at the
 * last shutdown get re-attempted on the next poll cycle. Currently has
 * 0% unit coverage because it's pure DB work.
 *
 * `recoverInterrupted` is not exported from queue.service.ts (private),
 * so we exercise it through `start()` — but that also kicks off the
 * setInterval poll loop, which we need to stop immediately to avoid
 * the loop trying to actually send mail in the test process. Calling
 * `stop()` right after `start()` clears the timer.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import * as queueService from "../../src/modules/emails/services/queue.service.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

afterEach(() => {
  /** Make sure we never leave a poll loop running between tests. */
  queueService.stop();
});

describe("recoverInterrupted (via queueService.start)", () => {
  test("transitions every 'sending' row back to 'queued'", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: stuckA } = await seed.email({ apiKeyId, status: "sending" });
    const { id: stuckB } = await seed.email({ apiKeyId, status: "sending" });
    const { id: queuedRow } = await seed.email({ apiKeyId, status: "queued" });
    const { id: sentRow } = await seed.email({ apiKeyId, status: "sent" });
    const { id: failedRow } = await seed.email({ apiKeyId, status: "failed" });
    const { id: bouncedRow } = await seed.email({ apiKeyId, status: "bounced" });

    /** Boot recovery runs synchronously inside `start()` before the
     *  poll timer kicks off. We `await` it to confirm transitions. */
    await queueService.start();

    const fetched = async (id: string) =>
      (
        await db.select({ status: emails.status }).from(emails).where(eq(emails.id, id))
      )[0]?.status;

    /** sending → queued */
    expect(await fetched(stuckA)).toBe("queued");
    expect(await fetched(stuckB)).toBe("queued");
    /** Other statuses untouched. */
    expect(await fetched(queuedRow)).toBe("queued");
    expect(await fetched(sentRow)).toBe("sent");
    expect(await fetched(failedRow)).toBe("failed");
    expect(await fetched(bouncedRow)).toBe("bounced");
  });

  test("ignores trashed (deleted_at IS NOT NULL) rows even if status='sending'", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: stuckLive } = await seed.email({ apiKeyId, status: "sending" });
    const { id: stuckTrashed } = await seed.email({ apiKeyId, status: "sending" });
    /** Mark one as trashed AFTER seed (the seed factory doesn't expose deletedAt). */
    await db
      .update(emails)
      .set({ deletedAt: new Date() })
      .where(eq(emails.id, stuckTrashed));

    await queueService.start();

    const live = (
      await db
        .select({ status: emails.status })
        .from(emails)
        .where(eq(emails.id, stuckLive))
    )[0];
    const trashed = (
      await db
        .select({ status: emails.status })
        .from(emails)
        .where(eq(emails.id, stuckTrashed))
    )[0];

    expect(live?.status).toBe("queued");
    /** Trashed row stays in `sending` — recovery filter excluded it. The
     *  queue selector also excludes trashed rows, so this is consistent
     *  with not re-sending something the user explicitly trashed. */
    expect(trashed?.status).toBe("sending");
  });

  test("no-op when there are no interrupted rows", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.email({ apiKeyId, status: "queued" });
    await seed.email({ apiKeyId, status: "sent" });

    /** Should return without throwing or mutating. */
    await queueService.start();

    const all = await db.select({ status: emails.status }).from(emails);
    expect(all.find((r) => r.status === "queued")).toBeDefined();
    expect(all.find((r) => r.status === "sent")).toBeDefined();
    expect(all.find((r) => r.status === "sending")).toBeUndefined();
  });
});
