import { describe, test, expect } from "bun:test";
import { serializeWebhook } from "../../src/modules/webhooks/serializations/webhook.serialization.ts";

/**
 * Unit tests for webhook serialization.
 *
 * Verifies that internal fields (apiKeyId, secret, updatedAt) are stripped
 * and only public fields are exposed.
 */

describe("serializeWebhook", () => {
  const webhook = {
    id: "wh_abc123",
    apiKeyId: "key_secret123",
    url: "https://example.com/hooks",
    events: ["email.sent", "email.failed"],
    secret: "whsec_supersecret",
    isActive: true,
    createdAt: new Date("2024-06-01"),
    updatedAt: new Date("2024-06-02"),
  };

  test("strips secret from output", () => {
    const result = serializeWebhook(webhook);
    expect("secret" in result).toBe(false);
  });

  test("strips apiKeyId from output", () => {
    const result = serializeWebhook(webhook);
    expect("apiKeyId" in result).toBe(false);
  });

  test("strips updatedAt from output", () => {
    const result = serializeWebhook(webhook);
    expect("updatedAt" in result).toBe(false);
  });

  test("includes all expected public fields", () => {
    const result = serializeWebhook(webhook);
    expect(result.id).toBe("wh_abc123");
    expect(result.url).toBe("https://example.com/hooks");
    expect(result.isActive).toBe(true);
    expect(result.createdAt).toEqual(new Date("2024-06-01"));
  });

  test("preserves events array correctly", () => {
    const result = serializeWebhook(webhook);
    expect(result.events).toEqual(["email.sent", "email.failed"]);
  });
});
