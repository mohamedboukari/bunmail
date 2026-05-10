/**
 * Integration tests for the email tombstone audit trail (#34).
 *
 * Five hard-delete code paths in the codebase write a tombstone
 * before they DELETE — this file exercises all of them and confirms:
 *
 *   1. Every hard-delete leaves exactly one tombstone with the right
 *      identifiers (id, messageId, to, subject, status, sentAt) and
 *      drops the body bytes (html / text not retained).
 *   2. The tombstone survives the parent api key being deleted (no
 *      FK cascade — the snapshot must outlive the api_key row, which
 *      is exactly the audit-trail use case).
 *   3. Read API filters by messageId, with-and-without angle-bracket
 *      wrapping (operators paste from logs / DSNs that vary).
 *   4. Retention sweep deletes tombstones older than the cutoff,
 *      keeping fresh ones.
 *   5. Atomicity — recording + deleting is one transaction.
 *
 * Outbound-only by design (#34 acceptance criteria); inbound
 * tombstones are not modelled.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { config } from "../../src/config.ts";
import {
  permanentDeleteEmail,
  emptyEmailsTrash,
  permanentDeleteEmailUnscoped,
  emptyEmailsTrashUnscoped,
} from "../../src/modules/emails/services/email.service.ts";
import {
  listTombstones,
  listAllTombstones,
  getTombstoneById,
  purgeOldTombstones,
} from "../../src/modules/emails/services/tombstone.service.ts";
import {
  runTrashPurge,
  runTombstoneRetention,
} from "../../src/modules/trash/services/purge.service.ts";
import { emailTombstones } from "../../src/modules/emails/models/email-tombstone.schema.ts";
import { apiKeys } from "../../src/modules/api-keys/models/api-key.schema.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

/** Soft-delete a freshly-seeded email with `deletedAt` further back than now,
 *  so callers can drive the trash purge / replay paths deterministically. */
async function trashEmail(id: string, deletedAt: Date) {
  await db.update(emails).set({ deletedAt }).where(eq(emails.id, id));
}

/** Convenience: stamp a sentAt + messageId on a fresh row so tombstones
 *  carry meaningful payloads. */
async function fillSentMetadata(
  id: string,
  messageId: string,
  sentAt: Date = new Date(),
) {
  await db
    .update(emails)
    .set({ messageId, sentAt, status: "sent" })
    .where(eq(emails.id, id));
}

describe("permanentDeleteEmail (per-row API path)", () => {
  test("writes a tombstone with full identifiers, drops the original row", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: emailId } = await seed.email({
      apiKeyId,
      toAddress: "user@example.com",
      subject: "Welcome",
      messageId: "<welcome-001@example.com>",
      status: "sent",
    });
    /** Trash it so the per-row hard-delete is allowed (only acts on
     *  rows already in trash). */
    await trashEmail(emailId, new Date(Date.now() - 24 * 60 * 60 * 1000));

    const result = await permanentDeleteEmail(emailId, apiKeyId);
    expect(result?.id).toBe(emailId);

    /** Original row gone. */
    const [stillThere] = await db.select().from(emails).where(eq(emails.id, emailId));
    expect(stillThere).toBeUndefined();

    /** Tombstone exists with the expected snapshot. */
    const [tombstone] = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.id, emailId));
    expect(tombstone).toBeDefined();
    expect(tombstone?.id).toBe(emailId);
    expect(tombstone?.apiKeyId).toBe(apiKeyId);
    expect(tombstone?.messageId).toBe("<welcome-001@example.com>");
    expect(tombstone?.toAddress).toBe("user@example.com");
    expect(tombstone?.subject).toBe("Welcome");
    expect(tombstone?.status).toBe("sent");
    expect(tombstone?.deletedAt).not.toBeNull();
    /** Body bytes are NOT preserved — by design. The tombstone schema
     *  has no `html` / `text_content` columns; if it did, this test
     *  would catch the regression. */
    expect("html" in (tombstone ?? {})).toBe(false);
  });

  test("returns undefined when the row is not in trash (no tombstone)", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: emailId } = await seed.email({ apiKeyId, status: "sent" });
    /** NOT trashed — the gate refuses. */
    const result = await permanentDeleteEmail(emailId, apiKeyId);
    expect(result).toBeUndefined();
    const tomb = await db.select().from(emailTombstones);
    expect(tomb).toHaveLength(0);
  });

  test("scoped per api_key — wrong key, no delete, no tombstone", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: emailId } = await seed.email({ apiKeyId: keyA, status: "sent" });
    await trashEmail(emailId, new Date(Date.now() - 24 * 60 * 60 * 1000));

    /** Wrong key — no-op. */
    const result = await permanentDeleteEmail(emailId, keyB);
    expect(result).toBeUndefined();
    const [stillThere] = await db.select().from(emails).where(eq(emails.id, emailId));
    expect(stillThere).toBeDefined();
    const tomb = await db.select().from(emailTombstones);
    expect(tomb).toHaveLength(0);
  });
});

describe("emptyEmailsTrash (bulk per-tenant)", () => {
  test("writes one tombstone per deleted row, scoped to the tenant", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: e1 } = await seed.email({ apiKeyId, toAddress: "a@example.com" });
    const { id: e2 } = await seed.email({ apiKeyId, toAddress: "b@example.com" });
    /** Untrashed control row — should NOT be touched. */
    const { id: e3 } = await seed.email({ apiKeyId, toAddress: "c@example.com" });

    await trashEmail(e1, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await trashEmail(e2, new Date(Date.now() - 24 * 60 * 60 * 1000));

    const deleted = await emptyEmailsTrash(apiKeyId);
    expect(deleted).toBe(2);

    const tombstones = await db.select().from(emailTombstones);
    expect(tombstones).toHaveLength(2);
    expect(new Set(tombstones.map((t) => t.id))).toEqual(new Set([e1, e2]));

    /** Untrashed row still alive. */
    const [survivor] = await db.select().from(emails).where(eq(emails.id, e3));
    expect(survivor).toBeDefined();
  });

  test("scopes to api_key — another tenant's trashed rows are untouched", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: aTrashed } = await seed.email({ apiKeyId: keyA });
    const { id: bTrashed } = await seed.email({ apiKeyId: keyB });
    await trashEmail(aTrashed, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await trashEmail(bTrashed, new Date(Date.now() - 24 * 60 * 60 * 1000));

    /** A empties their trash — B's rows untouched. */
    const deleted = await emptyEmailsTrash(keyA);
    expect(deleted).toBe(1);

    const aTomb = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.apiKeyId, keyA));
    expect(aTomb).toHaveLength(1);

    const bTomb = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.apiKeyId, keyB));
    expect(bTomb).toHaveLength(0);

    const [bStillThere] = await db.select().from(emails).where(eq(emails.id, bTrashed));
    expect(bStillThere).toBeDefined();
  });
});

describe("permanentDeleteEmailUnscoped + emptyEmailsTrashUnscoped (dashboard paths)", () => {
  test("dashboard per-row: writes tombstone with the email's original api_key", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: emailId } = await seed.email({ apiKeyId });
    await trashEmail(emailId, new Date(Date.now() - 24 * 60 * 60 * 1000));

    const result = await permanentDeleteEmailUnscoped(emailId);
    expect(result?.id).toBe(emailId);

    const [tomb] = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.id, emailId));
    expect(tomb?.apiKeyId).toBe(apiKeyId);
  });

  test("dashboard empty-all: tombstones for every deleted row across all keys", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: e1 } = await seed.email({ apiKeyId: keyA });
    const { id: e2 } = await seed.email({ apiKeyId: keyB });
    await trashEmail(e1, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await trashEmail(e2, new Date(Date.now() - 24 * 60 * 60 * 1000));

    const deleted = await emptyEmailsTrashUnscoped();
    expect(deleted).toBe(2);

    const all = await db.select().from(emailTombstones);
    expect(all).toHaveLength(2);
    /** Snapshot api keys preserved on the right rows. */
    const aTomb = all.find((t) => t.id === e1);
    const bTomb = all.find((t) => t.id === e2);
    expect(aTomb?.apiKeyId).toBe(keyA);
    expect(bTomb?.apiKeyId).toBe(keyB);
  });
});

describe("runTrashPurge (periodic sweep)", () => {
  test("hard-deletes aged-out trashed rows, writes tombstones for each", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: oldId } = await seed.email({ apiKeyId });
    const { id: freshId } = await seed.email({ apiKeyId });

    /** old: well past TRASH_RETENTION_DAYS. fresh: just trashed today. */
    const longAgo = new Date(
      Date.now() - (config.trash.retentionDays + 1) * 24 * 60 * 60 * 1000,
    );
    await trashEmail(oldId, longAgo);
    await trashEmail(freshId, new Date());

    const result = await runTrashPurge();
    expect(result.emailsPurged).toBe(1);

    /** Old: gone, tombstoned. Fresh: still in trash. */
    const [oldGone] = await db.select().from(emails).where(eq(emails.id, oldId));
    expect(oldGone).toBeUndefined();
    const [oldTomb] = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.id, oldId));
    expect(oldTomb).toBeDefined();

    const [freshStill] = await db.select().from(emails).where(eq(emails.id, freshId));
    expect(freshStill).toBeDefined();
    const [freshTomb] = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.id, freshId));
    expect(freshTomb).toBeUndefined();
  });
});

describe("tombstone snapshots survive api_key deletion", () => {
  test("CASCADE on api_keys.delete drops emails but tombstones stay", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: emailId } = await seed.email({ apiKeyId });
    await fillSentMetadata(emailId, "<survives@example.com>");
    await trashEmail(emailId, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await permanentDeleteEmail(emailId, apiKeyId);

    /** Tombstone exists. */
    const [before] = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.id, emailId));
    expect(before).toBeDefined();

    /** Delete the api_key — emails CASCADE-deletes (no rows there
     *  anyway; the email was already hard-deleted), but tombstones
     *  must NOT cascade. The whole point is the audit trail outliving
     *  the parent. */
    await db.delete(apiKeys).where(eq(apiKeys.id, apiKeyId));

    const [after] = await db
      .select()
      .from(emailTombstones)
      .where(eq(emailTombstones.id, emailId));
    expect(after).toBeDefined();
    expect(after?.messageId).toBe("<survives@example.com>");
    /** apiKeyId is preserved as a snapshot even though the parent row is gone. */
    expect(after?.apiKeyId).toBe(apiKeyId);
  });
});

describe("listTombstones / getTombstoneById — read API", () => {
  test("filters by messageId, accepts both wrapped and unwrapped forms", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: e1 } = await seed.email({ apiKeyId });
    await fillSentMetadata(e1, "<unique-trace-001@example.com>");
    await trashEmail(e1, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await permanentDeleteEmail(e1, apiKeyId);

    /** Operator pastes the wrapped form (out of an SMTP log). */
    const wrappedHit = await listTombstones({
      apiKeyId,
      messageId: "<unique-trace-001@example.com>",
      page: 1,
      limit: 20,
    });
    expect(wrappedHit.total).toBe(1);
    expect(wrappedHit.data[0]?.id).toBe(e1);

    /** Operator pastes the unwrapped form (out of a DSN body). */
    const unwrappedHit = await listTombstones({
      apiKeyId,
      messageId: "unique-trace-001@example.com",
      page: 1,
      limit: 20,
    });
    expect(unwrappedHit.total).toBe(1);

    /** Unrelated id — no match. */
    const miss = await listTombstones({
      apiKeyId,
      messageId: "nope@example.com",
      page: 1,
      limit: 20,
    });
    expect(miss.total).toBe(0);
  });

  test("scopes per api_key — strangers see nothing", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: emailId } = await seed.email({ apiKeyId: keyA });
    await trashEmail(emailId, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await permanentDeleteEmail(emailId, keyA);

    const owner = await listTombstones({ apiKeyId: keyA, page: 1, limit: 20 });
    expect(owner.total).toBe(1);

    const stranger = await listTombstones({ apiKeyId: keyB, page: 1, limit: 20 });
    expect(stranger.total).toBe(0);

    /** Cross-tenant getById returns undefined. */
    const ownerGet = await getTombstoneById({ id: emailId, apiKeyId: keyA });
    expect(ownerGet?.id).toBe(emailId);
    const strangerGet = await getTombstoneById({ id: emailId, apiKeyId: keyB });
    expect(strangerGet).toBeUndefined();
  });

  test("listAllTombstones (dashboard) returns across all tenants", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: e1 } = await seed.email({ apiKeyId: keyA });
    const { id: e2 } = await seed.email({ apiKeyId: keyB });
    await trashEmail(e1, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await trashEmail(e2, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await permanentDeleteEmail(e1, keyA);
    await permanentDeleteEmail(e2, keyB);

    const all = await listAllTombstones({ page: 1, limit: 20 });
    expect(all.total).toBe(2);
  });
});

describe("retention cleanup — purgeOldTombstones / runTombstoneRetention", () => {
  test("purges tombstones older than the cutoff, keeps fresh ones", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: oldId } = await seed.email({ apiKeyId });
    const { id: freshId } = await seed.email({ apiKeyId });
    await trashEmail(oldId, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await trashEmail(freshId, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await permanentDeleteEmail(oldId, apiKeyId);
    await permanentDeleteEmail(freshId, apiKeyId);

    /** Backdate one tombstone to 100 days ago. */
    const longAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await db
      .update(emailTombstones)
      .set({ purgedAt: longAgo })
      .where(eq(emailTombstones.id, oldId));

    const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const result = await purgeOldTombstones({ olderThan: cutoff });
    expect(result.deleted).toBe(1);

    const survivors = await db.select().from(emailTombstones);
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(freshId);
  });

  test("runTombstoneRetention: end-to-end via the public sweep helper", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: emailId } = await seed.email({ apiKeyId });
    await trashEmail(emailId, new Date(Date.now() - 24 * 60 * 60 * 1000));
    await permanentDeleteEmail(emailId, apiKeyId);

    /** Backdate by tombstoneRetentionDays + 1 days. */
    const beyond = new Date(
      Date.now() - (config.trash.tombstoneRetentionDays + 1) * 24 * 60 * 60 * 1000,
    );
    await db.update(emailTombstones).set({ purgedAt: beyond });

    const result = await runTombstoneRetention();
    expect(result.deleted).toBe(1);
    const after = await db.select().from(emailTombstones);
    expect(after).toHaveLength(0);
  });
});

describe("atomicity — tombstone INSERT + emails DELETE in one transaction", () => {
  test("the row count of tombstones matches the row count of deletes for the same WHERE", async () => {
    /** Indirect check: there's no easy way to inject a mid-transaction
     *  failure into Drizzle, but we can at least verify that for a
     *  bulk operation with N target rows, N tombstones are created
     *  and 0 emails remain matching the WHERE. */
    const { id: apiKeyId } = await seed.apiKey();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const { id } = await seed.email({ apiKeyId });
      ids.push(id);
      await trashEmail(id, new Date(Date.now() - 24 * 60 * 60 * 1000));
    }

    const deleted = await emptyEmailsTrash(apiKeyId);
    expect(deleted).toBe(10);

    const tombs = await db.select().from(emailTombstones);
    expect(tombs).toHaveLength(10);
    const remaining = await db.select().from(emails);
    expect(remaining).toHaveLength(0);
  });
});
