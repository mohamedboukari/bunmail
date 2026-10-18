import { describe, test, expect } from "bun:test";
import {
  MAX_INVITE_EXPIRY_DAYS,
  readInviteExpiryDays,
  readSystemMailFrom,
} from "../../src/config.ts";

/**
 * Invitation env vars (#217). `INVITE_EXPIRY_DAYS` defaults to 7 and
 * refuses anything but a whole number of days in range; `SYSTEM_MAIL_FROM`
 * is optional, stored trimmed and lower-cased, and refused when it is not
 * one bare address. A malformed value stops the boot in every environment.
 */

describe("readInviteExpiryDays", () => {
  test("unset or blank: 7 days", () => {
    expect(readInviteExpiryDays("")).toBe(7);
    expect(readInviteExpiryDays("   ")).toBe(7);
  });

  test.each([
    ["1", 1],
    ["14", 14],
    [" 30 ", 30],
    [String(MAX_INVITE_EXPIRY_DAYS), MAX_INVITE_EXPIRY_DAYS],
  ])("accepts %p", (raw, days) => {
    expect(readInviteExpiryDays(raw)).toBe(days);
  });

  test.each([
    "0",
    "-1",
    "1.5",
    "7d",
    "abc",
    "1e1",
    "0x10",
    String(MAX_INVITE_EXPIRY_DAYS + 1),
  ])("refuses %p", (raw) => {
    expect(() => readInviteExpiryDays(raw)).toThrow(/INVITE_EXPIRY_DAYS/);
  });

  test("the error names the accepted range and echoes the value", () => {
    expect(() => readInviteExpiryDays("seven")).toThrow(
      `from 1 to ${MAX_INVITE_EXPIRY_DAYS}, got "seven"`,
    );
  });
});

describe("readSystemMailFrom", () => {
  test("unset or blank: no system sender", () => {
    expect(readSystemMailFrom("")).toBeNull();
    expect(readSystemMailFrom("   ")).toBeNull();
  });

  test("trims and lower-cases", () => {
    expect(readSystemMailFrom("  NoReply@Example.COM ")).toBe("noreply@example.com");
  });

  test.each([
    ["no-at", "valid email"],
    ["a@b", "valid email"],
    ["BunMail <noreply@example.com>", "valid email"],
    ["a@example.com,b@example.com", "valid email"],
    [`${"a".repeat(250)}@example.com`, "longer than 254"],
  ])("refuses %p", (raw, reason) => {
    expect(() => readSystemMailFrom(raw)).toThrow(/SYSTEM_MAIL_FROM is not usable/);
    expect(() => readSystemMailFrom(raw)).toThrow(reason);
  });
});
