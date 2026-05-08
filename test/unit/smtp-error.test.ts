import { describe, test, expect } from "bun:test";
import { parseSmtpError } from "../../src/utils/smtp-error.ts";

/**
 * Unit tests for the SMTP error classifier. Pure function — fixture in,
 * `{ kind, code }` out, or null. Covers the actual error strings we see
 * in production logs from Gmail / Outlook / Yahoo, plus infrastructure
 * errors that should NOT classify as bounces.
 */

const GMAIL_HARD_BOUNCE =
  "Can't send mail - all recipients were rejected: 550-5.1.1 The email account that you tried to reach does not exist. Please try\n550-5.1.1 double-checking the recipient's email address for typos or\n550-5.1.1 unnecessary spaces. For more information, go to\n550 5.1.1  https://support.google.com/mail/?p=NoSuchUser ... - gsmtp";

const OUTLOOK_HARD_BLOCKED =
  "550 5.7.1 Service unavailable; Client host [23.95.164.177] blocked using Spamhaus";

const YAHOO_HARD_NO_USER = "550 5.1.1 user unknown";

const SOFT_MAILBOX_FULL = "452 4.2.2 Mailbox over quota; please try again later";

const SOFT_GREYLIST_BASIC =
  "421 4.7.0 Greylisted for 5 minutes; please retry after the embargo period";

const NETWORK_ERROR = "Error: connect ETIMEDOUT 142.250.65.108:25";

const DNS_ERROR = "getaddrinfo ENOTFOUND mx.example.com";

const TLS_ERROR =
  "Hostname/IP does not match certificate's altnames: Host: a.b.c is not in the cert's altnames";

describe("parseSmtpError — hard bounces (5xx)", () => {
  test("Gmail's actual 550-5.1.1 'no such user' format", () => {
    const parsed = parseSmtpError(GMAIL_HARD_BOUNCE);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("hard");
    expect(parsed!.code).toBe("5.1.1");
  });

  test("Outlook 550 5.7.1 spamhaus block (5.7.1 → hard, the policy block)", () => {
    const parsed = parseSmtpError(OUTLOOK_HARD_BLOCKED);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("hard");
    expect(parsed!.code).toBe("5.7.1");
  });

  test("Yahoo basic 550 with enhanced 5.1.1 — enhanced wins for the code", () => {
    const parsed = parseSmtpError(YAHOO_HARD_NO_USER);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("hard");
    expect(parsed!.code).toBe("5.1.1");
  });

  test("basic-only 5xx (no enhanced status) promotes to 5.0.0", () => {
    const parsed = parseSmtpError("550 mailbox unavailable");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("hard");
    expect(parsed!.code).toBe("5.0.0");
  });
});

describe("parseSmtpError — soft bounces (4xx)", () => {
  test("4.2.2 mailbox over quota classifies as soft", () => {
    const parsed = parseSmtpError(SOFT_MAILBOX_FULL);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("soft");
    expect(parsed!.code).toBe("4.2.2");
  });

  test("4xx greylist with both 421 and 4.7.0 — enhanced wins", () => {
    const parsed = parseSmtpError(SOFT_GREYLIST_BASIC);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("soft");
    expect(parsed!.code).toBe("4.7.0");
  });

  test("basic-only 4xx promotes to 4.0.0", () => {
    const parsed = parseSmtpError("421 try again later");
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("soft");
    expect(parsed!.code).toBe("4.0.0");
  });
});

describe("parseSmtpError — non-SMTP errors", () => {
  test("connection timeout is not classified — existing retry behavior preserved", () => {
    expect(parseSmtpError(NETWORK_ERROR)).toBeNull();
  });

  test("DNS resolution failure is not classified", () => {
    expect(parseSmtpError(DNS_ERROR)).toBeNull();
  });

  test("TLS handshake error is not classified", () => {
    expect(parseSmtpError(TLS_ERROR)).toBeNull();
  });

  test("empty / nonsense messages are not classified", () => {
    expect(parseSmtpError("")).toBeNull();
    expect(parseSmtpError("something went wrong")).toBeNull();
  });

  test("2.x.x 'delivered' shape is rejected (shouldn't appear in error path, but defensive)", () => {
    expect(parseSmtpError("250 2.0.0 OK queued")).toBeNull();
  });
});
