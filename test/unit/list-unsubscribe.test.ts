import { describe, test, expect } from "bun:test";
import {
  listUnsubscribeOptions,
  oneClickBaseUrl,
  type ListUnsubscribeEmail,
  type ListUnsubscribeSettings,
} from "../../src/modules/emails/services/list-unsubscribe.ts";
import { buildMailOptions } from "../../src/modules/emails/services/mailer.service.ts";
import { mintUnsubscribeToken } from "../../src/modules/suppressions/services/unsubscribe-token.ts";

/**
 * `List-Unsubscribe` per email (#249): a per-recipient one-click link only
 * when the email names exactly one recipient (no cc, no bcc) and
 * `APP_BASE_URL` is HTTPS; the static domain settings otherwise.
 */

const email: ListUnsubscribeEmail = {
  id: "msg_0123456789abcdef01234567",
  apiKeyId: "key_aaaaaaaaaaaaaaaaaaaaaaaa",
  fromAddress: "hello@acme.io",
  toAddress: "user@example.org",
  cc: null,
  bcc: null,
};

const BASE = "https://mail.acme.io";
const withSmtp: ListUnsubscribeSettings = { appBaseUrl: BASE, inboundSmtp: true };
const withoutSmtp: ListUnsubscribeSettings = { appBaseUrl: BASE, inboundSmtp: false };

const token = mintUnsubscribeToken({
  emailId: email.id,
  recipient: email.toAddress,
  apiKeyId: email.apiKeyId,
});

/** The extra headers the mailer would write for these options. */
function headersFor(
  e: ListUnsubscribeEmail,
  settings: ListUnsubscribeSettings,
  domain?: {
    unsubscribeEmail: string | null;
    unsubscribeUrl: string | null;
  },
): Record<string, string> {
  const options = buildMailOptions({
    recipients: [e.toAddress],
    from: e.fromAddress,
    headerTo: e.toAddress,
    headerCc: e.cc,
    replyTo: null,
    subject: "s",
    html: null,
    text: "x",
    messageId: "<m@acme.io>",
    headers: {},
    unsubscribe: listUnsubscribeOptions(e, domain, settings),
  });
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

describe("listUnsubscribeOptions", () => {
  test("one recipient, inbound SMTP on: tokenized URL, One-Click and unsub+ mailto", () => {
    const headers = headersFor(email, withSmtp);
    expect(headers["List-Unsubscribe"]).toBe(
      `<mailto:unsub+${token}@acme.io>, <${BASE}/u/${token}>`,
    );
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  test("inbound SMTP off, no static mailbox: the URL alone, no mailto", () => {
    const headers = headersFor(email, withoutSmtp);
    expect(headers["List-Unsubscribe"]).toBe(`<${BASE}/u/${token}>`);
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  test("inbound SMTP off with a static mailbox: that mailbox next to the URL", () => {
    const headers = headersFor(email, withoutSmtp, {
      unsubscribeEmail: "leave@acme.io",
      unsubscribeUrl: null,
    });
    expect(headers["List-Unsubscribe"]).toBe(
      `<mailto:leave@acme.io>, <${BASE}/u/${token}>`,
    );
  });

  test("the per-recipient URL replaces the domain's static URL", () => {
    const options = listUnsubscribeOptions(
      email,
      { unsubscribeEmail: null, unsubscribeUrl: "https://acme.io/static" },
      withSmtp,
    );
    expect(options?.url).toBe(`${BASE}/u/${token}`);
  });

  test("with a cc: the static settings, no token anywhere", () => {
    const cc = { ...email, cc: "boss@example.org" };
    const headers = headersFor(cc, withSmtp);
    expect(headers["List-Unsubscribe"]).toBe("<mailto:unsubscribe@acme.io>");
    expect(headers["List-Unsubscribe-Post"]).toBeUndefined();
    expect(
      listUnsubscribeOptions(
        cc,
        { unsubscribeEmail: "leave@acme.io", unsubscribeUrl: "https://acme.io/u" },
        withSmtp,
      ),
    ).toEqual({ mailto: "leave@acme.io", url: "https://acme.io/u" });
  });

  test("with a bcc: the static settings, no token anywhere", () => {
    const headers = headersFor({ ...email, bcc: "audit@example.org" }, withSmtp);
    expect(headers["List-Unsubscribe"]).toBe("<mailto:unsubscribe@acme.io>");
    expect(JSON.stringify(headers)).not.toContain("/u/");
  });

  test("two to addresses: the static settings", () => {
    const options = listUnsubscribeOptions(
      { ...email, toAddress: "a@example.org, b@example.org" },
      undefined,
      withSmtp,
    );
    expect(options).toBeUndefined();
  });

  test.each(["", "http://mail.acme.io", "not a url", "https://mail.acme.io/?x=1"])(
    "APP_BASE_URL %p cannot carry a one-click link: static settings",
    (appBaseUrl) => {
      expect(
        listUnsubscribeOptions(email, undefined, { appBaseUrl, inboundSmtp: true }),
      ).toBeUndefined();
    },
  );

  test("the same email gives the same header on every attempt", () => {
    expect(headersFor(email, withSmtp)).toEqual(headersFor(email, withSmtp));
  });
});

describe("oneClickBaseUrl", () => {
  test("keeps an https base, without a trailing slash", () => {
    expect(oneClickBaseUrl("https://mail.acme.io/")).toBe("https://mail.acme.io");
    expect(oneClickBaseUrl("https://acme.io/bunmail")).toBe("https://acme.io/bunmail");
  });
});
