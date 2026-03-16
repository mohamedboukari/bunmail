import { describe, test, expect } from "bun:test";
import { serializeInboundEmail } from "../../src/modules/inbound/serializations/inbound.serialization.ts";

/**
 * Unit tests for inbound email serialization.
 *
 * Verifies that internal fields (rawMessage, createdAt) are stripped
 * and field names are mapped to consumer-friendly format.
 */

describe("serializeInboundEmail", () => {
  const email = {
    id: "inb_abc123",
    fromAddress: "sender@example.com",
    toAddress: "inbox@bunmail.dev",
    subject: "Hello from outside",
    html: "<p>Hi there</p>",
    textContent: "Hi there",
    rawMessage: "From: sender@example.com\r\nTo: inbox@bunmail.dev\r\n...",
    receivedAt: new Date("2024-06-01"),
  };

  test("maps fromAddress to from", () => {
    const result = serializeInboundEmail(email);
    expect(result.from).toBe("sender@example.com");
  });

  test("maps toAddress to to", () => {
    const result = serializeInboundEmail(email);
    expect(result.to).toBe("inbox@bunmail.dev");
  });

  test("maps textContent to text", () => {
    const result = serializeInboundEmail(email);
    expect(result.text).toBe("Hi there");
  });

  test("strips rawMessage from output", () => {
    const result = serializeInboundEmail(email);
    expect("rawMessage" in result).toBe(false);
  });

  test("strips createdAt from output", () => {
    const result = serializeInboundEmail(email);
    expect("createdAt" in result).toBe(false);
  });

  test("includes all expected public fields", () => {
    const result = serializeInboundEmail(email);
    expect(result.id).toBe("inb_abc123");
    expect(result.from).toBe("sender@example.com");
    expect(result.to).toBe("inbox@bunmail.dev");
    expect(result.subject).toBe("Hello from outside");
    expect(result.html).toBe("<p>Hi there</p>");
    expect(result.receivedAt).toEqual(new Date("2024-06-01"));
  });

  test("handles null subject, html, textContent", () => {
    const result = serializeInboundEmail({
      ...email,
      subject: null,
      html: null,
      textContent: null,
    });
    expect(result.subject).toBeNull();
    expect(result.html).toBeNull();
    expect(result.text).toBeNull();
  });
});
