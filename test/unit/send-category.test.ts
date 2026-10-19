import { describe, test, expect } from "bun:test";
import {
  buildMailOptions,
  carriesListUnsubscribe,
} from "../../src/modules/emails/services/mailer.service.ts";
import {
  listUnsubscribeOptions,
  oneClickBlocker,
} from "../../src/modules/emails/services/list-unsubscribe.ts";
import { isEmailCategory } from "../../src/modules/emails/types/email.types.ts";

/**
 * The send category (#250): `transactional` mail carries no
 * `List-Unsubscribe`, `marketing` mail needs the per-recipient one-click
 * link (#249), and BunMail's own automatic mail never carries the header.
 *
 * Reads the headers `buildMailOptions` sets, without rendering: other unit
 * files mock `nodemailer`, and `mock.module` leaks across files. The
 * rendered message is covered by the integration tests.
 */

const base = {
  recipients: ["user@example.org"],
  from: "hello@example.com",
  headerTo: "user@example.org",
  headerCc: null,
  replyTo: null,
  subject: "Hi",
  html: null,
  text: "hello",
  messageId: "<abc@mail.example.com>",
  headers: {},
};

const oneClick = { url: "https://mail.example.com/u/token", mailto: null };

/** The extra headers of a message, by name. */
function headersOf(options: ReturnType<typeof buildMailOptions>): Record<string, string> {
  const headers = options.headers;
  if (headers === undefined) return {};
  if (Array.isArray(headers) || typeof headers !== "object") {
    throw new Error("expected a header record");
  }
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, String(value)]),
  );
}

describe("List-Unsubscribe by category", () => {
  test("transactional: neither List-Unsubscribe nor List-Unsubscribe-Post", () => {
    const headers = headersOf(
      buildMailOptions({ ...base, unsubscribe: oneClick, category: "transactional" }),
    );
    expect(headers["List-Unsubscribe"]).toBeUndefined();
    expect(headers["List-Unsubscribe-Post"]).toBeUndefined();
  });

  test("transactional keeps Feedback-ID", () => {
    const headers = headersOf(
      buildMailOptions({
        ...base,
        category: "transactional",
        feedback: { source: "api", apiKeyId: "key_1" },
      }),
    );
    expect(headers["Feedback-ID"]).toStartWith("api:");
  });

  test("marketing with the one-click link carries both headers", () => {
    const headers = headersOf(
      buildMailOptions({ ...base, unsubscribe: oneClick, category: "marketing" }),
    );
    expect(headers["List-Unsubscribe"]).toBe("<https://mail.example.com/u/token>");
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  test("no category: as before, the default mailto", () => {
    expect(headersOf(buildMailOptions(base))["List-Unsubscribe"]).toBe(
      "<mailto:unsubscribe@example.com>",
    );
  });

  test("BunMail's own automatic mail never carries it, whatever the category", () => {
    for (const category of [null, "marketing"] as const) {
      const headers = headersOf(
        buildMailOptions({
          ...base,
          unsubscribe: oneClick,
          category,
          autoSubmitted: true,
        }),
      );
      expect(headers["List-Unsubscribe"]).toBeUndefined();
      expect(headers["List-Unsubscribe-Post"]).toBeUndefined();
    }
  });

  test("a display name goes in From as name and address", () => {
    expect(buildMailOptions({ ...base, fromName: "Acme" }).from).toEqual({
      name: "Acme",
      address: "hello@example.com",
    });
    expect(buildMailOptions(base).from).toBe("hello@example.com");
  });

  test("carriesListUnsubscribe", () => {
    expect(carriesListUnsubscribe({ category: "transactional" })).toBe(false);
    expect(carriesListUnsubscribe({ autoSubmitted: true })).toBe(false);
    expect(carriesListUnsubscribe({ category: "marketing" })).toBe(true);
    expect(carriesListUnsubscribe({})).toBe(true);
  });
});

describe("oneClickBlocker: what marketing mail needs", () => {
  const single = { toAddress: "user@example.org", cc: null, bcc: null };
  const https = "https://mail.example.com";

  test("one recipient and an https APP_BASE_URL: nothing blocks", () => {
    expect(oneClickBlocker(single, https)).toBeNull();
    expect(oneClickBlocker(single, `${https}/`)).toBeNull();
  });

  test.each([
    [{ ...single, toAddress: "a@example.org, b@example.org" }],
    [{ ...single, cc: "c@example.org" }],
    [{ ...single, bcc: "c@example.org" }],
  ])("more than one recipient: recipients (%p)", (email) => {
    expect(oneClickBlocker(email, https)).toBe("recipients");
  });

  test.each(["http://mail.example.com", "https://mail.example.com?x=1", "", "not a url"])(
    "APP_BASE_URL %p cannot carry the link",
    (appBaseUrl) => {
      expect(oneClickBlocker(single, appBaseUrl)).toBe("app_base_url");
    },
  );

  test("whenever nothing blocks, the per-recipient link is minted", () => {
    const options = listUnsubscribeOptions(
      { id: "msg_0123456789abcdef01234567", fromAddress: "hello@example.com", ...single },
      undefined,
      { appBaseUrl: https, inboundSmtp: false },
    );
    expect(options?.url).toStartWith(`${https}/u/`);
  });
});

describe("isEmailCategory", () => {
  test("narrows the stored value", () => {
    expect(isEmailCategory("transactional")).toBe(true);
    expect(isEmailCategory("marketing")).toBe(true);
    expect(isEmailCategory("Marketing")).toBe(false);
    expect(isEmailCategory(null)).toBe(false);
    expect(isEmailCategory(undefined)).toBe(false);
  });
});
