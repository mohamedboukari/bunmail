import { describe, test, expect } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { createWebhookDto } from "../../src/modules/webhooks/dtos/create-webhook.dto.ts";
import { listEmailEventsDto } from "../../src/modules/emails/dtos/list-email-events.dto.ts";
import { serializeEmailEvent } from "../../src/modules/emails/serializations/email-event.serialization.ts";
import type { EmailEvent } from "../../src/modules/emails/services/email-events.service.ts";
import {
  EngagementBadges,
  TrackingTimeline,
} from "../../src/pages/components/email-tracking.tsx";

/**
 * Open and click tracking, part 3 (#187): the webhook event names, the
 * events API's query and serializer, and the dashboard's badges and
 * timeline (escaping included).
 */

const event: EmailEvent = {
  id: "evt_0123456789abcdef01234567",
  emailId: "msg_0123456789abcdef01234567",
  apiKeyId: "key_0123456789abcdef01234567",
  type: "click",
  linkPosition: 1,
  url: "https://example.com/pricing",
  clientKind: "unknown",
  machine: false,
  occurredAt: new Date("2026-11-07T10:05:00Z"),
};

describe("webhook events", () => {
  const check = TypeCompiler.Compile(createWebhookDto);

  test("email.opened and email.clicked can be subscribed to", () => {
    expect(
      check.Check({
        url: "https://example.com/h",
        events: ["email.opened", "email.clicked"],
      }),
    ).toBe(true);
    expect(check.Check({ url: "https://example.com/h", events: ["email.viewed"] })).toBe(
      false,
    );
  });
});

describe("events API", () => {
  test("the query takes page and limit, at most 100", () => {
    const check = TypeCompiler.Compile(listEmailEventsDto);
    expect(check.Check({})).toBe(true);
    expect(check.Check({ page: 2, limit: 100 })).toBe(true);
    expect(check.Check({ limit: 101 })).toBe(false);
    expect(check.Check({ page: 0 })).toBe(false);
  });

  test("the serializer keeps no internal id", () => {
    expect(serializeEmailEvent(event)).toEqual({
      type: "click",
      occurredAt: new Date("2026-11-07T10:05:00Z"),
      url: "https://example.com/pricing",
      linkPosition: 1,
      clientKind: "unknown",
      machine: false,
    });
  });
});

describe("dashboard components", () => {
  test("badges from the first open and click", async () => {
    expect(
      await EngagementBadges({ email: { firstOpenedAt: null, firstClickedAt: null } }),
    ).toBe("");
    const both = await EngagementBadges({
      email: { firstOpenedAt: new Date(), firstClickedAt: new Date() },
    });
    expect(both).toContain("Opened");
    expect(both).toContain("Clicked");
    const opened = await EngagementBadges({
      email: { firstOpenedAt: new Date(), firstClickedAt: null },
    });
    expect(opened).not.toContain("Clicked");
  });

  test("the timeline: UTC time, type, link, client, automated badge, caveat", async () => {
    const html = await TrackingTimeline({
      email: { trackOpens: true, trackClicks: true },
      events: [
        {
          ...event,
          type: "open",
          url: null,
          linkPosition: null,
          clientKind: "image_proxy",
          machine: true,
        },
        event,
      ],
    });
    expect(html).toContain("2026-11-07 10:05:00 UTC");
    expect(html).toContain("Tracks opens and clicks.");
    expect(html).toContain("Image proxy");
    expect(html).toContain("Likely automated");
    expect(html).toContain("https://example.com/pricing");
    expect(html).toContain("Apple Mail Privacy Protection");
  });

  test("a hostile URL is escaped", async () => {
    const html = await TrackingTimeline({
      email: { trackOpens: false, trackClicks: true },
      events: [{ ...event, url: `https://e.example/"><img src=x onerror=alert(1)>` }],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("nothing for an untracked email without events; a note when tracked without events", async () => {
    expect(
      await TrackingTimeline({
        email: { trackOpens: false, trackClicks: false },
        events: [],
      }),
    ).toBe("");
    expect(
      await TrackingTimeline({
        email: { trackOpens: true, trackClicks: false },
        events: [],
      }),
    ).toContain("No opens or clicks recorded.");
  });
});
