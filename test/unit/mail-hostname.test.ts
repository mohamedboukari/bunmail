import { describe, test, expect } from "bun:test";
import { mailHostnameProblem, readMailHostname } from "../../src/config.ts";

/**
 * `MAIL_HOSTNAME` is the SMTP EHLO name and the Message-ID domain of every
 * outbound email (#242). Production refuses values receivers distrust.
 */

describe("mailHostnameProblem", () => {
  test.each([
    "mail.acme.io",
    "smtp.mail.company.co.uk",
    "MX1.Example-Corp.com",
    "mail.acme.io.",
  ])("accepts %s", (host) => {
    expect(mailHostnameProblem(host)).toBeNull();
  });

  test.each([
    ["", "not set"],
    ["localhost", "localhost"],
    ["203.0.113.10", "IP address"],
    ["::1", "IP address"],
    ["mailserver", "fully qualified"],
    ["mail.example.com", "placeholder"],
    ["mail.yourdomain.com", "placeholder"],
    ["mx.test", "placeholder"],
    ["box.local", "placeholder"],
    ["bad_name.acme.io", "valid hostname"],
    ["-bad.acme.io", "valid hostname"],
  ])("rejects %s", (host, reason) => {
    expect(mailHostnameProblem(host)).toContain(reason);
  });
});

describe("readMailHostname", () => {
  test("production refuses a placeholder", () => {
    expect(() => readMailHostname("production", "mail.example.com")).toThrow(
      /MAIL_HOSTNAME/,
    );
    expect(() => readMailHostname("production", "")).toThrow(/not set/);
  });

  test("production accepts a real hostname", () => {
    expect(readMailHostname("production", " mail.acme.io ")).toBe("mail.acme.io");
  });

  test("development keeps the localhost default", () => {
    expect(readMailHostname("development", "")).toBe("localhost");
    expect(readMailHostname("development", "localhost")).toBe("localhost");
  });
});
