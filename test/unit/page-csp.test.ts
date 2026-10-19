import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import {
  BASELINE_CSP,
  PAGE_CSP,
  securityHeadersPlugin,
} from "../../src/middleware/security-headers.ts";
import { EmailsPage } from "../../src/pages/routes/emails.tsx";
import { EmailDetailPage } from "../../src/pages/routes/email-detail.tsx";
import { InboundTrashPage } from "../../src/pages/routes/inbound-trash.tsx";
import { TemplatesPage } from "../../src/pages/routes/templates.tsx";
import { SendEmailPage } from "../../src/pages/routes/send-email.tsx";
import { LoginPage } from "../../src/pages/routes/login.tsx";
import { OwnerSetupPage } from "../../src/pages/routes/setup.tsx";
import { LandingPage } from "../../src/pages/routes/landing.tsx";
import { NotFoundPage, notFoundResponse } from "../../src/pages/routes/not-found.tsx";
import { landingPlugin } from "../../src/pages/landing.plugin.tsx";

/**
 * No third-party or inline script on any page (#255, part 2).
 *
 * Every page loads only `/dashboard/assets/dashboard.css` and
 * `/dashboard/assets/dashboard.js`, carries no inline `<script>` (a
 * `type="application/json"` data block is data, not code) and no `on*=`
 * attribute, and is served with a CSP whose `script-src` has no
 * `'unsafe-inline'`, so an injected script would not run. The OpenAPI
 * docs page keeps the baseline CSP: its Scalar UI needs inline scripts.
 */

const now = new Date("2026-05-08T00:00:00Z");

const email = {
  id: "msg_x",
  apiKeyId: "key_x",
  domainId: null,
  fromAddress: "hello@example.com",
  toAddress: "user@example.org",
  cc: null,
  bcc: null,
  replyTo: null,
  headers: null,
  subject: "test",
  html: "<p>hello</p>",
  textContent: null,
  status: "sent" as const,
  source: "api",
  attempts: 1,
  nextAttemptAt: now,
  lockedBy: null,
  leaseUntil: null,
  lastError: null,
  messageId: "<x@y>",
  sentAt: now,
  createdAt: now,
  updatedAt: now,
  createdByUserId: null,
  deletedAt: null,
  deliveryState: null,
};

const inboundEmail = {
  id: "inb_x",
  fromAddress: "user@example.org",
  toAddress: "hello@example.com",
  subject: "reply",
  html: "<p>x</p>",
  textContent: null,
  rawMessage: null,
  receivedAt: now,
  deletedAt: now,
  deliveryState: null,
  messageId: null,
  inReplyTo: null,
  references: null,
  inReplyToEmailId: null,
};

const apiKey = {
  id: "key_x",
  name: "Test",
  keyHash: "hash",
  keyPrefix: "bm_live_test",
  isActive: true,
  isAdmin: false,
  allowedSenders: [] as string[],
  lastUsedAt: null,
  createdByUserId: null,
  disabledReason: null,
  createdAt: now,
};

/** Every page with a script-driven feature, plus the standalone ones. */
const pages: Array<[string, () => string | Promise<string>]> = [
  [
    "emails (bulk select, filters, confirm)",
    () => EmailsPage({ emails: [email], total: 1, page: 1, limit: 20 }),
  ],
  ["email detail (HTML preview)", () => EmailDetailPage({ email, isTrashed: true })],
  [
    "inbound trash (bulk select)",
    () =>
      InboundTrashPage({
        emails: [inboundEmail],
        total: 1,
        page: 1,
        limit: 20,
        retentionDays: 7,
      }),
  ],
  [
    "templates (live preview)",
    () =>
      TemplatesPage({
        templates: [],
        creators: new Map(),
        viewer: { id: "usr_admin", canManageAll: true },
      }),
  ],
  [
    "send (chip inputs)",
    () => SendEmailPage({ apiKeys: [apiKey], defaultApiKeyId: apiKey.id }),
  ],
  ["login", () => LoginPage({})],
  [
    "owner setup",
    () => OwnerSetupPage({ token: "A".repeat(43), email: "owner@example.com" }),
  ],
  ["landing", () => LandingPage()],
  ["not found", () => NotFoundPage()],
];

/** Every `<script ...>` opening tag in the page, in any letter case. */
function scriptTags(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
}

describe("pages carry no inline or third-party script (#255)", () => {
  test.each(pages)("%s", async (_name, render) => {
    const html = await render();
    const scripts = scriptTags(html);

    /** The self-hosted stylesheet and script, cache-busted when built. */
    expect(html).toMatch(
      /<link rel="stylesheet" href="\/dashboard\/assets\/dashboard\.css(\?v=[0-9a-f]{12})?"\/?>/,
    );
    expect(scripts).toContainEqual(
      expect.stringMatching(
        /^<script src="\/dashboard\/assets\/dashboard\.js\?v=[0-9a-f]{12}">$/,
      ),
    );

    /** Every other script is a JSON data block. */
    for (const tag of scripts) {
      if (!tag.includes(" src=")) expect(tag).toContain('type="application/json"');
      else expect(tag).toMatch(/src="\/dashboard\/assets\//);
    }
    expect(html).not.toMatch(/\son[a-z]+=/);
    expect(html).not.toContain("cdn.tailwindcss.com");
  });

  test("the live preview data block cannot close its element early", async () => {
    const html = await TemplatesPage({
      templates: [],
      creators: new Map(),
      viewer: { id: "usr_admin", canManageAll: true },
    });
    const block = html.match(
      /<script type="application\/json" id="bm-live-preview-data">([\s\S]*?)<\/script>/,
    );
    const json = block?.[1] ?? "";
    expect(json).not.toContain("<");
    const data: unknown = JSON.parse(json);
    expect(data).toMatchObject({ samples: { name: "Alex Doe" } });
    expect(JSON.stringify(data)).toContain("<style>");
  });
});

describe("the page CSP", () => {
  test("blocks inline and third-party scripts", () => {
    const scriptSrc = PAGE_CSP.split("; ").find((d) => d.startsWith("script-src "));
    expect(scriptSrc).toBe("script-src 'self'");
    expect(PAGE_CSP).toContain("default-src 'self'");
    /** No other origin may serve a script or a stylesheet. */
    for (const directive of PAGE_CSP.split("; ").filter((d) =>
      /^(script|style)-src /.test(d),
    )) {
      expect(directive).not.toMatch(/https?:|\*/);
    }
  });

  test("is exactly the policy #255 specifies", () => {
    expect(PAGE_CSP).toBe(
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: https:; font-src 'self'; connect-src 'self'; " +
        "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
  });

  const app = new Elysia()
    .onError(({ code, request }) => {
      if (code === "NOT_FOUND" && request.headers.get("accept")?.includes("text/html")) {
        return notFoundResponse();
      }
    })
    .use(securityHeadersPlugin({ httpsBaseUrl: false }))
    .use(landingPlugin)
    .get("/dashboard/emails", async () => {
      return new Response(
        "<!doctype html>" +
          (await EmailsPage({ emails: [], total: 0, page: 1, limit: 20 })),
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    })
    .get("/api/docs", () => new Response("<html>scalar</html>"))
    .get("/api/docs/json", () => ({ openapi: "3.0.3" }));

  test.each(["/", "/dashboard/emails"])(
    "%p is served with the page CSP",
    async (path) => {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
    },
  );

  test("the HTML 404 page carries the page CSP on any path", async () => {
    const response = await app.handle(
      new Request("http://localhost/no/such/page", { headers: { accept: "text/html" } }),
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
    expect(await response.text()).toContain("/dashboard/assets/dashboard.js");
  });

  test.each(["/api/docs", "/api/docs/json"])(
    "%p keeps the baseline CSP (Scalar needs inline scripts)",
    async (path) => {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.headers.get("content-security-policy")).toBe(BASELINE_CSP);
    },
  );
});
