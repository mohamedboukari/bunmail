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

/**
 * NOTE: Bun's `mock.module` leaks globally across test files: a mock
 * registered here stays active for every file Bun loads afterwards. So
 * this stub must be a *complete* enough `config` that any module which
 * eagerly reads it at import time still works under the leaked mock.
 * In particular `src/db/index.ts` evaluates `new SQL(config.database.url)`
 * at module load; a stub without `database` crashes a later file with
 * "undefined is not an object (evaluating 'config.database.url')" under
 * CI's test-file ordering. Keep `database.url` populated. (#119 CI red)
 */
void mock.module("../../src/config.ts", () => ({
  config: {
    database: { url: "postgres://test:test@localhost:5432/test" },
    get logRedactPii() {
      return redactPiiFlag;
    },
  },
}));

const { redactEmail, redactEmailList, redactEmailsInText, redactUrl } =
  await import("../../src/utils/redact.ts");

describe("redactEmail (redaction enabled)", () => {
  test("masks the local part except the first character", () => {
    redactPiiFlag = true;
    expect(redactEmail("alice@example.com")).toBe("a***@example.com");
  });

  test("collapses one-character locals to `*` so we don't reveal the whole address", () => {
    redactPiiFlag = true;
    expect(redactEmail("x@example.com")).toBe("*@example.com");
  });

  test("preserves the domain: operators need it for incident response", () => {
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

describe("redactEmail (redaction disabled: dev mode)", () => {
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

describe("redactEmailsInText (#260)", () => {
  test("masks every address in a remote SMTP reply, keeping the reply readable", () => {
    redactPiiFlag = true;
    expect(
      redactEmailsInText("550 5.1.1 <user@example.org>: Recipient address rejected"),
    ).toBe("550 5.1.1 <u***@example.org>: Recipient address rejected");
    expect(redactEmailsInText("452 too many: a@x.com, bob.smith@y.co.uk")).toBe(
      "452 too many: *@x.com, b***@y.co.uk",
    );
  });

  test("text without an address is unchanged", () => {
    redactPiiFlag = true;
    expect(redactEmailsInText("421 4.7.0 Try again later")).toBe(
      "421 4.7.0 Try again later",
    );
  });

  test("passthrough when redaction disabled", () => {
    redactPiiFlag = false;
    expect(redactEmailsInText("550 <user@example.org> rejected")).toBe(
      "550 <user@example.org> rejected",
    );
  });
});

describe("redactUrl (#260)", () => {
  test("keeps only scheme, host and port: path, query and user info carry credentials", () => {
    expect(redactUrl("https://hooks.slack.com/services/T000/B000/XXXXSECRET")).toBe(
      "https://hooks.slack.com",
    );
    expect(redactUrl("https://user:pass@example.com:8443/hook?token=abc#frag")).toBe(
      "https://example.com:8443",
    );
  });

  test("applies whatever LOG_REDACT_PII says: the URL is a secret, not PII", () => {
    redactPiiFlag = false;
    expect(redactUrl("https://discord.com/api/webhooks/1/abc")).toBe(
      "https://discord.com",
    );
  });

  test("unparsable input is not echoed", () => {
    expect(redactUrl("not a url /secret")).toBe("[invalid url]");
  });
});
