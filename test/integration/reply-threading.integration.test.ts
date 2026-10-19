/**
 * Threading of inbound mail and dashboard replies (#192), against real
 * Postgres, the real inbound SMTP receiver and the real dashboard routes:
 *
 * - a message through the receiver stores its validated `Message-ID`,
 *   `In-Reply-To` and `References`; hostile ids never get stored;
 * - a dashboard reply (`POST /dashboard/send` with the inbound id, as a
 *   signed-in member) queues an email whose stored custom headers carry
 *   the right `In-Reply-To` and `References`, also for a row received
 *   before the columns existed (recovered from `raw_message`), and never a
 *   header value posted by the form;
 * - a reply to an email BunMail sent is linked to it and shown on the
 *   inbound detail page, but never across sender domains.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { desc, eq } from "drizzle-orm";
import { createTransport } from "nodemailer";
import { db, emails, seed, truncateAll } from "./_helpers.ts";
import { inboundEmails } from "../../src/modules/inbound/models/inbound-email.schema.ts";
import * as smtpReceiver from "../../src/modules/inbound/services/smtp-receiver.service.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { config } from "../../src/config.ts";

/** Isolated port, distinct from the other SMTP test files. */
const INBOUND_PORT = 12598;

const dashboard = new Elysia().wrap(withRequestContext).use(pagesPlugin);

const savedSmtp = { ...config.smtp, spamProtection: { ...config.smtp.spamProtection } };
const savedNotify = config.inboundNotify.enabled;

beforeAll(() => {
  Object.assign(config.smtp, { port: INBOUND_PORT });
  Object.assign(config.smtp.spamProtection, {
    dnsblEnabled: false,
    rateLimitEnabled: false,
    recipientValidationEnabled: false,
  });
  Object.assign(config.inboundNotify, { enabled: false });
  smtpReceiver.start();
});

afterAll(() => {
  smtpReceiver.stop();
  Object.assign(config.smtp, { port: savedSmtp.port });
  Object.assign(config.smtp.spamProtection, savedSmtp.spamProtection);
  Object.assign(config.inboundNotify, { enabled: savedNotify });
});

let memberToken = "";
let memberKeyId = "";

beforeEach(async () => {
  await truncateAll();
  const { id: userId } = await seed.user({ email: "member@acme.test", role: "member" });
  memberToken = (await seed.session({ userId })).token;
  memberKeyId = (await seed.apiKey({ name: "member-key", createdByUserId: userId })).id;
  await seed.domain({ name: "acme.test" });
});

/** Delivers a raw message to the receiver with the given envelope recipient. */
async function deliverRaw(to: string, headers: string[], body = "hello"): Promise<void> {
  const transport = createTransport({
    host: "127.0.0.1",
    port: INBOUND_PORT,
    secure: false,
    ignoreTLS: true,
  });
  try {
    await transport.sendMail({
      envelope: { from: "customer@example.org", to: [to] },
      raw: [...headers, "", body, ""].join("\r\n"),
    });
  } finally {
    transport.close();
  }
}

/** The stored inbound row with `subject`, waiting for the receiver to commit it. */
async function inboundBySubject(
  subject: string,
): Promise<typeof inboundEmails.$inferSelect> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const [row] = await db
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.subject, subject));
    if (row) return row;
    if (Date.now() > deadline) throw new Error(`inbound "${subject}" not stored`);
    await Bun.sleep(20);
  }
}

/** A same-origin dashboard request as the member. */
function page(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = { cookie: `bm_session=${memberToken}` };
  const url = `http://localhost${path}`;
  if (method === "GET") return dashboard.handle(new Request(url, { headers }));
  headers["origin"] = "http://localhost";
  headers["content-type"] = "application/x-www-form-urlencoded";
  return dashboard.handle(
    new Request(url, {
      method: "POST",
      headers,
      body: new URLSearchParams(body ?? {}).toString(),
    }),
  );
}

/** Sends the dashboard reply form for `inboundId` and returns the queued email. */
async function reply(
  inboundId: string,
  extra: Record<string, string> = {},
): Promise<typeof emails.$inferSelect> {
  const response = await page("POST", "/dashboard/send", {
    apiKeyId: memberKeyId,
    from: "support@acme.test",
    to: "customer@example.org",
    subject: "Re: question",
    text: "answer",
    inboundId,
    ...extra,
  });
  expect(response.status).toBe(302);
  expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
    "Email queued for delivery",
  );
  const [row] = await db.select().from(emails).orderBy(desc(emails.createdAt)).limit(1);
  if (!row) throw new Error("no email queued");
  return row;
}

describe("capture on receipt", () => {
  test("stores the validated Message-ID, In-Reply-To and References chain", async () => {
    const subject = `capture ${crypto.randomUUID()}`;
    await deliverRaw("support@acme.test", [
      "From: customer@example.org",
      "To: support@acme.test",
      `Subject: ${subject}`,
      "Message-ID: <self-1@mail.example.org>",
      "In-Reply-To: <parent@mail.example.org> (the parent)",
      "References: <root@mail.example.org> (comment <fake@evil.test>)",
      " <bad id@evil.test> <parent@mail.example.org>",
      "\t<root@mail.example.org>",
    ]);

    const row = await inboundBySubject(subject);
    expect(row.messageId).toBe("<self-1@mail.example.org>");
    expect(row.inReplyTo).toBe("<parent@mail.example.org>");
    expect(row.references).toBe("<root@mail.example.org> <parent@mail.example.org>");
    expect(row.inReplyToEmailId).toBeNull();
  });

  test("hostile ids are never stored", async () => {
    const subject = `hostile ${crypto.randomUUID()}`;
    const overlong = `<${"a".repeat(300)}@evil.test>`;
    await deliverRaw("support@acme.test", [
      "From: customer@example.org",
      `Subject: ${subject}`,
      `Message-ID: ${overlong}`,
      "In-Reply-To: no-brackets@evil.test",
      'References: <"quoted"@evil.test> <é@evil.test> junk',
    ]);

    const row = await inboundBySubject(subject);
    expect(row.messageId).toBeNull();
    expect(row.inReplyTo).toBeNull();
    expect(row.references).toBeNull();
  });
});

describe("dashboard reply headers", () => {
  test("a reply carries In-Reply-To and the appended References chain", async () => {
    const subject = `reply ${crypto.randomUUID()}`;
    await deliverRaw("support@acme.test", [
      "From: customer@example.org",
      `Subject: ${subject}`,
      "Message-ID: <q2@mail.example.org>",
      "In-Reply-To: <q1@mail.example.org>",
      "References: <q0@mail.example.org> <q1@mail.example.org>",
    ]);
    const inbound = await inboundBySubject(subject);

    /** The reply page carries the inbound id, never header text. */
    const form = await (
      await page("GET", `/dashboard/inbound/${inbound.id}/reply`)
    ).text();
    expect(form).toContain(`name="inboundId" value="${inbound.id}"`);
    expect(form).not.toContain("q2@mail.example.org");

    const sent = await reply(inbound.id);
    expect(sent.headers).toEqual({
      "In-Reply-To": "<q2@mail.example.org>",
      References: "<q0@mail.example.org> <q1@mail.example.org> <q2@mail.example.org>",
    });
  });

  test("header values posted by the form are ignored", async () => {
    const subject = `forged ${crypto.randomUUID()}`;
    await deliverRaw("support@acme.test", [
      "From: customer@example.org",
      `Subject: ${subject}`,
      "Message-ID: <real@mail.example.org>",
    ]);
    const inbound = await inboundBySubject(subject);

    const sent = await reply(inbound.id, {
      "In-Reply-To": "<forged@evil.test>",
      References: "<forged@evil.test>",
      headers: "Bcc: victim@example.org",
    });
    expect(sent.headers).toEqual({
      "In-Reply-To": "<real@mail.example.org>",
      References: "<real@mail.example.org>",
    });
  });

  test("a row from before the migration recovers its ids from raw_message, once", async () => {
    const id = `inb_legacy_${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(inboundEmails).values({
      id,
      fromAddress: "customer@example.org",
      toAddress: "support@acme.test",
      subject: "legacy",
      textContent: "hi",
      rawMessage: [
        "From: customer@example.org",
        "Subject: legacy",
        "Message-ID: <legacy@mail.example.org>",
        "References: <old-root@mail.example.org>\r\n <bad id@evil.test>",
        "",
        "Message-ID: <body-not-header@evil.test>",
      ].join("\r\n"),
    });

    const sent = await reply(id);
    expect(sent.headers).toEqual({
      "In-Reply-To": "<legacy@mail.example.org>",
      References: "<old-root@mail.example.org> <legacy@mail.example.org>",
    });

    const [row] = await db.select().from(inboundEmails).where(eq(inboundEmails.id, id));
    expect(row?.messageId).toBe("<legacy@mail.example.org>");
    expect(row?.references).toBe("<old-root@mail.example.org>");
  });

  test("an original without a valid Message-ID is answered without threading headers", async () => {
    const subject = `no-id ${crypto.randomUUID()}`;
    await deliverRaw("support@acme.test", [
      "From: customer@example.org",
      `Subject: ${subject}`,
      "Message-ID: <broken id@evil.test>",
      "References: <r@mail.example.org>",
    ]);
    const inbound = await inboundBySubject(subject);
    const sent = await reply(inbound.id);
    expect(sent.headers).toBeNull();
  });
});

describe("linking a reply to the email it answers", () => {
  test("links to our email on the same domain and shows it; never across domains", async () => {
    const ours = await seed.email({
      apiKeyId: memberKeyId,
      fromAddress: "hello@acme.test",
      subject: "Your invoice",
      status: "sent",
      messageId: "<out-1@mail.acme.test>",
    });
    const otherTenant = await seed.email({
      apiKeyId: memberKeyId,
      fromAddress: "hello@other.test",
      subject: "Other tenant mail",
      status: "sent",
      messageId: "<out-2@mail.other.test>",
    });

    const linkedSubject = `linked ${crypto.randomUUID()}`;
    await deliverRaw("support@acme.test", [
      "From: customer@example.org",
      `Subject: ${linkedSubject}`,
      "Message-ID: <answer-1@mail.example.org>",
      "In-Reply-To: <out-1@mail.acme.test>",
      "References: <out-1@mail.acme.test>",
    ]);
    const linked = await inboundBySubject(linkedSubject);
    expect(linked.inReplyToEmailId).toBe(ours.id);

    const html = await (await page("GET", `/dashboard/inbound/${linked.id}`)).text();
    expect(html).toContain("In reply to");
    expect(html).toContain(`href="/dashboard/emails/${ours.id}"`);
    expect(html).toContain("Your invoice");

    /** The other tenant's Message-ID, received on acme.test: no link. */
    const crossSubject = `cross ${crypto.randomUUID()}`;
    await deliverRaw("support@acme.test", [
      "From: customer@example.org",
      `Subject: ${crossSubject}`,
      "Message-ID: <answer-2@mail.example.org>",
      "In-Reply-To: <out-2@mail.other.test>",
    ]);
    const cross = await inboundBySubject(crossSubject);
    expect(cross.inReplyToEmailId).toBeNull();
    const crossHtml = await (await page("GET", `/dashboard/inbound/${cross.id}`)).text();
    expect(crossHtml).not.toContain("In reply to");
    expect(crossHtml).not.toContain(otherTenant.id);
  });

  test("a References id links when In-Reply-To names someone else's message", async () => {
    const ours = await seed.email({
      apiKeyId: memberKeyId,
      fromAddress: "hello@acme.test",
      status: "sent",
      messageId: "<out-3@mail.acme.test>",
    });
    const subject = `deep ${crypto.randomUUID()}`;
    await deliverRaw("support@acme.test", [
      "From: customer@example.org",
      `Subject: ${subject}`,
      "Message-ID: <answer-3@mail.example.org>",
      "In-Reply-To: <someone@mail.example.org>",
      "References: <out-3@mail.acme.test> <someone@mail.example.org>",
    ]);
    expect((await inboundBySubject(subject)).inReplyToEmailId).toBe(ours.id);
  });
});
