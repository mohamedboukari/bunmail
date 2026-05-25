/**
 * Integration tests for the unscoped suppression methods that back the
 * `/dashboard/suppressions` page (#89). These run against a real
 * Postgres so they cover real Drizzle queries, real ILIKE matching,
 * real FK behaviour — none of which the unit tests touch.
 *
 * The whole reason these methods exist is that operators couldn't
 * recover from auto-suppressions filed under a key other than their
 * Bearer key. The tests pin that flow: create a suppression under key
 * A, delete it via the unscoped path, confirm it's gone.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  listAllSuppressions,
  deleteSuppressionByIdUnscoped,
} from "../../src/modules/suppressions/services/suppression.service.ts";
import { truncateAll, seed, db, suppressions } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

describe("listAllSuppressions (unscoped)", () => {
  test("returns rows across every API key with no filters", async () => {
    const keyA = await seed.apiKey({ name: "team-a" });
    const keyB = await seed.apiKey({ name: "team-b" });
    await seed.suppression({ apiKeyId: keyA.id, email: "a@example.com" });
    await seed.suppression({ apiKeyId: keyB.id, email: "b@example.com" });

    const { data, total } = await listAllSuppressions({ page: 1, limit: 25 });

    expect(total).toBe(2);
    expect(data.map((r) => r.email).sort()).toEqual(["a@example.com", "b@example.com"]);
    /** Two distinct api keys represented — proves the unscoped view. */
    expect(new Set(data.map((r) => r.apiKeyId)).size).toBe(2);
  });

  test("filters by email substring (case-insensitive)", async () => {
    const keyA = await seed.apiKey({ name: "team-a" });
    await seed.suppression({ apiKeyId: keyA.id, email: "alice@gmail.com" });
    await seed.suppression({ apiKeyId: keyA.id, email: "bob@outlook.com" });
    await seed.suppression({ apiKeyId: keyA.id, email: "carol@gmail.com" });

    /** Uppercase query still matches lowercase-stored addresses. */
    const { data, total } = await listAllSuppressions({
      page: 1,
      limit: 25,
      email: "GMAIL",
    });

    expect(total).toBe(2);
    expect(data.map((r) => r.email).sort()).toEqual([
      "alice@gmail.com",
      "carol@gmail.com",
    ]);
  });

  test("filters by api key id when the operator drills in", async () => {
    const keyA = await seed.apiKey({ name: "team-a" });
    const keyB = await seed.apiKey({ name: "team-b" });
    await seed.suppression({ apiKeyId: keyA.id, email: "a@example.com" });
    await seed.suppression({ apiKeyId: keyB.id, email: "b@example.com" });

    const { data, total } = await listAllSuppressions({
      page: 1,
      limit: 25,
      apiKeyId: keyA.id,
    });

    expect(total).toBe(1);
    expect(data[0]!.email).toBe("a@example.com");
    expect(data[0]!.apiKeyId).toBe(keyA.id);
  });

  test("paginates correctly across many rows", async () => {
    const key = await seed.apiKey({ name: "team-a" });
    for (let i = 0; i < 30; i++) {
      await seed.suppression({ apiKeyId: key.id, email: `addr-${i}@example.com` });
    }

    const { data: page1, total } = await listAllSuppressions({ page: 1, limit: 10 });
    const { data: page2 } = await listAllSuppressions({ page: 2, limit: 10 });
    const { data: page3 } = await listAllSuppressions({ page: 3, limit: 10 });

    expect(total).toBe(30);
    expect(page1).toHaveLength(10);
    expect(page2).toHaveLength(10);
    expect(page3).toHaveLength(10);
    /** No overlap between pages. */
    const ids = new Set<string>();
    [...page1, ...page2, ...page3].forEach((r) => ids.add(r.id));
    expect(ids.size).toBe(30);
  });
});

describe("deleteSuppressionByIdUnscoped (the #89 footgun fix)", () => {
  test("an operator can delete a suppression filed under a different API key", async () => {
    /**
     * The actual scenario #89 was filed for: auto-suppression gets
     * filed under whichever key happened to be sending. The
     * operator's Bearer token is a *different* key — so the scoped
     * delete API would return 404. The dashboard's unscoped path is
     * what lets them recover.
     */
    const sendingKey = await seed.apiKey({ name: "auto-suppress-victim" });
    const operatorKey = await seed.apiKey({ name: "operator-bearer" });
    const sup = await seed.suppression({
      apiKeyId: sendingKey.id,
      email: "lost@example.com",
    });

    const removed = await deleteSuppressionByIdUnscoped(sup.id);

    expect(removed).toBeDefined();
    expect(removed!.id).toBe(sup.id);
    expect(removed!.email).toBe("lost@example.com");
    /** The operator's key was never involved; the suppression is gone regardless. */
    expect(operatorKey.id).not.toBe(sendingKey.id);

    /** Row is actually deleted from the DB. */
    const after = await db.select().from(suppressions).where(eq(suppressions.id, sup.id));
    expect(after).toHaveLength(0);
  });

  test("returns undefined when the suppression doesn't exist", async () => {
    const removed = await deleteSuppressionByIdUnscoped("sup_does_not_exist");
    expect(removed).toBeUndefined();
  });
});
