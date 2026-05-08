/**
 * Integration tests for `suppression.service.ts` against a real
 * Postgres. Catches what mocked-DB unit tests can't:
 *
 *   - `ON CONFLICT DO UPDATE` upsert behaviour (re-suppressing
 *     overwrites a row instead of inserting a duplicate)
 *   - Address normalisation (lower-case + trim) at the gate's WHERE
 *   - Expiry filter (`gt(expiresAt, now())`) — soft suppressions
 *     in the past should NOT block sends; ones in the future should
 *   - `ON DELETE CASCADE` from `api_keys` — revoking a key wipes its
 *     suppression list
 *
 * Each test starts from a clean DB via `truncateAll()`.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  addFromBounce,
  isSuppressed,
  createSuppression,
  listSuppressions,
  deleteSuppression,
  getSuppressionById,
} from "../../src/modules/suppressions/services/suppression.service.ts";
import { truncateAll, seed, db, suppressions, apiKeys } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

describe("isSuppressed", () => {
  test("returns undefined when no row exists for (apiKey, email)", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const result = await isSuppressed(apiKeyId, "nobody@example.com");
    expect(result).toBeUndefined();
  });

  test("returns the row when a permanent suppression exists", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: supId } = await seed.suppression({
      apiKeyId,
      email: "blocked@example.com",
      reason: "manual",
    });
    const result = await isSuppressed(apiKeyId, "blocked@example.com");
    expect(result?.id).toBe(supId);
    expect(result?.reason).toBe("manual");
    expect(result?.expiresAt).toBeNull();
  });

  test("returns the row when expiresAt is in the future", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.suppression({
      apiKeyId,
      email: "soft@example.com",
      reason: "bounce",
      bounceType: "soft",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const result = await isSuppressed(apiKeyId, "soft@example.com");
    expect(result).toBeDefined();
    expect(result?.bounceType).toBe("soft");
  });

  test("returns undefined when expiresAt is in the past", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.suppression({
      apiKeyId,
      email: "expired@example.com",
      reason: "bounce",
      bounceType: "soft",
      expiresAt: new Date(Date.now() - 60_000),
    });
    const result = await isSuppressed(apiKeyId, "expired@example.com");
    expect(result).toBeUndefined();
  });

  test("normalises the lookup address (case-fold + trim)", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    /** Stored in canonical form by the service. */
    await seed.suppression({ apiKeyId, email: "alice@example.com", reason: "manual" });
    /** All three variants must hit the same row. */
    expect(await isSuppressed(apiKeyId, "Alice@Example.COM")).toBeDefined();
    expect(await isSuppressed(apiKeyId, "  alice@example.com  ")).toBeDefined();
    expect(await isSuppressed(apiKeyId, "ALICE@EXAMPLE.COM")).toBeDefined();
  });

  test("isolates suppressions per api_key — one tenant's bounces don't gate another's", async () => {
    const { id: keyA } = await seed.apiKey({ name: "tenant-a" });
    const { id: keyB } = await seed.apiKey({ name: "tenant-b" });
    await seed.suppression({
      apiKeyId: keyA,
      email: "user@example.com",
      reason: "manual",
    });
    expect(await isSuppressed(keyA, "user@example.com")).toBeDefined();
    expect(await isSuppressed(keyB, "user@example.com")).toBeUndefined();
  });
});

describe("addFromBounce — upsert", () => {
  test("inserts a fresh row on first call", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const result = await addFromBounce(apiKeyId, {
      email: "bounce@example.com",
      bounceType: "hard",
      diagnosticCode: "5.1.1",
      sourceEmailId: undefined,
    });
    expect(result.id).toMatch(/^sup_/);
    const [row] = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.id, result.id));
    expect(row?.bounceType).toBe("hard");
    expect(row?.diagnosticCode).toBe("5.1.1");
    expect(row?.reason).toBe("bounce");
  });

  test("upserts on the unique (api_key_id, email) constraint — second call overwrites", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const first = await addFromBounce(apiKeyId, {
      email: "user@example.com",
      bounceType: "soft",
      diagnosticCode: "4.2.2",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const second = await addFromBounce(apiKeyId, {
      email: "user@example.com",
      bounceType: "hard",
      diagnosticCode: "5.1.1",
      expiresAt: null,
    });
    /** Same row id (UPSERT path), updated fields. */
    expect(second.id).toBe(first.id);
    const all = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, "user@example.com"));
    expect(all).toHaveLength(1);
    expect(all[0]?.bounceType).toBe("hard");
    expect(all[0]?.diagnosticCode).toBe("5.1.1");
    expect(all[0]?.expiresAt).toBeNull();
  });
});

describe("createSuppression — manual upsert clears bounce metadata", () => {
  test("manual re-suppression of a previously-bounced address clears bounce_type / diagnostic_code", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    /** First, an automated bounce suppression. */
    await addFromBounce(apiKeyId, {
      email: "user@example.com",
      bounceType: "hard",
      diagnosticCode: "5.1.1",
    });
    /** Operator manually re-suppresses (e.g. extending expiry). */
    await createSuppression(apiKeyId, {
      email: "user@example.com",
      reason: "manual",
      expiresAt: null,
    });
    const [row] = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, "user@example.com"));
    expect(row?.reason).toBe("manual");
    /** Stale bounce metadata cleared — operator's manual override doesn't
     *  carry forward "this was a bounce" provenance that's no longer true. */
    expect(row?.bounceType).toBeNull();
    expect(row?.diagnosticCode).toBeNull();
  });
});

describe("CASCADE on api_keys delete", () => {
  test("deleting an api_key wipes its suppressions", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.suppression({ apiKeyId, email: "a@example.com", reason: "manual" });
    await seed.suppression({ apiKeyId, email: "b@example.com", reason: "bounce" });

    /** Sanity: the rows exist before the cascade. */
    const before = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.apiKeyId, apiKeyId));
    expect(before).toHaveLength(2);

    /** Delete the api_key. The schema's `ON DELETE CASCADE` on
     *  `suppressions.api_key_id` should drop the rows automatically. */
    await db.delete(apiKeys).where(eq(apiKeys.id, apiKeyId));

    const after = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.apiKeyId, apiKeyId));
    expect(after).toHaveLength(0);
  });
});

describe("listSuppressions / getSuppressionById / deleteSuppression", () => {
  test("listSuppressions paginates per api_key", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    for (let i = 0; i < 25; i++) {
      await seed.suppression({ apiKeyId, email: `u${i}@example.com`, reason: "manual" });
    }
    const page1 = await listSuppressions(apiKeyId, { page: 1, limit: 10 });
    expect(page1.data).toHaveLength(10);
    expect(page1.total).toBe(25);
    const page3 = await listSuppressions(apiKeyId, { page: 3, limit: 10 });
    expect(page3.data).toHaveLength(5);
    expect(page3.total).toBe(25);
  });

  test("listSuppressions email filter does exact match (case-folded)", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.suppression({ apiKeyId, email: "alice@example.com", reason: "manual" });
    await seed.suppression({ apiKeyId, email: "bob@example.com", reason: "manual" });
    const result = await listSuppressions(apiKeyId, {
      page: 1,
      limit: 20,
      email: "ALICE@example.com",
    });
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.email).toBe("alice@example.com");
  });

  test("getSuppressionById is scoped — different api key returns undefined", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: supId } = await seed.suppression({
      apiKeyId: keyA,
      email: "a@example.com",
      reason: "manual",
    });
    expect(await getSuppressionById(supId, keyA)).toBeDefined();
    expect(await getSuppressionById(supId, keyB)).toBeUndefined();
  });

  test("deleteSuppression returns the deleted row and is scoped", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: supId } = await seed.suppression({
      apiKeyId: keyA,
      email: "a@example.com",
      reason: "manual",
    });
    /** Wrong key — no-op. */
    expect(await deleteSuppression(supId, keyB)).toBeUndefined();
    expect(await getSuppressionById(supId, keyA)).toBeDefined();
    /** Right key — deletes. */
    const deleted = await deleteSuppression(supId, keyA);
    expect(deleted?.id).toBe(supId);
    expect(await getSuppressionById(supId, keyA)).toBeUndefined();
  });
});
