import { describe, test, expect } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { createWebhookDto } from "../../src/modules/webhooks/dtos/create-webhook.dto.ts";
import {
  WEBHOOK_EVENT_TYPES,
  isWebhookEventType,
} from "../../src/modules/webhooks/types/webhook.types.ts";
import { WebhooksPage } from "../../src/pages/routes/webhooks.tsx";

/**
 * One list of webhook event types (#425): the REST create DTO and the
 * dashboard's create form both come from `WEBHOOK_EVENT_TYPES`, so an event
 * BunMail fires can never again be missing from either.
 */

describe("WEBHOOK_EVENT_TYPES", () => {
  test("lists every event BunMail fires, once", () => {
    expect([...WEBHOOK_EVENT_TYPES]).toEqual([
      "email.queued",
      "email.sent",
      "email.failed",
      "email.bounced",
      "email.complained",
      "email.received",
      "email.unsubscribed",
      "email.opened",
      "email.clicked",
      "domain.verified",
      "domain.verification_failed",
    ]);
    expect(new Set(WEBHOOK_EVENT_TYPES).size).toBe(WEBHOOK_EVENT_TYPES.length);
  });
});

describe("isWebhookEventType (#437)", () => {
  test("accepts every listed event type", () => {
    for (const event of WEBHOOK_EVENT_TYPES) {
      expect(isWebhookEventType(event)).toBe(true);
    }
  });

  test("refuses unknown names, a different case, padding and the empty string", () => {
    for (const value of [
      "email.viewed",
      "Email.Sent",
      " email.sent",
      "email.sent ",
      "",
      "email",
    ]) {
      expect(isWebhookEventType(value)).toBe(false);
    }
  });
});

describe("REST create DTO", () => {
  /** Compiled once: the same TypeBox check Elysia runs on the request body. */
  const check = TypeCompiler.Compile(createWebhookDto);

  test("accepts each event type on its own, and all of them together", () => {
    for (const event of WEBHOOK_EVENT_TYPES) {
      expect(check.Check({ url: "https://example.com/h", events: [event] })).toBe(true);
    }
    expect(
      check.Check({ url: "https://example.com/h", events: [...WEBHOOK_EVENT_TYPES] }),
    ).toBe(true);
  });

  test("still refuses an unknown event and an empty list", () => {
    expect(check.Check({ url: "https://example.com/h", events: ["email.viewed"] })).toBe(
      false,
    );
    expect(check.Check({ url: "https://example.com/h", events: [] })).toBe(false);
  });

  test("keeps the contract: a union of one string literal per event", () => {
    /** The OpenAPI document shows this schema, so its shape must not change. */
    expect(createWebhookDto.properties.events.items.anyOf).toEqual(
      WEBHOOK_EVENT_TYPES.map((event) =>
        expect.objectContaining({ type: "string", const: event }),
      ),
    );
  });
});

describe("dashboard create form", () => {
  test("renders one events checkbox per event type", async () => {
    const html = await WebhooksPage({ webhooks: [], creators: new Map() });
    for (const event of WEBHOOK_EVENT_TYPES) {
      expect(html).toContain(`name="events" value="${event}"`);
    }
    /** Exactly one checkbox each: nothing hand-written on the side. */
    expect(html.match(/name="events"/g)).toHaveLength(WEBHOOK_EVENT_TYPES.length);
  });

  test("lists email.complained and email.received, the two it once missed", async () => {
    const html = await WebhooksPage({ webhooks: [], creators: new Map() });
    expect(html).toContain('value="email.complained"');
    expect(html).toContain('value="email.received"');
  });
});
