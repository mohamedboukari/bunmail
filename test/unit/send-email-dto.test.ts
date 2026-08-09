import { describe, test, expect } from "bun:test";
import { TypeCompiler } from "@sinclair/typebox/compiler";
import { sendEmailDto } from "../../src/modules/emails/dtos/send-email.dto.ts";

/**
 * Unit tests for the send-email DTO's header-injection defense-in-depth
 * (#133): `cc`/`bcc`/`subject` must reject CR/LF and enforce length caps,
 * so a newline in an address/subject field can't split an SMTP header.
 */

const check = TypeCompiler.Compile(sendEmailDto);

/** Minimal valid body we can spread + override per case. */
const base = {
  from: "sender@example.com",
  to: "rcpt@example.com",
  subject: "Hello",
};

describe("sendEmailDto — CRLF header-injection guard (#133)", () => {
  test("accepts a clean body", () => {
    expect(check.Check(base)).toBe(true);
  });

  test("accepts a comma-separated cc list (multi-address)", () => {
    expect(check.Check({ ...base, cc: "a@example.com, b@example.com" })).toBe(true);
  });

  for (const field of ["cc", "bcc", "subject"] as const) {
    test(`rejects a CR in ${field}`, () => {
      expect(check.Check({ ...base, [field]: "x\r@example.com" })).toBe(false);
    });

    test(`rejects an LF in ${field}`, () => {
      expect(check.Check({ ...base, [field]: "x\n@example.com" })).toBe(false);
    });

    test(`rejects an injected header line in ${field}`, () => {
      expect(
        check.Check({ ...base, [field]: "a@example.com\r\nBcc: victim@example.com" }),
      ).toBe(false);
    });
  }

  test("rejects an over-long cc value", () => {
    expect(check.Check({ ...base, cc: "a@example.com,".repeat(200) })).toBe(false);
  });
});
