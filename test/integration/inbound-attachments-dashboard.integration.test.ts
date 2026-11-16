/**
 * Attachments of received emails in the dashboard (#486), through the
 * real `pagesPlugin` behind the app's security headers, against real
 * Postgres. Parsed from the stored raw message on view.
 *
 * - The inbound page lists the attachments, escaped, with sizes and links.
 * - `GET /dashboard/inbound/:id/attachments/:position` follows the page's
 *   guard (members may view inbound) and always answers a forced
 *   download, for live and trashed emails alike.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { securityHeadersPlugin } from "../../src/middleware/security-headers.ts";
import { inboundEmails } from "../../src/modules/inbound/models/inbound-email.schema.ts";
import type { UserRole } from "../../src/modules/users/types/user.types.ts";
import { db, seed, truncateAll } from "./_helpers.ts";

/** The dashboard as `src/index.ts` mounts it: security headers first. */
const app = new Elysia()
  .use(securityHeadersPlugin({ httpsBaseUrl: false }))
  .use(pagesPlugin);

/** An HTML file: must never be rendered by the dashboard's origin. */
const HTML_FILE = "<html><script>alert(document.cookie)</script></html>";

/** A filename that would be markup if it were not escaped. */
const MARKUP_NAME = "<img src=x onerror=alert(1)>.html";

/** A raw message with the HTML file and an inline image part. */
const RAW = [
  "From: alice@example.org",
  "To: inbox@sandbox.test",
  "Subject: files",
  'Content-Type: multipart/mixed; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "see attached",
  "--b",
  `Content-Type: text/html; name="${MARKUP_NAME}"`,
  `Content-Disposition: attachment; filename="${MARKUP_NAME}"`,
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from(HTML_FILE).toString("base64"),
  "--b",
  "Content-Type: image/png",
  "Content-ID: <logo@test>",
  'Content-Disposition: inline; filename="logo.png"',
  "Content-Transfer-Encoding: base64",
  "",
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "--b--",
  "",
].join("\r\n");

let liveId = "";
let trashedId = "";

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
  liveId = "inb_att_live";
  trashedId = "inb_att_trash";
  await db.insert(inboundEmails).values([
    {
      id: liveId,
      fromAddress: "alice@example.org",
      toAddress: "inbox@sandbox.test",
      subject: "files",
      textContent: "see attached",
      rawMessage: RAW,
    },
    {
      id: trashedId,
      fromAddress: "alice@example.org",
      toAddress: "inbox@sandbox.test",
      subject: "files",
      rawMessage: RAW,
      deletedAt: new Date(),
    },
  ]);
});

describe("inbound page", () => {
  test("lists the attachments, escaped, with sizes and download links", async () => {
    const res = await get(`/dashboard/inbound/${liveId}`, await tokenFor("member"));
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Attachments");
    expect(page).not.toContain("<img src=x onerror");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(page).toContain(`${HTML_FILE.length} B`);
    expect(page).toContain("cid:logo@test");
    expect(page).toContain(`/dashboard/inbound/${liveId}/attachments/0`);
    expect(page).toContain(`/dashboard/inbound/${liveId}/attachments/1`);
  });
});

describe("download route", () => {
  test("a member gets the bytes with every safety header", async () => {
    const res = await get(
      `/dashboard/inbound/${liveId}/attachments/0`,
      await tokenFor("member"),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(HTML_FILE);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toStartWith("attachment; filename*=");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(
      "sandbox; default-src 'none'",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("works for a trashed email, as its page does", async () => {
    const res = await get(
      `/dashboard/inbound/${trashedId}/attachments/1`,
      await tokenFor("member"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  test("without a session: sent to the login page", async () => {
    const res = await get(`/dashboard/inbound/${liveId}/attachments/0`);
    expect(res.status).toBe(302);
  });

  test("an unknown position or email: 404", async () => {
    const token = await tokenFor("member");
    for (const path of [
      `/dashboard/inbound/${liveId}/attachments/2`,
      `/dashboard/inbound/${liveId}/attachments/abc`,
      `/dashboard/inbound/inb_missing/attachments/0`,
    ]) {
      const res = await get(path, token);
      expect(res.status).toBe(404);
    }
  });
});
