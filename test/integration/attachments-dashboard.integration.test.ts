/**
 * Attachments in the dashboard (#181), through the real `pagesPlugin`
 * behind the app's security headers, against real Postgres.
 *
 * - The email page lists the attachments, escaped, with their sizes.
 * - `GET /dashboard/emails/:id/attachments/:position` follows the email
 *   page's guard (members may view emails, so members may download) and
 *   always answers a forced download: `application/octet-stream`,
 *   `Content-Disposition: attachment` with the RFC 5987 name, `nosniff`,
 *   a sandbox CSP and `no-store`, whatever the file is.
 * - Once the bytes are dropped it answers 410 with a page saying so.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { securityHeadersPlugin } from "../../src/middleware/security-headers.ts";
import { createEmail } from "../../src/modules/emails/services/email.service.ts";
import { emailAttachments } from "../../src/modules/emails/models/email-attachment.schema.ts";
import type { UserRole } from "../../src/modules/users/types/user.types.ts";
import { db, seed, truncateAll } from "./_helpers.ts";

/** The dashboard as `src/index.ts` mounts it: security headers first. */
const app = new Elysia()
  .use(securityHeadersPlugin({ httpsBaseUrl: false }))
  .use(pagesPlugin);

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** An HTML file: must never be rendered by the dashboard's origin. */
const HTML_FILE = Buffer.from("<html><script>alert(document.cookie)</script></html>");

/** A filename that would be markup if it were not escaped. */
const MARKUP_NAME = "<img src=x onerror=alert(1)> résumé.html";

let emailId = "";

/** A session token for a fresh user of `role`. */
async function tokenFor(role: UserRole): Promise<string> {
  const { id } = await seed.user({ email: `${role}-${Date.now()}@example.com`, role });
  return (await seed.session({ userId: id })).token;
}

/** GETs a dashboard path with the session token (none: anonymous). */
function get(path: string, token?: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: token ? { cookie: `bm_session=${token}` } : {},
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
  const { id: apiKeyId } = await seed.apiKey();
  const created = await createEmail(
    {
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: "files",
      text: "see attached",
      attachments: [
        { filename: MARKUP_NAME, content: HTML_FILE.toString("base64") },
        { filename: "logo.png", content: PNG.toString("base64"), contentId: "logo" },
      ],
    },
    apiKeyId,
  );
  emailId = created.email.id;
});

describe("email page", () => {
  test("lists the attachments, escaped, with sizes and download links", async () => {
    const res = await get(`/dashboard/emails/${emailId}`, await tokenFor("member"));
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Attachments");
    expect(page).not.toContain("<img src=x onerror");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page).toContain(`${HTML_FILE.byteLength} B`);
    expect(page).toContain("cid:logo");
    expect(page).toContain(`/dashboard/emails/${emailId}/attachments/0`);
    expect(page).toContain(`/dashboard/emails/${emailId}/attachments/1`);
  });
});

describe("download route", () => {
  test("an admin gets the bytes with every safety header", async () => {
    const res = await get(
      `/dashboard/emails/${emailId}/attachments/0`,
      await tokenFor("admin"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''%3Cimg%20src%3Dx%20onerror%3Dalert%281%29%3E%20r%C3%A9sum%C3%A9.html",
    );
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(HTML_FILE)).toBe(true);
  });

  test("an image is still a forced octet-stream download", async () => {
    const res = await get(
      `/dashboard/emails/${emailId}/attachments/1`,
      await tokenFor("owner"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(
      "attachment; filename*=UTF-8''logo.png",
    );
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
  });

  test("a member may download, as a member may view the email", async () => {
    const res = await get(
      `/dashboard/emails/${emailId}/attachments/0`,
      await tokenFor("member"),
    );
    expect(res.status).toBe(200);
  });

  test("without a session: sent to the login page", async () => {
    const res = await get(`/dashboard/emails/${emailId}/attachments/0`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/dashboard/login");
  });

  test("an unknown position or email: 404", async () => {
    const token = await tokenFor("admin");
    expect((await get(`/dashboard/emails/${emailId}/attachments/7`, token)).status).toBe(
      404,
    );
    expect((await get(`/dashboard/emails/${emailId}/attachments/x`, token)).status).toBe(
      404,
    );
    expect((await get(`/dashboard/emails/msg_nope/attachments/0`, token)).status).toBe(
      404,
    );
  });

  test("once the bytes are dropped: 410 with a page saying so", async () => {
    await db
      .update(emailAttachments)
      .set({ content: null })
      .where(eq(emailAttachments.emailId, emailId));
    const res = await get(
      `/dashboard/emails/${emailId}/attachments/0`,
      await tokenFor("admin"),
    );
    expect(res.status).toBe(410);
    expect(await res.text()).toContain("Attachment no longer stored");
    const page = await (
      await get(`/dashboard/emails/${emailId}`, await tokenFor("admin"))
    ).text();
    expect(page).toContain("No longer stored");
    expect(page).not.toContain(`/dashboard/emails/${emailId}/attachments/0"`);
  });
});
