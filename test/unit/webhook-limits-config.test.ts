import { describe, test, expect } from "bun:test";
import {
  readWebhookDeliveryRetentionDays,
  readWebhooksMaxPerApiKey,
} from "../../src/config.ts";

/**
 * Webhook limits env vars (#258): `WEBHOOKS_MAX_PER_API_KEY` (1 to 100,
 * default 10) and `WEBHOOK_DELIVERY_RETENTION_DAYS` (1 to 365, default
 * 30) default when unset and refuse to boot on anything but a whole
 * number in range.
 */
describe("readWebhooksMaxPerApiKey", () => {
  test("unset or blank: 10", () => {
    expect(readWebhooksMaxPerApiKey(undefined)).toBe(10);
    expect(readWebhooksMaxPerApiKey("")).toBe(10);
    expect(readWebhooksMaxPerApiKey("  ")).toBe(10);
  });

  test.each([
    ["1", 1],
    ["25", 25],
    ["100", 100],
  ])("accepts %p", (raw, value) => {
    expect(readWebhooksMaxPerApiKey(raw)).toBe(value);
  });

  test.each(["0", "-1", "101", "1.5", "10x", "abc", "1e1", "0x10", "+5"])(
    "refuses %p, naming the variable and the range",
    (raw) => {
      expect(() => readWebhooksMaxPerApiKey(raw)).toThrow(
        /WEBHOOKS_MAX_PER_API_KEY must be a whole number from 1 to 100/,
      );
    },
  );
});

describe("readWebhookDeliveryRetentionDays", () => {
  test("unset or blank: 30", () => {
    expect(readWebhookDeliveryRetentionDays(undefined)).toBe(30);
    expect(readWebhookDeliveryRetentionDays("")).toBe(30);
  });

  test.each([
    ["1", 1],
    ["90", 90],
    ["365", 365],
  ])("accepts %p", (raw, value) => {
    expect(readWebhookDeliveryRetentionDays(raw)).toBe(value);
  });

  test.each(["0", "-7", "366", "30d", "abc", "7.5", "1e2"])(
    "refuses %p, naming the variable and the range",
    (raw) => {
      expect(() => readWebhookDeliveryRetentionDays(raw)).toThrow(
        /WEBHOOK_DELIVERY_RETENTION_DAYS must be a whole number from 1 to 365/,
      );
    },
  );
});
