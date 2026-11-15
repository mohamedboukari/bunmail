/**
 * Remote images in email previews (#419), through the real `pagesPlugin`
 * behind the app's security headers, against real Postgres.
 *
 * - The outbound and inbound detail pages render the HTML preview with a
 *   `<meta http-equiv="Content-Security-Policy">` that blocks remote
 *   images, plus a "Load remote images" link to `?images=1`.
 * - `?images=1` renders it allowing `https:` images; any other value keeps
 *   them blocked.
 * - The page's own CSP header is the same in every case.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import {
  PAGE_CSP,
  securityHeadersPlugin,
} from "../../src/middleware/security-headers.ts";
import { inboundEmails } from "../../src/modules/inbound/models/inbound-email.schema.ts";
import { generateId } from "../../src/utils/id.ts";
import { db, emails, seed, truncateAll } from "./_helpers.ts";

/** The dashboard as `src/index.ts` mounts it: security headers first. */
const app = new Elysia()
  .use(securityHeadersPlugin({ httpsBaseUrl: false }))
  .use(pagesPlugin);

/** An email body with a tracking pixel. */
const PIXEL = '<p>Hi</p><img src="https://tracker.example/p.gif?id=42" alt="">';

/** The preview's policies, as they appear (entity-encoded) inside `srcdoc`. */
const BLOCKED = "img-src data:&quot;";
const REMOTE = "img-src data: https:&quot;";

let token = "";
let emailId = "";
let inboundId = "";

/** GETs a dashboard path as the seeded member. */
function get(path: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost${path}`, {
      headers: { cookie: `bm_session=${token}` },
    }),
  );
}

beforeEach(async () => {
  await truncateAll();
  const { id: userId } = await seed.user({ email: "member@example.com", role: "member" });
  token = (await seed.session({ userId })).token;

  const { id: apiKeyId } = await seed.apiKey();
  emailId = (await seed.email({ apiKeyId, status: "sent" })).id;
  await db.update(emails).set({ html: PIXEL }).where(eq(emails.id, emailId));

  inboundId = generateId("inb");
  await db.insert(inboundEmails).values({
    id: inboundId,
    fromAddress: "sender@example.org",
    toAddress: "support@example.com",
    subject: "pixel",
    html: PIXEL,
    textContent: "Hi",
  });
});

describe.each([
  ["outbound", (): string => `/dashboard/emails/${emailId}`],
  ["inbound", (): string => `/dashboard/inbound/${inboundId}`],
])("%s detail page", (_label, pathOf) => {
  test("blocks remote images by default and offers to load them", async () => {
    const res = await get(pathOf());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    const page = await res.text();
    expect(page).toContain(BLOCKED);
    expect(page).not.toContain(REMOTE);
    expect(page).toContain("Remote images are hidden to protect your privacy.");
    expect(page).toContain(`href="${pathOf()}?images=1#html-preview"`);
  });

  test("?images=1 allows https images, with the same page CSP", async () => {
    const res = await get(`${pathOf()}?images=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
    const page = await res.text();
    expect(page).toContain(REMOTE);
    expect(page).not.toContain("Remote images are hidden");
    expect(page).toContain(`href="${pathOf()}#html-preview"`);
  });

  test("any other value keeps them blocked", async () => {
    const page = await (await get(`${pathOf()}?images=true`)).text();
    expect(page).toContain(BLOCKED);
    expect(page).not.toContain(REMOTE);
  });
});
