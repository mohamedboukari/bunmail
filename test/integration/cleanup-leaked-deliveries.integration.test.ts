/**
 * Migration 0014 removes webhook deliveries that reached the wrong API key
 * before dispatch was scoped to the key that owns the email (#226).
 *
 * The test seeds legitimate and leaked deliveries side by side, runs the
 * migration's SQL against real Postgres, and checks that exactly the
 * leaked rows are gone.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "path";
import { sql } from "drizzle-orm";
import { enqueueDelivery } from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { emailTombstones } from "../../src/modules/emails/models/email-tombstone.schema.ts";
import { truncateAll, seed, db } from "./_helpers.ts";

const MIGRATION = join(
  import.meta.dir,
  "..",
  "..",
  "drizzle",
  "0014_cleanup_leaked_webhook_deliveries.sql",
);

/** Runs the migration file the way the runner does: split at breakpoints. */
async function runMigration(): Promise<void> {
  const text = await Bun.file(MIGRATION).text();
  for (const statement of text.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.execute(sql.raw(statement));
  }
}

function deliver(
  webhookId: string,
  event: "email.sent" | "email.bounced" | "email.received",
  data: Record<string, string>,
) {
  return enqueueDelivery({
    webhookId,
    envelope: { event, timestamp: "2026-05-10T12:00:00.000Z", data },
  });
}

beforeEach(async () => {
  await truncateAll();
});

describe("migration 0014: cleanup of leaked webhook deliveries", () => {
  test("removes exactly the deliveries that reached another key", async () => {
    const tenantA = await seed.apiKey({ isAdmin: false });
    const tenantB = await seed.apiKey({ isAdmin: false });
    const admin = await seed.apiKey({ isAdmin: true });

    const hookA = await seed.webhook({
      apiKeyId: tenantA.id,
      url: "https://93.184.216.34/a",
      events: ["email.sent", "email.bounced"],
    });
    const hookB = await seed.webhook({
      apiKeyId: tenantB.id,
      url: "https://93.184.216.34/b",
      events: ["email.sent", "email.bounced", "email.received"],
    });
    const hookAdmin = await seed.webhook({
      apiKeyId: admin.id,
      url: "https://93.184.216.34/admin",
      events: ["email.received"],
    });

    const liveEmail = await seed.email({ apiKeyId: tenantA.id });
    /** A purged email of tenant A: only its tombstone remains. */
    const purgedId = "msg_purged0000000000000000";
    await db.insert(emailTombstones).values({
      id: purgedId,
      apiKeyId: tenantA.id,
      fromAddress: "hello@example.com",
      toAddress: "user@example.com",
      status: "sent",
    });

    const keep = [
      await deliver(hookA.id, "email.sent", { emailId: liveEmail.id }),
      await deliver(hookA.id, "email.bounced", { emailId: purgedId }),
      await deliver(hookAdmin.id, "email.received", { inboundEmailId: "inb_1" }),
    ];
    const leaked = [
      await deliver(hookB.id, "email.sent", { emailId: liveEmail.id }),
      await deliver(hookB.id, "email.bounced", { emailId: purgedId }),
      /** Owner can no longer be resolved: removed too. */
      await deliver(hookA.id, "email.sent", { emailId: "msg_gone000000000000000000" }),
      /** Inbound mail on a restricted key's webhook. */
      await deliver(hookB.id, "email.received", { inboundEmailId: "inb_1" }),
    ];

    await runMigration();

    const remaining = await db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries);
    expect(remaining.map((r) => r.id).toSorted()).toEqual(
      keep.map((r) => r.id).toSorted(),
    );
    for (const { id } of leaked) {
      expect(remaining.map((r) => r.id)).not.toContain(id);
    }
  });

  test("is a no-op when nothing leaked", async () => {
    const tenant = await seed.apiKey();
    const hook = await seed.webhook({
      apiKeyId: tenant.id,
      url: "https://93.184.216.34/a",
      events: ["email.sent"],
    });
    const email = await seed.email({ apiKeyId: tenant.id });
    await deliver(hook.id, "email.sent", { emailId: email.id });

    await runMigration();

    expect(await db.select().from(webhookDeliveries)).toHaveLength(1);
  });
});
