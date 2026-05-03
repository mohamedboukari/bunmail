import { describe, test, expect, mock } from "bun:test";

/**
 * Unit tests for the email redaction helper.
 *
 * `redactEmail` reads `config.logRedactPii` to decide whether to mask.
 * We mock `config` per-suite so we can exercise both the production
 * (mask) and development (passthrough) paths without restarting Bun.
 */

/* ─── Mock the config module so we can flip the flag ─── */
let redactPiiFlag = true;

mock.module("../../src/config.ts", () => ({
  config: {
    get logRedactPii() {
      return redactPiiFlag;
    },
  },
}));

const { redactEmail, redactEmailList } = await import("../../src/utils/redact.ts");

describe("redactEmail (redaction enabled)", () => {
  test("masks the local part except the first character", () => {
    redactPiiFlag = true;
    expect(redactEmail("alice@example.com")).toBe("a***@example.com");
  });

  test("collapses one-character locals to `*` so we don't reveal the whole address", () => {
    redactPiiFlag = true;
    expect(redactEmail("x@example.com")).toBe("*@example.com");
  });

  test("preserves the domain — operators need it for incident response", () => {
    redactPiiFlag = true;
    expect(redactEmail("alice@gmail.com")).toBe("a***@gmail.com");
    expect(redactEmail("alice@example.co.uk")).toBe("a***@example.co.uk");
  });

  test("returns inputs without `@` unchanged (not actually an email)", () => {
    redactPiiFlag = true;
    expect(redactEmail("not-an-email")).toBe("not-an-email");
  });

  test("treats null / undefined / empty as empty string", () => {
    redactPiiFlag = true;
    expect(redactEmail(null)).toBe("");
    expect(redactEmail(undefined)).toBe("");
    expect(redactEmail("")).toBe("");
  });
});

describe("redactEmail (redaction disabled — dev mode)", () => {
  test("returns the address unchanged so local debugging still works", () => {
    redactPiiFlag = false;
    expect(redactEmail("alice@example.com")).toBe("alice@example.com");
  });
});

describe("redactEmailList", () => {
  test("redacts every entry in a comma-separated list", () => {
    redactPiiFlag = true;
    expect(redactEmailList("alice@x.com, bob@y.com")).toBe("a***@x.com, b***@y.com");
  });

  test("normalises whitespace around commas", () => {
    redactPiiFlag = true;
    expect(redactEmailList("alice@x.com,bob@y.com")).toBe("a***@x.com, b***@y.com");
  });

  test("empty / null returns empty string", () => {
    redactPiiFlag = true;
    expect(redactEmailList(null)).toBe("");
    expect(redactEmailList("")).toBe("");
  });

  test("passthrough when redaction disabled", () => {
    redactPiiFlag = false;
    expect(redactEmailList("alice@x.com, bob@y.com")).toBe("alice@x.com, bob@y.com");
  });
});
