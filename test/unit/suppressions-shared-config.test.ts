import { describe, test, expect } from "bun:test";
import {
  isConsumerMailboxDomain,
  readFeedbackLoopDomains,
  readFeedbackLoopSenders,
  readSuppressionsSharedHard,
} from "../../src/config.ts";

/**
 * `SUPPRESSIONS_SHARED_HARD` (#250) is a strict boolean, default false:
 * a typo refuses to boot instead of silently leaving the shared gate off.
 */
describe("readSuppressionsSharedHard", () => {
  test("unset or blank: false", () => {
    expect(readSuppressionsSharedHard(undefined)).toBe(false);
    expect(readSuppressionsSharedHard("")).toBe(false);
    expect(readSuppressionsSharedHard("   ")).toBe(false);
  });

  test("true and false, surrounding spaces ignored", () => {
    expect(readSuppressionsSharedHard("true")).toBe(true);
    expect(readSuppressionsSharedHard(" true ")).toBe(true);
    expect(readSuppressionsSharedHard("false")).toBe(false);
  });

  test.each(["TRUE", "1", "yes", "on", "shared"])("refuses %p", (raw) => {
    expect(() => readSuppressionsSharedHard(raw)).toThrow(
      /SUPPRESSIONS_SHARED_HARD must be "true" or "false"/,
    );
  });
});

/**
 * `FEEDBACK_LOOP_DOMAINS`: the DKIM signing domains whose feedback-loop
 * reports make a complaint shareable. Normalised like a registered domain
 * name; a malformed entry refuses to boot instead of silently verifying
 * nothing (or the wrong thing).
 */
describe("readFeedbackLoopDomains", () => {
  test("unset or blank: empty, nothing is verified", () => {
    expect(readFeedbackLoopDomains(undefined)).toEqual([]);
    expect(readFeedbackLoopDomains("")).toEqual([]);
    expect(readFeedbackLoopDomains(" , ,")).toEqual([]);
  });

  test("comma-separated, trimmed, lower-cased, final dot dropped, duplicates removed", () => {
    expect(
      readFeedbackLoopDomains(
        " FBL.isp.example.net , complaints.example.org., fbl.isp.example.net",
      ),
    ).toEqual(["fbl.isp.example.net", "complaints.example.org"]);
  });

  test("an IDN becomes its A-label", () => {
    expect(readFeedbackLoopDomains("bücher.example")).toEqual(["xn--bcher-kva.example"]);
  });

  test.each([
    "localhost",
    "192.0.2.1",
    "https://isp.example.net",
    "feedback@isp.example.net",
    "isp..example.net",
    "isp.example.net:25",
    "*.example.net",
    "isp example.net",
  ])("refuses %p", (raw) => {
    expect(() => readFeedbackLoopDomains(`ok.example.net, ${raw}`)).toThrow(
      /FEEDBACK_LOOP_DOMAINS must be domain names separated by commas/,
    );
  });
});

/**
 * `FEEDBACK_LOOP_SENDERS`: who may send a verified feedback-loop report.
 * Exact addresses or `@domain`, stored lower-cased with the domain
 * normalised; anything else refuses to boot, and so does `@domain` for a
 * consumer mailbox domain (it would accept a report from any of its users).
 */
describe("readFeedbackLoopSenders", () => {
  test("unset or blank: empty, nothing is verified", () => {
    expect(readFeedbackLoopSenders(undefined)).toEqual([]);
    expect(readFeedbackLoopSenders("")).toEqual([]);
    expect(readFeedbackLoopSenders(" , ,")).toEqual([]);
  });

  test("addresses and @domain entries, trimmed, lower-cased, final dot dropped, duplicates removed", () => {
    expect(
      readFeedbackLoopSenders(
        " Feedback@ARF.example.net , @fbl.Example.org., feedback@arf.example.net",
      ),
    ).toEqual(["feedback@arf.example.net", "@fbl.example.org"]);
  });

  test("an IDN domain becomes its A-label", () => {
    expect(readFeedbackLoopSenders("@bücher.example")).toEqual([
      "@xn--bcher-kva.example",
    ]);
  });

  test("an exact address at a consumer mailbox domain is allowed", () => {
    expect(readFeedbackLoopSenders("staff@hotmail.example, feedback@yahoo.com")).toEqual([
      "staff@hotmail.example",
      "feedback@yahoo.com",
    ]);
  });

  test.each([
    "fbl.example.net",
    "@localhost",
    "@192.0.2.1",
    "Feedback <feedback@fbl.example.net>",
    "<feedback@fbl.example.net>",
    "*@fbl.example.net",
    "@*.example.net",
    "feedback@",
    "feedback @fbl.example.net",
    "a@b@fbl.example.net",
    "feedbac\u212a@fbl.example.net",
  ])("refuses %p", (raw) => {
    expect(() => readFeedbackLoopSenders(`ok@fbl.example.net, ${raw}`)).toThrow(
      /FEEDBACK_LOOP_SENDERS must be addresses or @domain entries separated by commas/,
    );
  });

  test.each([
    "@gmail.com",
    "@Hotmail.com",
    "@yahoo.co.uk",
    "@gmx.de",
    "@yandex.ru",
    "@outlook.com",
    "@arf.mail.yahoo.com",
    "@proton.me",
  ])("refuses %p: a consumer mailbox domain", (raw) => {
    expect(() => readFeedbackLoopSenders(raw)).toThrow(/must not list "@/);
  });
});

describe("isConsumerMailboxDomain", () => {
  test.each([
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "ymail.com",
    "outlook.com",
    "hotmail.com",
    "live.com",
    "msn.com",
    "aol.com",
    "icloud.com",
    "me.com",
    "web.de",
    "mail.ru",
    "gmx.net",
    "gmx.de",
    "yandex.ru",
    "yahoo.co.uk",
    "hotmail.fr",
    "protonmail.com",
    "protonmail.ch",
    "proton.me",
    "pm.me",
    "mail.yahoo.com",
    "arf.mail.yahoo.com",
    "mail.gmx.net",
    "x.gmail.com",
    "fbl.mail.yahoo.co.uk",
  ])("%p is one", (domain) => {
    expect(isConsumerMailboxDomain(domain)).toBe(true);
  });

  test.each([
    "fbl.example.net",
    "notgmail.com",
    "gmail.com.example.net",
    "hotmail.example.co.uk",
    "yahoo.example.co.uk",
    "notpm.me.example.net",
  ])("%p is not", (domain) => {
    expect(isConsumerMailboxDomain(domain)).toBe(false);
  });
});
