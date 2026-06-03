import { describe, test, expect } from "bun:test";
import { buildInboundNotification } from "../../src/modules/inbound/services/inbound-notify.service.ts";

/**
 * Unit tests for the pure notification-builder (#106). The orchestrator
 * `notifyInboundReceived` does DB + SMTP I/O and is covered by manual /
 * integration verification; the builder is the part with branching logic
 * worth pinning down, and it has no dependencies to mock.
 */
describe("buildInboundNotification", () => {
  const base = {
    to: "hello@example.com",
    from: "sender@somewhere.com",
    subject: "Question about pricing",
    text: "Hi there, I wanted to ask about your pricing tiers.",
    detailUrl: "https://mail.example.com/dashboard/inbound/inb_123",
  };

  test("subject carries recipient + original subject", () => {
    const { subject } = buildInboundNotification(base);
    expect(subject).toBe("New email at hello@example.com: Question about pricing");
  });

  test("falls back to (no subject) when subject is null/blank", () => {
    expect(buildInboundNotification({ ...base, subject: null }).subject).toBe(
      "New email at hello@example.com: (no subject)",
    );
    expect(buildInboundNotification({ ...base, subject: "   " }).subject).toBe(
      "New email at hello@example.com: (no subject)",
    );
  });

  test("text + html include sender, subject and preview", () => {
    const { text, html } = buildInboundNotification(base);
    for (const part of [text, html]) {
      expect(part).toContain("sender@somewhere.com");
      expect(part).toContain("Question about pricing");
      expect(part).toContain("I wanted to ask about your pricing tiers");
    }
  });

  test("includes the dashboard link only when detailUrl is provided", () => {
    const withLink = buildInboundNotification(base);
    expect(withLink.text).toContain(base.detailUrl);
    expect(withLink.html).toContain(base.detailUrl);

    const without = buildInboundNotification({ ...base, detailUrl: null });
    expect(without.text).not.toContain("dashboard/inbound");
    expect(without.html).not.toContain("dashboard/inbound");
  });

  test("collapses whitespace and truncates the preview to 200 chars + ellipsis", () => {
    const long = "word ".repeat(100); // 500 chars, lots of whitespace
    const { text } = buildInboundNotification({ ...base, text: long });
    /** The body line is collapsed to single spaces and capped. */
    const previewLine = text.split("\n").find((l) => l.startsWith("word word"));
    expect(previewLine).toBeDefined();
    expect(previewLine!.endsWith("…")).toBe(true);
    // 200 visible chars + the ellipsis (trimEnd may drop a trailing space first)
    expect(previewLine!.length).toBeLessThanOrEqual(201);
  });

  test("omits the preview block when there is no text body", () => {
    const { text } = buildInboundNotification({ ...base, text: null });
    expect(text).toContain("From:    sender@somewhere.com");
    expect(text).toContain("Subject: Question about pricing");
    /** No stray empty preview content beyond the structured lines. */
    expect(text).not.toContain("I wanted to ask");
  });

  test("HTML-escapes attacker-controlled fields in the html part", () => {
    const { html } = buildInboundNotification({
      ...base,
      from: "<script>alert(1)</script>@evil.com",
      subject: "<img src=x onerror=alert(1)>",
      text: "<b>bold</b> & dangerous",
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&amp; dangerous");
  });
});
