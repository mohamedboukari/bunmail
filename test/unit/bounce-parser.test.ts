import { describe, test, expect } from "bun:test";
import { parseBounce } from "../../src/modules/bounces/services/bounce-parser.service.ts";

/**
 * Unit tests for the DSN parser. Pure function — fixtures in, parsed
 * shape out. No DB, no mocks needed.
 *
 * Coverage:
 *   - RFC 3464 hard bounce (5.x.x)
 *   - RFC 3464 soft bounce (4.x.x)
 *   - Non-RFC fallback (qmail-style plain text)
 *   - 2.x.x "delivered" reports → null
 *   - DSN without Original-Message-ID → null
 *   - Non-bounce mail with status-code-shaped strings → null
 */

const RFC_HARD_BOUNCE = `From: MAILER-DAEMON@gmail.com
To: hello@yourdns.example
Subject: Delivery Status Notification (Failure)
Content-Type: multipart/report; report-type=delivery-status; boundary="--boundary"

----boundary
Content-Type: text/plain; charset=us-ascii

Delivery to the following recipient failed permanently:

     nonexistent@example.com

Technical details of permanent failure:
The email account that you tried to reach does not exist.

----boundary
Content-Type: message/delivery-status

Reporting-MTA: dns; gmail.com
Original-Message-ID: <abc-123-def@yourdns.example>

Final-Recipient: rfc822; nonexistent@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does not exist.

----boundary--
`;

const RFC_SOFT_BOUNCE = `From: postmaster@yahoo.com
To: hello@yourdns.example
Subject: Delivery Status Notification
Content-Type: multipart/report; report-type=delivery-status; boundary="--b"

----b
Content-Type: text/plain

Mailbox is full.

----b
Content-Type: message/delivery-status

Reporting-MTA: dns; yahoo.com
Original-Message-ID: <soft-456@yourdns.example>

Final-Recipient: rfc822; <full@example.com>
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox over quota

----b--
`;

const RFC_DELIVERED_REPORT = `From: MAILER-DAEMON@example.org
To: hello@yourdns.example
Subject: Delivery Status Notification (Success)
Content-Type: multipart/report; report-type=delivery-status; boundary="--b"

----b
Content-Type: message/delivery-status

Reporting-MTA: dns; example.org
Original-Message-ID: <good-789@yourdns.example>

Final-Recipient: rfc822; user@example.org
Action: delivered
Status: 2.0.0

----b--
`;

const RFC_BOUNCE_WITHOUT_ORIGINAL_ID = `From: MAILER-DAEMON@gmail.com
To: hello@yourdns.example
Subject: Delivery Status Notification (Failure)
Content-Type: multipart/report; report-type=delivery-status; boundary="--b"

----b
Content-Type: message/delivery-status

Reporting-MTA: dns; gmail.com

Final-Recipient: rfc822; lost@example.com
Status: 5.1.1
Diagnostic-Code: smtp; 550 user unknown

----b--
`;

const QMAIL_FALLBACK_BOUNCE = `From: MAILER-DAEMON@old-mta.example.net
To: hello@yourdns.example
Subject: failure notice
In-Reply-To: <orig-fallback-001@yourdns.example>
Content-Type: text/plain

Hi. This is the qmail-send program.
I'm afraid I wasn't able to deliver your message to the following addresses.

<broken@example.com>:
Sorry, no mailbox here by that name. (#5.1.1)

--- Below this line is a copy of the message.

Message-ID: <orig-fallback-001@yourdns.example>
From: hello@yourdns.example
To: broken@example.com
Subject: hi
`;

const NORMAL_INBOUND_MAIL = `From: alice@gmail.com
To: hello@yourdns.example
Subject: hello there
Content-Type: text/plain

Hey! Just wanted to say my server returned 5.1.1 last week (totally
unrelated technical mention), but everything's fine now. Reply when you can.
`;

describe("parseBounce — RFC 3464 path", () => {
  test("parses a hard bounce (5.1.1) and links to Original-Message-ID", () => {
    const parsed = parseBounce(RFC_HARD_BOUNCE);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("hard");
    expect(parsed!.recipient).toBe("nonexistent@example.com");
    expect(parsed!.originalMessageId).toBe("abc-123-def@yourdns.example");
    expect(parsed!.status).toBe("5.1.1");
    expect(parsed!.diagnostic).toContain("does not exist");
    expect(parsed!.source).toBe("rfc3464");
  });

  test("parses a soft bounce (4.2.2 mailbox full)", () => {
    const parsed = parseBounce(RFC_SOFT_BOUNCE);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("soft");
    expect(parsed!.recipient).toBe("full@example.com");
    expect(parsed!.originalMessageId).toBe("soft-456@yourdns.example");
    expect(parsed!.status).toBe("4.2.2");
    expect(parsed!.source).toBe("rfc3464");
  });

  test("returns null for a 2.x.x delivered report (not a bounce)", () => {
    expect(parseBounce(RFC_DELIVERED_REPORT)).toBeNull();
  });

  test("returns null when Original-Message-ID is missing — can't link to a tenant", () => {
    expect(parseBounce(RFC_BOUNCE_WITHOUT_ORIGINAL_ID)).toBeNull();
  });
});

describe("parseBounce — fallback path", () => {
  test("parses a qmail-style plain-text bounce via In-Reply-To", () => {
    const parsed = parseBounce(QMAIL_FALLBACK_BOUNCE);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("hard");
    expect(parsed!.recipient).toBe("broken@example.com");
    expect(parsed!.originalMessageId).toBe("orig-fallback-001@yourdns.example");
    /** Fallback path emits "5.1.1" (the enhanced code we found in the body). */
    expect(parsed!.status).toBe("5.1.1");
    expect(parsed!.source).toBe("fallback");
  });

  test("returns null on regular inbound mail that happens to mention a status code", () => {
    /**
     * The looksLikeBounce gate keeps us from mis-classifying customer
     * reply mail as a bounce just because the body contains "5.1.1".
     */
    expect(parseBounce(NORMAL_INBOUND_MAIL)).toBeNull();
  });
});
