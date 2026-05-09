/**
 * End-to-end test for the inbound DSN flow (#35, bullets 4 + 5).
 *
 * The SMTP receiver, when a DSN arrives, calls
 * `parseBounce(rawMessage)` → `handleParsedBounce(parsed)`. Both are
 * exported, so we exercise the full chain here against real Postgres
 * + a captured `fetch` for webhook dispatch — the same pattern used
 * by `webhook-dispatch.integration.test.ts`. The closure in
 * `smtp-receiver.service.ts` adds nothing extra; this test covers the
 * DB + webhook side effects identically.
 *
 * Coverage:
 *   - Hard bounce DSN → suppression row, email row marked bounced,
 *     `email.bounced` webhook fired with correct payload (signed)
 *   - Soft bounce DSN → time-windowed suppression row + bounced email
 *     + webhook
 *   - Soft bounce on top of an existing soft suppression → escalation
 *     to hard (24h-window logic from #24)
 *   - DSN that doesn't link to any of our `emails` rows → dropped
 *     with a warning, no DB writes, no webhook
 *
 * What this file deliberately does NOT cover:
 *   - The `onData` chunk-streaming + size-cap loop. Those live in the
 *     SMTPServer event handler closure. Bullet 2 (50MB rejection) is
 *     enforced in two layers: at the protocol level by the smtp-server
 *     library's SIZE extension (already trusted upstream) and as a
 *     belt-and-suspenders chunk guard in the closure (would require
 *     either a real SMTPServer boot on an ephemeral port or extracting
 *     the buffer logic — deferred). Documented in #35's PR.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { parseBounce } from "../../src/modules/bounces/services/bounce-parser.service.ts";
import { handleParsedBounce } from "../../src/modules/bounces/services/bounce-handler.service.ts";
import { truncateAll, seed, db, emails, suppressions } from "./_helpers.ts";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

const captured: CapturedRequest[] = [];
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  await truncateAll();
  captured.length = 0;
  globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    captured.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : "",
    });
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Wait for `dispatchEvent`'s fire-and-forget chain to drain. */
async function waitForDispatch(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Builds an RFC 3464 hard-bounce message linking back to the given
 * Original-Message-ID and recipient. Mirrors what Gmail / Outlook send
 * when a recipient mailbox doesn't exist.
 */
function makeHardBounceDsn(originalMessageId: string, recipient: string): string {
  return `From: MAILER-DAEMON@receiver.example
To: hello@example.com
Subject: Delivery Status Notification (Failure)
Content-Type: multipart/report; report-type=delivery-status; boundary="--bnd"

----bnd
Content-Type: text/plain

Delivery to ${recipient} failed permanently:
The email account that you tried to reach does not exist.

----bnd
Content-Type: message/delivery-status

Final-Recipient: rfc822; ${recipient}
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.
Original-Message-ID: <${originalMessageId}>

----bnd--`;
}

/** Same but returns a soft 4.x.x bounce (mailbox temporarily over quota). */
function makeSoftBounceDsn(originalMessageId: string, recipient: string): string {
  return `From: MAILER-DAEMON@receiver.example
To: hello@example.com
Subject: Delivery Status Notification (Delay)
Content-Type: multipart/report; report-type=delivery-status; boundary="--bnd"

----bnd
Content-Type: text/plain

Delivery to ${recipient} delayed:
Mailbox is temporarily over quota.

----bnd
Content-Type: message/delivery-status

Final-Recipient: rfc822; ${recipient}
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox over quota
Original-Message-ID: <${originalMessageId}>

----bnd--`;
}

describe("inbound DSN → bounce handler — end-to-end (#35 bullets 4 + 5)", () => {
  test("hard bounce: suppression created, email marked bounced, email.bounced webhook fired", async () => {
    /** Seed: an api key, an email row that was previously sent, and a
     *  webhook subscribed to email.bounced. */
    const { id: apiKeyId } = await seed.apiKey();
    const messageId = "test-hard-001@example.com";
    const recipient = "nonexistent@example.com";
    const { id: emailId } = await seed.email({
      apiKeyId,
      toAddress: recipient,
      status: "sent",
      messageId: `<${messageId}>`,
    });
    await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/bounce",
      events: ["email.bounced"],
    });

    /** Run the same chain `onData` runs when a DSN arrives. */
    const parsed = parseBounce(makeHardBounceDsn(messageId, recipient));
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("hard");
    expect(parsed!.recipient).toBe(recipient);

    const result = await handleParsedBounce(parsed!);
    expect(result.outcome).toBe("applied");
    expect(result.bounceType).toBe("hard");

    /** Bullet 4: a suppression row exists for this recipient on this api key. */
    const supRows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.apiKeyId, apiKeyId));
    expect(supRows).toHaveLength(1);
    expect(supRows[0]?.email).toBe(recipient);
    expect(supRows[0]?.bounceType).toBe("hard");
    expect(supRows[0]?.reason).toBe("bounce");
    expect(supRows[0]?.expiresAt).toBeNull(); /** Hard = permanent. */
    expect(supRows[0]?.sourceEmailId).toBe(emailId);

    /** The original email row is now `bounced`. */
    const emailRow = (await db.select().from(emails).where(eq(emails.id, emailId)))[0];
    expect(emailRow?.status).toBe("bounced");

    /** Bullet 5: the email.bounced webhook fired. */
    await waitForDispatch();
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe("https://hook.example.com/bounce");
    expect(req.method).toBe("POST");
    expect(req.headers["x-bunmail-event"]).toBe("email.bounced");
    expect(req.headers["x-bunmail-signature"]).toMatch(/^[a-f0-9]{64}$/);

    const body = JSON.parse(req.body);
    expect(body.event).toBe("email.bounced");
    expect(body.data.emailId).toBe(emailId);
    expect(body.data.to).toBe(recipient);
    expect(body.data.bounceType).toBe("hard");
    expect(body.data.status).toBe("5.1.1");
    expect(body.data.suppressionId).toBe(supRows[0]?.id);
  });

  test("soft bounce: time-windowed suppression, email bounced, webhook fires with bounceType=soft", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const messageId = "test-soft-001@example.com";
    const recipient = "user@quota.example";
    const { id: emailId } = await seed.email({
      apiKeyId,
      toAddress: recipient,
      status: "sent",
      messageId: `<${messageId}>`,
    });
    await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/bounce",
      events: ["email.bounced"],
    });

    const parsed = parseBounce(makeSoftBounceDsn(messageId, recipient));
    expect(parsed!.kind).toBe("soft");

    const result = await handleParsedBounce(parsed!);
    expect(result.outcome).toBe("applied");
    expect(result.bounceType).toBe("soft");

    /** Soft = time-windowed (24h from now); expiresAt is set. */
    const supRows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, recipient));
    expect(supRows).toHaveLength(1);
    expect(supRows[0]?.bounceType).toBe("soft");
    expect(supRows[0]?.expiresAt).not.toBeNull();
    /** Roughly 24h from now, plus or minus the test-runtime drift. */
    const expiresAtMs = supRows[0]!.expiresAt!.getTime();
    const expectedMs = Date.now() + 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAtMs - expectedMs)).toBeLessThan(60_000);

    /** Email row is bounced even on a soft (the row stays bounced; the
     *  next send to this address gates on the suppression rather than
     *  re-trying the same row). */
    const emailRow = (await db.select().from(emails).where(eq(emails.id, emailId)))[0];
    expect(emailRow?.status).toBe("bounced");

    await waitForDispatch();
    const body = JSON.parse(captured[0]!.body);
    expect(body.data.bounceType).toBe("soft");
    expect(body.data.status).toBe("4.2.2");
  });

  test("soft bounce escalates to hard when an active soft suppression already exists", async () => {
    /** Repeat soft bounces are effectively permanent for IP-rep purposes — #24's escalation rule. */
    const { id: apiKeyId } = await seed.apiKey();
    const messageId = "test-soft-escalate-001@example.com";
    const recipient = "repeat@example.com";
    await seed.email({
      apiKeyId,
      toAddress: recipient,
      status: "sent",
      messageId: `<${messageId}>`,
    });
    /** First soft bounce already on file (24h not yet elapsed). */
    await seed.suppression({
      apiKeyId,
      email: recipient,
      reason: "bounce",
      bounceType: "soft",
      expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1000),
    });
    await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/bounce",
      events: ["email.bounced"],
    });

    const parsed = parseBounce(makeSoftBounceDsn(messageId, recipient));
    const result = await handleParsedBounce(parsed!);

    expect(result.outcome).toBe("escalated");
    expect(result.bounceType).toBe("hard");

    /** The upsert path means the suppression row was either updated to
     *  hard / permanent (expiresAt = null) OR replaced. Either way, the
     *  surviving row should reflect hard / permanent. */
    const supRows = await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.email, recipient));
    expect(supRows).toHaveLength(1);
    expect(supRows[0]?.bounceType).toBe("hard");
    expect(supRows[0]?.expiresAt).toBeNull();

    await waitForDispatch();
    const body = JSON.parse(captured[0]!.body);
    /** Webhook reflects the escalated kind, not the parsed soft. */
    expect(body.data.bounceType).toBe("hard");
  });

  test("DSN that doesn't link to any emails row is dropped: no DB writes, no webhook", async () => {
    /** The DSN claims an Original-Message-ID we've never sent. The
     *  handler refuses to act under "we don't know which tenant this
     *  belongs to" — better than risking suppressing under the wrong key. */
    const { id: apiKeyId } = await seed.apiKey();
    await seed.webhook({
      apiKeyId,
      url: "https://hook.example.com/bounce",
      events: ["email.bounced"],
    });

    const parsed = parseBounce(
      makeHardBounceDsn("never-sent-by-us@example.com", "stranger@example.com"),
    );
    expect(parsed).not.toBeNull();

    const result = await handleParsedBounce(parsed!);
    expect(result.outcome).toBe("dropped-no-original");

    /** No suppression created. */
    const supRows = await db.select().from(suppressions);
    expect(supRows).toHaveLength(0);

    /** No webhook fired. */
    await waitForDispatch();
    expect(captured).toHaveLength(0);
  });
});
