/**
 * `email.queued` (#371), against a real Postgres: every accepted send
 * writes exactly one `email.queued` delivery for each subscribed webhook
 * of the sending key, in the same transaction as the email row. It was
 * documented and subscribable since webhooks shipped, but never fired.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createEmail,
  createEmailIdempotent,
} from "../../src/modules/emails/services/email.service.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { truncateAll, seed, db } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

/** The `email.queued` deliveries of one webhook, with their parsed bodies. */
async function queuedDeliveries(
  webhookId: string,
): Promise<{ event: string; data: Record<string, unknown> }[]> {
  const rows = await db
    .select({ event: webhookDeliveries.event, payload: webhookDeliveries.payload })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, webhookId));
  return rows
    .filter((row) => row.event === "email.queued")
    .map((row) => {
      const body: unknown = JSON.parse(row.payload);
      const data: unknown =
        typeof body === "object" && body !== null ? Reflect.get(body, "data") : undefined;
      return {
        event: row.event,
        data: typeof data === "object" && data !== null ? { ...data } : {},
      };
    });
}

async function setup(): Promise<{
  apiKeyId: string;
  from: string;
  subscribed: string;
  otherEvents: string;
  otherKey: string;
}> {
  const { id: apiKeyId } = await seed.apiKey();
  const { id: otherKeyId } = await seed.apiKey();
  const { name } = await seed.domain();
  const url = "https://hooks.example.com/bunmail";
  const subscribed = await seed.webhook({ apiKeyId, url, events: ["email.queued"] });
  const otherEvents = await seed.webhook({ apiKeyId, url, events: ["email.sent"] });
  const otherKey = await seed.webhook({
    apiKeyId: otherKeyId,
    url,
    events: ["email.queued"],
  });
  return {
    apiKeyId,
    from: `hello@${name}`,
    subscribed: subscribed.id,
    otherEvents: otherEvents.id,
    otherKey: otherKey.id,
  };
}

describe("email.queued (#371)", () => {
  test("a send writes one email.queued delivery, only for the key's subscribed webhook", async () => {
    const ctx = await setup();
    const { email } = await createEmail(
      {
        from: ctx.from,
        to: "user@example.org",
        subject: "Order 42",
        text: "hi",
        tags: { order: "42" },
      },
      ctx.apiKeyId,
    );

    const deliveries = await queuedDeliveries(ctx.subscribed);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.data).toEqual({
      emailId: email.id,
      from: ctx.from,
      to: "user@example.org",
      subject: "Order 42",
      tags: { order: "42" },
      source: "api",
    });
    expect(await queuedDeliveries(ctx.otherEvents)).toHaveLength(0);
    expect(await queuedDeliveries(ctx.otherKey)).toHaveLength(0);
  });

  test("an SMTP-submitted send says so in source", async () => {
    const ctx = await setup();
    await createEmail(
      { from: ctx.from, to: "user@example.org", subject: "s", text: "x" },
      ctx.apiKeyId,
      "smtp",
    );
    const [delivery] = await queuedDeliveries(ctx.subscribed);
    expect(delivery?.data["source"]).toBe("smtp");
  });

  test("a refused send writes no event", async () => {
    const ctx = await setup();
    await seed.suppression({ apiKeyId: ctx.apiKeyId, email: "blocked@example.org" });
    let thrown: unknown;
    try {
      await createEmail(
        { from: ctx.from, to: "blocked@example.org", subject: "s", text: "x" },
        ctx.apiKeyId,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SuppressedRecipientError);
    expect(await queuedDeliveries(ctx.subscribed)).toHaveLength(0);
  });

  test("an idempotent retry replays the send without a second event", async () => {
    const ctx = await setup();
    const input = { from: ctx.from, to: "user@example.org", subject: "s", text: "x" };
    const respond = (created: { email: { id: string } }) => ({
      status: 200,
      body: { success: true, data: { id: created.email.id } },
    });
    const first = await createEmailIdempotent(input, ctx.apiKeyId, "key-371", respond);
    const second = await createEmailIdempotent(input, ctx.apiKeyId, "key-371", respond);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(await queuedDeliveries(ctx.subscribed)).toHaveLength(1);
  });
});
