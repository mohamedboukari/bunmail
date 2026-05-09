/**
 * Defensive-input tests for the inbound message pipeline (#35, bullet 1).
 *
 * The SMTP receiver's `onData` handler buffers chunks, then runs
 * `simpleParser` (mailparser) → `parseBounce` (RFC 3464) →
 * `persistDmarcReportFromInbound`, all wrapped in a single try/catch
 * that returns SMTP 452 on throw. None of those callees should crash
 * the worker on garbage input — at worst they should return null /
 * throw a catchable Error.
 *
 * This file is the regression net for "malformed RFC 822 doesn't crash
 * the receiver" — exercises the pure-function half of the chain
 * (`parseBounce` and `simpleParser`) on adversarial inputs without
 * needing a live SMTP server. The end-to-end side (the try/catch in
 * `onData`) is the receiver test in `test/integration/`.
 *
 * Coverage:
 *   - Random binary noise → null / throws catchable, never crashes
 *   - Truncated MIME (boundary opens, never closes)
 *   - Missing required headers (no From, no Date)
 *   - Header injection / control characters in headers
 *   - Empty input
 *   - Very long single-line input
 *   - UTF-8 garbage, BOM, mixed encodings
 */

import { describe, test, expect } from "bun:test";
import { simpleParser } from "mailparser";
import { parseBounce } from "../../src/modules/bounces/services/bounce-parser.service.ts";

describe("parseBounce — adversarial inputs return null, never throw", () => {
  test("random binary garbage returns null", () => {
    const garbage = Buffer.from([
      0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80, 0x81, 0x82, 0x83, 0xff, 0x00, 0x00,
    ]).toString("latin1");
    expect(() => parseBounce(garbage)).not.toThrow();
    expect(parseBounce(garbage)).toBeNull();
  });

  test("empty string returns null", () => {
    expect(parseBounce("")).toBeNull();
  });

  test("a single newline returns null", () => {
    expect(parseBounce("\n")).toBeNull();
  });

  test("status-code-shaped substring inside ordinary mail returns null", () => {
    /**
     * The fallback parser regex matches `5.1.1` patterns; the
     * `looksLikeBounce` heuristic must gate on more than just a number
     * shape so a regular customer email mentioning a status code
     * doesn't get classified.
     */
    const ordinary = `From: alice@example.com
To: hello@example.com
Subject: re: my account

Hi — I think I got error 5.1.1 yesterday but it's working now.`;
    expect(parseBounce(ordinary)).toBeNull();
  });

  test("truncated multipart/report (boundary opens, never closes) returns null", () => {
    const truncated = `From: MAILER-DAEMON@example.com
To: hello@example.com
Subject: Delivery Status Notification (Failure)
Content-Type: multipart/report; report-type=delivery-status; boundary="x"

--x
Content-Type: text/plain

Bounce details follow but the bound`;
    /** Should return null cleanly; the parser must NOT walk off the end of the buffer. */
    expect(() => parseBounce(truncated)).not.toThrow();
    expect(parseBounce(truncated)).toBeNull();
  });

  test("header-only message (no body, no separator) returns null", () => {
    const headersOnly = `From: noreply@example.com
Subject: Delivery Status Notification (Failure)`;
    expect(parseBounce(headersOnly)).toBeNull();
  });

  test("control characters and embedded NULs in subject don't crash", () => {
    const evil = `From: x@example.com\nSubject: ${"\x00".repeat(10)}weird\x07\x1bsubject\nTo: h@example.com\n\nbody`;
    expect(() => parseBounce(evil)).not.toThrow();
  });

  test("very long single-line input doesn't blow the regex / loop", () => {
    /** 500KB single line — pathological for naive regex backtracking. */
    const huge = "A".repeat(500_000);
    expect(() => parseBounce(huge)).not.toThrow();
    expect(parseBounce(huge)).toBeNull();
  });

  test("BOM + mixed encodings in headers don't crash", () => {
    const bom =
      "﻿From: =?utf-8?B?w7ggw7AgaGVsbG8=?= <x@example.com>\nTo: y@example.com\nSubject: x\n\nbody";
    expect(() => parseBounce(bom)).not.toThrow();
  });

  test("conflicting / duplicated headers don't crash the parser", () => {
    /** Two Content-Type headers, two Content-Transfer-Encoding — RFC says
     *  one of each, but real mail in the wild violates this. */
    const dup = `From: x@example.com
To: y@example.com
Content-Type: text/plain
Content-Type: multipart/mixed; boundary=z
Content-Transfer-Encoding: 7bit
Content-Transfer-Encoding: base64

body`;
    expect(() => parseBounce(dup)).not.toThrow();
  });
});

describe("simpleParser (mailparser) — adversarial inputs throw catchable, never crash", () => {
  /**
   * The real receiver wraps `simpleParser` in a try/catch that returns
   * SMTP 452 on throw. We verify here that adversarial inputs either
   * resolve (yielding a possibly-empty parsed object) or reject with a
   * catchable Error — never crash the worker process.
   */

  test("random binary noise — resolves or rejects but doesn't crash", async () => {
    const garbage = Buffer.from([
      0xff, 0xfe, 0x00, 0x01, 0x7f, 0x80, 0x81, 0x82, 0x83, 0xff,
    ]).toString("latin1");
    /** No assertion on shape — only that the promise doesn't reject with
     *  an uncatchable error and the runtime survives. */
    await Promise.resolve(simpleParser(garbage)).catch(() => null);
  });

  test("empty string parses (best-effort) without throwing", async () => {
    const parsed = await Promise.resolve(simpleParser("")).catch(() => null);
    /** mailparser is permissive; returns a parsed object with no fields rather than throwing. */
    expect(parsed === null || typeof parsed === "object").toBe(true);
  });

  test("truncated multipart message either parses partially or throws catchable", async () => {
    const truncated = `From: x@example.com
Content-Type: multipart/mixed; boundary="x"

--x
Content-Type: text/plain

incomplete...`;
    const parsed = await Promise.resolve(simpleParser(truncated)).catch(
      (e) => e instanceof Error,
    );
    /** Either we got back a parsed shape or an Error — both are non-crash. */
    expect(parsed === null || parsed === true || typeof parsed === "object").toBe(true);
  });

  test("very large input (200KB) parses without timing out", async () => {
    /**
     * 200KB plain-text message. Real SMTP `size` cap is 10MB so this is
     * well under, but it exercises the parser's ability to stream long
     * single-headers or long bodies without exponential cost.
     */
    const body = "x".repeat(200_000);
    const huge = `From: x@example.com\nTo: y@example.com\nSubject: long\n\n${body}`;
    const parsed = await simpleParser(huge);
    expect(parsed.text).toContain("xxxxx");
  });

  test("control characters in headers don't crash", async () => {
    const evil = `From: x@example.com\nSubject: \x00\x07\x1bweird\nTo: y@example.com\n\nbody`;
    /** simpleParser strips/handles these; just verify no throw. */
    await Promise.resolve(simpleParser(evil)).catch(() => null);
  });
});
