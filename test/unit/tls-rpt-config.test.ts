import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TLSRPT_MAX_REPORTS_PER_DAY,
  DEFAULT_TLSRPT_MAX_REPORTS_PER_DESTINATION,
  MAX_TLSRPT_MAX_REPORTS_PER_DESTINATION,
  MIN_TLSRPT_MAX_REPORTS_PER_DESTINATION,
  readTlsRptMaxReportsPerDestination,
  MAX_TLSRPT_MAX_REPORTS_PER_DAY,
  MAX_TLSRPT_ORGANIZATION_NAME_LENGTH,
  MIN_TLSRPT_MAX_REPORTS_PER_DAY,
  readTlsRptContactEmail,
  readTlsRptEnabled,
  readTlsRptMaxReportsPerDay,
  readTlsRptOrganizationName,
} from "../../src/config.ts";

/**
 * TLS-RPT's env vars (#345): `TLSRPT_ENABLED` is a strict boolean, off by
 * default; `TLSRPT_CONTACT_EMAIL` falls back to `SYSTEM_MAIL_FROM` and is
 * required (one of the two) when TLS-RPT is on; `TLSRPT_ORGANIZATION_NAME`
 * defaults to the contact's domain. Malformed values stop the boot.
 */

describe("readTlsRptEnabled", () => {
  test("off by default", () => {
    expect(readTlsRptEnabled(undefined)).toBe(false);
    expect(readTlsRptEnabled("")).toBe(false);
  });

  test("true and false only", () => {
    expect(readTlsRptEnabled("true")).toBe(true);
    expect(readTlsRptEnabled("false")).toBe(false);
    for (const raw of ["1", "yes", "TRUE", "on"]) {
      expect(() => readTlsRptEnabled(raw)).toThrow(
        /TLSRPT_ENABLED must be "true" or "false"/,
      );
    }
  });
});

describe("readTlsRptContactEmail", () => {
  test("an explicit address wins, trimmed and lower-cased", () => {
    expect(readTlsRptContactEmail(true, " TLS@Example.COM ", "noreply@example.org")).toBe(
      "tls@example.com",
    );
  });

  test("falls back to SYSTEM_MAIL_FROM", () => {
    expect(readTlsRptContactEmail(true, "", "noreply@example.org")).toBe(
      "noreply@example.org",
    );
  });

  test("on with neither set refuses to boot; off gives null", () => {
    expect(() => readTlsRptContactEmail(true, "", null)).toThrow(
      /TLSRPT_ENABLED=true needs a contact address/,
    );
    expect(readTlsRptContactEmail(false, "", null)).toBeNull();
  });

  test.each([
    "not-an-address",
    "a@b@c.com",
    "Name <a@example.com>",
    "a@example.com,b@example.com",
  ])("refuses %p, even when off", (raw) => {
    expect(() => readTlsRptContactEmail(false, raw, null)).toThrow(
      /TLSRPT_CONTACT_EMAIL is not usable/,
    );
  });
});

describe("readTlsRptOrganizationName", () => {
  test("unset or blank: the fallback", () => {
    expect(readTlsRptOrganizationName("example.com", "")).toBe("example.com");
    expect(readTlsRptOrganizationName("example.com", "   ")).toBe("example.com");
  });

  test("a printable name is kept, trimmed", () => {
    expect(readTlsRptOrganizationName("example.com", "  Example Inc.  ")).toBe(
      "Example Inc.",
    );
  });

  test("control characters and over-long names refuse to boot", () => {
    expect(() => readTlsRptOrganizationName("x", "Evil\r\nX-Header: 1")).toThrow(
      /TLSRPT_ORGANIZATION_NAME must be/,
    );
    expect(() =>
      readTlsRptOrganizationName(
        "x",
        "a".repeat(MAX_TLSRPT_ORGANIZATION_NAME_LENGTH + 1),
      ),
    ).toThrow(/TLSRPT_ORGANIZATION_NAME must be/);
  });
});

describe("readTlsRptMaxReportsPerDay", () => {
  test("unset or blank: 500", () => {
    expect(DEFAULT_TLSRPT_MAX_REPORTS_PER_DAY).toBe(500);
    expect(readTlsRptMaxReportsPerDay(undefined)).toBe(500);
    expect(readTlsRptMaxReportsPerDay(" ")).toBe(500);
  });

  test.each([
    [String(MIN_TLSRPT_MAX_REPORTS_PER_DAY), 1],
    [" 2000 ", 2000],
    [String(MAX_TLSRPT_MAX_REPORTS_PER_DAY), 100_000],
  ])("accepts %p", (raw, value) => {
    expect(readTlsRptMaxReportsPerDay(raw)).toBe(value);
  });

  test.each(["0", "100001", "-1", "1.5", "500/day", "1e3", "0x10"])(
    "refuses %p",
    (raw) => {
      expect(() => readTlsRptMaxReportsPerDay(raw)).toThrow(
        /TLSRPT_MAX_REPORTS_PER_DAY must be a whole number from 1 to 100000/,
      );
    },
  );
});

describe("readTlsRptMaxReportsPerDestination", () => {
  test("unset or blank: 50", () => {
    expect(DEFAULT_TLSRPT_MAX_REPORTS_PER_DESTINATION).toBe(50);
    expect(readTlsRptMaxReportsPerDestination(undefined)).toBe(50);
    expect(readTlsRptMaxReportsPerDestination("")).toBe(50);
  });

  test.each([
    [String(MIN_TLSRPT_MAX_REPORTS_PER_DESTINATION), 1],
    ["50", 50],
    [String(MAX_TLSRPT_MAX_REPORTS_PER_DESTINATION), 1000],
  ])("accepts %p", (raw, value) => {
    expect(readTlsRptMaxReportsPerDestination(raw)).toBe(value);
  });

  test.each(["0", "1001", "-5", "2.5", "five", "1e2"])("refuses %p", (raw) => {
    expect(() => readTlsRptMaxReportsPerDestination(raw)).toThrow(
      /TLSRPT_MAX_REPORTS_PER_DESTINATION_PER_DAY must be a whole number from 1 to 1000/,
    );
  });
});
