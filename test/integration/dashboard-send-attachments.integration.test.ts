/**
 * Attachments from the dashboard Send form (#488), through the real
 * `pagesPlugin` and `createEmail`, against real Postgres:
 *
 * - a multipart send stores each file as an attachment, in order;
 * - the empty part a browser posts when no file is chosen is ignored;
 * - the REST rules apply unchanged: a blocked type or more than 10 files
 *   is refused with its own flash, and nothing is queued;
 * - a url-encoded post (no file field at all) still sends.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { asc, eq } from "drizzle-orm";
import { db, emails, seed, truncateAll } from "./_helpers.ts";
import { emailAttachments } from "../../src/modules/emails/models/email-attachment.schema.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { withRequestContext } from "../../src/middleware/request-context.ts";
import { flashOfResponse } from "../flash-of.ts";

const dashboard = new Elysia().wrap(withRequestContext).use(pagesPlugin);

let token = "";
let keyId = "";

beforeEach(async () => {
  await truncateAll();
  const { id: userId } = await seed.user({ email: "member@acme.test", role: "member" });
  token = (await seed.session({ userId })).token;
  keyId = (await seed.apiKey({ name: "member-key", createdByUserId: userId })).id;
  await seed.domain({ name: "acme.test" });
});

/** The text fields of a valid send. */
function fields(): Record<string, string> {
  return {
    apiKeyId: keyId,
    from: "support@acme.test",
    to: "customer@example.org",
    subject: "files",
    text: "see attached",
  };
}

/** Posts the Send form as multipart, as the browser does with a file input. */
function postMultipart(files: File[]): Promise<Response> {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields())) form.append(name, value);
  for (const file of files) form.append("attachments", file);
  return dashboard.handle(
    new Request("http://localhost/dashboard/send", {
      method: "POST",
      headers: { cookie: `bm_session=${token}`, origin: "http://localhost" },
      body: form,
    }),
  );
}

/** The attachments stored for the only queued email, in order. */
async function storedAttachments(): Promise<
  Array<{ filename: string; content: string }>
> {
  const [email] = await db.select().from(emails);
  if (!email) throw new Error("no email queued");
  const rows = await db
    .select()
    .from(emailAttachments)
    .where(eq(emailAttachments.emailId, email.id))
    .orderBy(asc(emailAttachments.position));
  return rows.map((row) => ({
    filename: row.filename,
    content: Buffer.from(row.content ?? new Uint8Array()).toString("utf8"),
  }));
}

describe("dashboard send with attachments", () => {
  test("stores each chosen file as an attachment, in order", async () => {
    const response = await postMultipart([
      new File(["first file"], "notes.txt", { type: "text/plain" }),
      new File(["a,b\n1,2\n"], "report.csv", { type: "text/csv" }),
    ]);

    expect(response.status).toBe(302);
    expect(flashOfResponse(response)?.message).toContain("Email queued for delivery");
    expect(await storedAttachments()).toEqual([
      { filename: "notes.txt", content: "first file" },
      { filename: "report.csv", content: "a,b\n1,2\n" },
    ]);
  });

  test("ignores the empty part posted when no file is chosen", async () => {
    const response = await postMultipart([new File([], "")]);

    expect(flashOfResponse(response)?.message).toContain("Email queued for delivery");
    expect(await storedAttachments()).toEqual([]);
  });

  test("a blocked file type is refused with its flash, nothing queued", async () => {
    const response = await postMultipart([new File(["MZ"], "setup.exe")]);

    expect(flashOfResponse(response)?.message).toContain("file type is not allowed");
    expect(await db.select().from(emails)).toEqual([]);
  });

  test("more than 10 files is refused with the limit, nothing queued", async () => {
    const files = Array.from({ length: 11 }, (_, i) => new File(["x"], `f${i}.txt`));
    const response = await postMultipart(files);

    expect(flashOfResponse(response)?.message).toBe("At most 10 attachments per email.");
    expect(await db.select().from(emails)).toEqual([]);
  });

  test("a url-encoded post without the file field still sends", async () => {
    const response = await dashboard.handle(
      new Request("http://localhost/dashboard/send", {
        method: "POST",
        headers: {
          cookie: `bm_session=${token}`,
          origin: "http://localhost",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields()).toString(),
      }),
    );

    expect(flashOfResponse(response)?.message).toContain("Email queued for delivery");
    expect(await storedAttachments()).toEqual([]);
  });
});
