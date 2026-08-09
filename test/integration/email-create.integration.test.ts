/**
 * Integration tests for `email.service.createEmail` against a real
 * Postgres. Exercises the suppression gate (#25), template lookup,
 * and domain FK linking against actual schema constraints.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
  createEmail,
  listEmails,
  listAllEmails,
} from "../../src/modules/emails/services/email.service.ts";
import { SuppressedRecipientError } from "../../src/modules/suppressions/errors.ts";
import { truncateAll, seed, db, emails } from "./_helpers.ts";

beforeEach(async () => {
  await truncateAll();
});

describe("createEmail — happy path", () => {
  test("inserts a row in 'queued' status with FK to api_key and domain", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: domainId, name } = await seed.domain();

    const email = await createEmail(
      {
        from: `hello@${name}`,
        to: "user@example.org",
        subject: "test",
        html: "<p>hi</p>",
      },
      apiKeyId,
    );

    expect(email.id).toMatch(/^msg_/);
    expect(email.status).toBe("queued");
    expect(email.apiKeyId).toBe(apiKeyId);
    expect(email.domainId).toBe(domainId);
    expect(email.fromAddress).toBe(`hello@${name}`);
    expect(email.toAddress).toBe("user@example.org");
  });

  test("leaves domainId null when sender domain isn't registered (in dev mode)", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    /** No domain row inserted — sender domain unknown. In `BUNMAIL_ENV !==
     *  'production'` (default for tests), createEmail allows this. */
    const email = await createEmail(
      {
        from: "hello@unregistered.test",
        to: "user@example.org",
        subject: "test",
        html: "<p>hi</p>",
      },
      apiKeyId,
    );
    expect(email.domainId).toBeNull();
  });
});

describe("createEmail — suppression gate (#25)", () => {
  test("throws SuppressedRecipientError when recipient has a permanent suppression", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: supId } = await seed.suppression({
      apiKeyId,
      email: "blocked@example.com",
      reason: "manual",
    });

    let thrown: unknown;
    try {
      await createEmail(
        {
          from: "hello@yourdns.example",
          to: "blocked@example.com",
          subject: "should not reach queue",
          html: "<p>x</p>",
        },
        apiKeyId,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SuppressedRecipientError);
    expect((thrown as SuppressedRecipientError).suppressionId).toBe(supId);
    expect((thrown as SuppressedRecipientError).recipient).toBe("blocked@example.com");

    /** No row inserted — gate fires before INSERT. */
    const all = await db.select().from(emails);
    expect(all).toHaveLength(0);
  });

  test("normalises recipient address — case+whitespace doesn't bypass the gate", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.suppression({
      apiKeyId,
      email: "blocked@example.com",
      reason: "manual",
    });
    let thrown: unknown;
    try {
      await createEmail(
        {
          from: "hello@yourdns.example",
          to: "  Blocked@Example.COM  ",
          subject: "x",
          html: "<p>x</p>",
        },
        apiKeyId,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SuppressedRecipientError);
  });

  test("expired soft suppression does NOT block the send", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await seed.suppression({
      apiKeyId,
      email: "soft@example.com",
      reason: "bounce",
      bounceType: "soft",
      expiresAt: new Date(Date.now() - 60_000),
    });
    /** No throw — suppression is past its expiry. */
    const email = await createEmail(
      {
        from: "hello@yourdns.example",
        to: "soft@example.com",
        subject: "x",
        html: "<p>x</p>",
      },
      apiKeyId,
    );
    expect(email.status).toBe("queued");
  });

  test("suppression is per-API-key — tenant B can still send to address suppressed by tenant A", async () => {
    const { id: keyA } = await seed.apiKey({ name: "tenant-a" });
    const { id: keyB } = await seed.apiKey({ name: "tenant-b" });
    await seed.suppression({
      apiKeyId: keyA,
      email: "user@example.com",
      reason: "manual",
    });

    /** B's send goes through normally. */
    const email = await createEmail(
      {
        from: "hello@yourdns.example",
        to: "user@example.com",
        subject: "x",
        html: "<p>x</p>",
      },
      keyB,
    );
    expect(email.status).toBe("queued");
  });
});

describe("createEmail — template-based send", () => {
  test("resolves the template and substitutes variables", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: tplId } = await seed.template({
      apiKeyId,
      subject: "Welcome {{name}}",
      html: "<h1>Hi {{name}}</h1>",
      text: "Hi {{name}}",
      variables: ["name"],
    });

    const email = await createEmail(
      {
        from: "hello@yourdns.example",
        to: "alice@example.com",
        templateId: tplId,
        variables: { name: "Alice" },
      },
      apiKeyId,
    );

    expect(email.subject).toBe("Welcome Alice");
    expect(email.html).toBe("<h1>Hi Alice</h1>");
    expect(email.textContent).toBe("Hi Alice");
  });

  test("throws when templateId belongs to a different api_key (cross-tenant lookup blocked)", async () => {
    const { id: keyA } = await seed.apiKey();
    const { id: keyB } = await seed.apiKey();
    const { id: tplId } = await seed.template({ apiKeyId: keyA });

    let thrown: unknown;
    try {
      await createEmail(
        {
          from: "hello@yourdns.example",
          to: "user@example.com",
          templateId: tplId,
          variables: {},
        },
        keyB,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toMatch(/Template .* not found/);
  });
});

describe("createEmail — FK ON DELETE SET NULL", () => {
  test("deleting a domain detaches its emails (sets domain_id to null)", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const { id: domainId, name } = await seed.domain();
    const { id: emailId } = await seed.email({
      apiKeyId,
      domainId,
      fromAddress: `hello@${name}`,
    });

    /** Delete the domain — schema's `ON DELETE SET NULL` should detach. */
    await db
      .delete((await import("../../src/modules/domains/models/domain.schema.ts")).domains)
      .where(
        eq(
          (await import("../../src/modules/domains/models/domain.schema.ts")).domains.id,
          domainId,
        ),
      );

    const [email] = await db.select().from(emails).where(eq(emails.id, emailId));
    expect(email?.domainId).toBeNull();
    /** Email row still exists — deleted domain shouldn't cascade-drop history. */
    expect(email?.id).toBe(emailId);
  });
});

describe("createEmail — source channel + filters (#137)", () => {
  test("defaults source to 'api'; SMTP path records 'smtp'", async () => {
    const { id: apiKeyId } = await seed.apiKey();

    const viaApi = await createEmail(
      { from: "a@example.com", to: "u@example.org", subject: "s", html: "<p>x</p>" },
      apiKeyId,
    );
    const viaSmtp = await createEmail(
      { from: "a@example.com", to: "u@example.org", subject: "s", html: "<p>x</p>" },
      apiKeyId,
      "smtp",
    );

    expect(viaApi.source).toBe("api");
    expect(viaSmtp.source).toBe("smtp");
  });

  test("listEmails filters by source (scoped to the calling key)", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await createEmail(
      { from: "a@example.com", to: "u@example.org", subject: "api", html: "<p>x</p>" },
      apiKeyId,
    );
    await createEmail(
      { from: "a@example.com", to: "u@example.org", subject: "smtp", html: "<p>x</p>" },
      apiKeyId,
      "smtp",
    );

    const smtpOnly = await listEmails(apiKeyId, { page: 1, limit: 20, source: "smtp" });
    expect(smtpOnly.total).toBe(1);
    expect(smtpOnly.data[0]?.subject).toBe("smtp");

    const apiOnly = await listEmails(apiKeyId, { page: 1, limit: 20, source: "api" });
    expect(apiOnly.total).toBe(1);
    expect(apiOnly.data[0]?.subject).toBe("api");

    const all = await listEmails(apiKeyId, { page: 1, limit: 20 });
    expect(all.total).toBe(2);
  });

  test("listAllEmails filters by apiKeyId (dashboard cross-key view)", async () => {
    const { id: keyA } = await seed.apiKey({ name: "Key A" });
    const { id: keyB } = await seed.apiKey({ name: "Key B" });
    await createEmail(
      { from: "a@example.com", to: "u@example.org", subject: "fromA", html: "<p>x</p>" },
      keyA,
    );
    await createEmail(
      { from: "a@example.com", to: "u@example.org", subject: "fromB", html: "<p>x</p>" },
      keyB,
      "smtp",
    );

    const onlyA = await listAllEmails({ page: 1, limit: 20, apiKeyId: keyA });
    expect(onlyA.total).toBe(1);
    expect(onlyA.data[0]?.subject).toBe("fromA");

    /** Compose apiKeyId + source: Key B + smtp → the one row. */
    const bSmtp = await listAllEmails({
      page: 1,
      limit: 20,
      apiKeyId: keyB,
      source: "smtp",
    });
    expect(bSmtp.total).toBe(1);
    expect(bSmtp.data[0]?.subject).toBe("fromB");

    /** Key B + api → none (its only row is smtp). */
    const bApi = await listAllEmails({
      page: 1,
      limit: 20,
      apiKeyId: keyB,
      source: "api",
    });
    expect(bApi.total).toBe(0);

    /** Unfiltered → both. */
    const all = await listAllEmails({ page: 1, limit: 20 });
    expect(all.total).toBe(2);
  });
});
