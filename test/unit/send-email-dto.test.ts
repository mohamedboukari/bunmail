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

describe("sendEmailDto: CRLF header-injection guard (#133)", () => {
  test("accepts a clean body", () => {
    expect(check.Check(base)).toBe(true);
  });

  test("accepts a comma-separated cc list (multi-address)", () => {
    expect(check.Check({ ...base, cc: "a@example.com, b@example.com" })).toBe(true);
  });

  for (const field of ["cc", "bcc", "subject", "replyTo"] as const) {
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

  test("accepts a comma-separated replyTo list (#169)", () => {
    expect(
      check.Check({ ...base, replyTo: "support@example.com, sales@example.com" }),
    ).toBe(true);
  });

  test("rejects an over-long replyTo value (#169)", () => {
    expect(check.Check({ ...base, replyTo: "a@example.com,".repeat(200) })).toBe(false);
  });
});

describe("sendEmailDto: template variable caps", () => {
  test("accepts up to 100 variables", () => {
    const variables = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`v${i}`, "x"]),
    );
    expect(check.Check({ ...base, templateId: "tpl_x", variables })).toBe(true);
  });

  test("rejects more than 100 variables", () => {
    const variables = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`v${i}`, "x"]),
    );
    expect(check.Check({ ...base, templateId: "tpl_x", variables })).toBe(false);
  });

  test("rejects a variable value over 100 KB", () => {
    expect(
      check.Check({
        ...base,
        templateId: "tpl_x",
        variables: { a: "x".repeat(100_001) },
      }),
    ).toBe(false);
  });
});
