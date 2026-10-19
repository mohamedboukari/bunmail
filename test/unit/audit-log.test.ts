import { describe, test, expect } from "bun:test";
import {
  DEFAULT_AUDIT_LOG_RETENTION_DAYS,
  MAX_AUDIT_LOG_RETENTION_DAYS,
  MIN_AUDIT_LOG_RETENTION_DAYS,
  readAuditLogRetentionDays,
} from "../../src/config.ts";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTIONS,
  isAuditAction,
  isAuditOutcome,
} from "../../src/modules/audit/types/audit.types.ts";

/**
 * Audit log (#221): the retention env var refuses anything but a whole
 * number of days from 30 to 3650 (a typo must not shorten the history
 * silently), and the action list the page filters by is exactly the
 * labelled actions, with no prototype key mistaken for one.
 */

describe("readAuditLogRetentionDays", () => {
  test("unset or blank: 365 days", () => {
    expect(DEFAULT_AUDIT_LOG_RETENTION_DAYS).toBe(365);
    expect(readAuditLogRetentionDays(undefined)).toBe(365);
    expect(readAuditLogRetentionDays("")).toBe(365);
    expect(readAuditLogRetentionDays("  ")).toBe(365);
  });

  test.each([
    ["30", 30],
    [" 90 ", 90],
    ["365", 365],
    ["3650", 3650],
  ])("accepts %p", (raw, days) => {
    expect(readAuditLogRetentionDays(raw)).toBe(days);
  });

  test.each([
    String(MIN_AUDIT_LOG_RETENTION_DAYS - 1),
    String(MAX_AUDIT_LOG_RETENTION_DAYS + 1),
    "0",
    "-30",
    "+30",
    "30.5",
    "1e3",
    "0x100",
    "90d",
    "abc",
  ])("refuses %p", (raw) => {
    expect(() => readAuditLogRetentionDays(raw)).toThrow(/AUDIT_LOG_RETENTION_DAYS/);
  });
});

describe("audit actions", () => {
  test("every labelled action is listed once, in declaration order", () => {
    expect(Object.keys(AUDIT_ACTION_LABELS)).toEqual([...AUDIT_ACTIONS]);
    expect(new Set(AUDIT_ACTIONS).size).toBe(AUDIT_ACTIONS.length);
  });

  test("isAuditAction knows the actions and nothing else", () => {
    expect(isAuditAction("auth.login.succeeded")).toBe(true);
    for (const value of [undefined, "", "constructor", "__proto__", "toString", "auth"]) {
      expect(isAuditAction(value)).toBe(false);
    }
  });

  test("isAuditOutcome", () => {
    expect(isAuditOutcome("success")).toBe(true);
    expect(isAuditOutcome("failure")).toBe(true);
    expect(isAuditOutcome("maybe")).toBe(false);
    expect(isAuditOutcome(undefined)).toBe(false);
  });

  test("action names are dotted lower-case codes that fit the column", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(action).toMatch(/^[a-z_]+(\.[a-z_]+)+$/);
      expect(action.length).toBeLessThanOrEqual(64);
    }
  });
});
