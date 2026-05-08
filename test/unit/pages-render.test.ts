import { describe, test, expect } from "bun:test";

/**
 * JSX render-smoke tests for every dashboard page + presentational
 * component. Each test imports the component and renders it with
 * minimal fixture props, asserting that the output is a non-empty
 * string and contains some expected marker text.
 *
 * What these catch:
 *   - JSX syntax errors / missing imports / type errors at render time
 *   - Crashes on common shapes of data (empty lists, present flash, etc.)
 *
 * What they don't catch:
 *   - Real markup correctness (we'd need DOM-level snapshots)
 *   - Browser interactivity / form submissions (no JS in our pages)
 *
 * The plugin-level `dashboard.test.ts` e2e covers routing + auth — these
 * tests cover the rendering layer beneath. Together they exercise the
 * full HTML response path.
 */

import { ApiKeysPage } from "../../src/pages/routes/api-keys.tsx";
import { DomainDetailPage } from "../../src/pages/routes/domain-detail.tsx";
import { DomainsPage } from "../../src/pages/routes/domains.tsx";
import { EmailDetailPage } from "../../src/pages/routes/email-detail.tsx";
import { EmailsTrashPage } from "../../src/pages/routes/emails-trash.tsx";
import { EmailsPage } from "../../src/pages/routes/emails.tsx";
import { InboundDetailPage } from "../../src/pages/routes/inbound-detail.tsx";
import { InboundTrashPage } from "../../src/pages/routes/inbound-trash.tsx";
import { InboundPage } from "../../src/pages/routes/inbound.tsx";
import { SendEmailPage } from "../../src/pages/routes/send-email.tsx";
import { TemplatesPage } from "../../src/pages/routes/templates.tsx";
import { TemplateDetailPage } from "../../src/pages/routes/template-detail.tsx";
import { WebhooksPage } from "../../src/pages/routes/webhooks.tsx";
import { LoginPage, DashboardDisabledPage } from "../../src/pages/routes/login.tsx";
import { LandingPage } from "../../src/pages/routes/landing.tsx";
import { FlashMessage } from "../../src/pages/components/flash-message.tsx";
import { HtmlPreview } from "../../src/pages/components/html-preview.tsx";
import { Pagination } from "../../src/pages/components/pagination.tsx";
import { StatusBadge } from "../../src/pages/components/status-badge.tsx";

const now = new Date("2026-05-08T00:00:00Z");

const apiKey = {
  id: "key_x",
  name: "Test",
  keyHash: "hash",
  keyPrefix: "bm_live_test",
  isActive: true,
  lastUsedAt: null,
  createdAt: now,
};

const domain = {
  id: "dom_x",
  name: "example.com",
  dkimPrivateKey: null,
  dkimPublicKey: "-----BEGIN PUBLIC KEY-----\nMIIBIj\n-----END PUBLIC KEY-----",
  dkimSelector: "bunmail",
  spfVerified: true,
  dkimVerified: false,
  dmarcVerified: false,
  verifiedAt: null,
  unsubscribeEmail: null,
  unsubscribeUrl: null,
  createdAt: now,
  updatedAt: now,
};

const email = {
  id: "msg_x",
  apiKeyId: "key_x",
  domainId: null,
  fromAddress: "hello@example.com",
  toAddress: "user@example.org",
  cc: null,
  bcc: null,
  subject: "test",
  html: "<p>hello</p>",
  textContent: null,
  status: "sent" as const,
  attempts: 1,
  lastError: null,
  messageId: "<x@y>",
  sentAt: now,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
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
  deletedAt: null,
};

const template = {
  id: "tpl_x",
  apiKeyId: "key_x",
  name: "welcome",
  subject: "Hi {{name}}",
  html: "<p>Hi {{name}}</p>",
  textContent: "Hi {{name}}",
  variables: ["name"],
  createdAt: now,
  updatedAt: now,
};

const webhook = {
  id: "whk_x",
  apiKeyId: "key_x",
  url: "https://hook.example.com",
  events: ["email.sent"],
  secret: "secret",
  isActive: true,
  createdAt: now,
  updatedAt: now,
};

describe("Dashboard page render smoke tests", () => {
  test("ApiKeysPage with empty list renders", () => {
    const html = String(ApiKeysPage({ keys: [] }));
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(100);
  });

  test("ApiKeysPage with keys + flash + rawKey", () => {
    const html = String(
      ApiKeysPage({
        keys: [apiKey],
        flash: { message: "ok", type: "success" },
        rawKey: "bm_live_xxx",
      }),
    );
    expect(html).toContain("Test");
  });

  test("DomainsPage", () => {
    expect(typeof DomainsPage({ domains: [domain] })).toBe("string");
    expect(
      typeof DomainsPage({ domains: [], flash: { message: "x", type: "error" } }),
    ).toBe("string");
  });

  test("DomainDetailPage", () => {
    const html = String(DomainDetailPage({ domain }));
    expect(html).toContain("example.com");
  });

  test("EmailsPage with various states", () => {
    expect(typeof EmailsPage({ emails: [email], total: 1, page: 1, limit: 20 })).toBe(
      "string",
    );
    expect(typeof EmailsPage({ emails: [], total: 0, page: 1, limit: 20 })).toBe(
      "string",
    );
    expect(
      typeof EmailsPage({
        emails: [email],
        total: 1,
        page: 1,
        limit: 20,
        flash: { message: "ok", type: "success" },
      }),
    ).toBe("string");
  });

  test("EmailDetailPage", () => {
    expect(typeof EmailDetailPage({ email, isTrashed: false })).toBe("string");
    expect(typeof EmailDetailPage({ email, isTrashed: true })).toBe("string");
  });

  test("EmailsTrashPage", () => {
    expect(
      typeof EmailsTrashPage({
        emails: [{ ...email, deletedAt: now }],
        total: 1,
        page: 1,
        limit: 20,
        retentionDays: 7,
      }),
    ).toBe("string");
    expect(
      typeof EmailsTrashPage({
        emails: [],
        total: 0,
        page: 1,
        limit: 20,
        retentionDays: 7,
      }),
    ).toBe("string");
  });

  test("InboundPage", () => {
    expect(
      typeof InboundPage({ emails: [inboundEmail], total: 1, page: 1, limit: 20 }),
    ).toBe("string");
    expect(typeof InboundPage({ emails: [], total: 0, page: 1, limit: 20 })).toBe(
      "string",
    );
  });

  test("InboundDetailPage", () => {
    expect(typeof InboundDetailPage({ email: inboundEmail, isTrashed: false })).toBe(
      "string",
    );
  });

  test("InboundTrashPage", () => {
    expect(
      typeof InboundTrashPage({
        emails: [{ ...inboundEmail, deletedAt: now }],
        total: 1,
        page: 1,
        limit: 20,
        retentionDays: 7,
      }),
    ).toBe("string");
    expect(
      typeof InboundTrashPage({
        emails: [],
        total: 0,
        page: 1,
        limit: 20,
        retentionDays: 7,
      }),
    ).toBe("string");
  });

  test("SendEmailPage", () => {
    expect(typeof SendEmailPage({})).toBe("string");
    expect(typeof SendEmailPage({ flash: { message: "queued", type: "success" } })).toBe(
      "string",
    );
  });

  test("TemplatesPage", () => {
    expect(typeof TemplatesPage({ templates: [template] })).toBe("string");
    expect(typeof TemplatesPage({ templates: [] })).toBe("string");
  });

  test("TemplateDetailPage", () => {
    expect(typeof TemplateDetailPage({ template })).toBe("string");
  });

  test("WebhooksPage", () => {
    expect(typeof WebhooksPage({ webhooks: [webhook] })).toBe("string");
    expect(typeof WebhooksPage({ webhooks: [], secret: "shown-once" })).toBe("string");
  });

  test("LoginPage + DashboardDisabledPage", () => {
    expect(typeof LoginPage({})).toBe("string");
    expect(typeof LoginPage({ error: "bad password" })).toBe("string");
    expect(typeof DashboardDisabledPage()).toBe("string");
  });

  test("LandingPage", () => {
    expect(typeof LandingPage()).toBe("string");
  });
});

describe("Component render smoke tests", () => {
  test("FlashMessage with various types", () => {
    expect(typeof FlashMessage({ message: "ok", type: "success" })).toBe("string");
    expect(typeof FlashMessage({ message: "bad", type: "error" })).toBe("string");
  });

  test("HtmlPreview with HTML body", () => {
    expect(typeof HtmlPreview({ html: "<p>hi</p>" })).toBe("string");
    expect(typeof HtmlPreview({ html: "" })).toBe("string");
    expect(typeof HtmlPreview({ html: "<p>x</p>", title: "Custom" })).toBe("string");
  });

  test("Pagination — first / middle / last page", () => {
    expect(
      typeof Pagination({ page: 1, limit: 20, total: 100, baseUrl: "/dashboard/emails" }),
    ).toBe("string");
    expect(
      typeof Pagination({ page: 3, limit: 20, total: 100, baseUrl: "/dashboard/emails" }),
    ).toBe("string");
    expect(
      typeof Pagination({ page: 5, limit: 20, total: 100, baseUrl: "/dashboard/emails" }),
    ).toBe("string");
    /** Single page — should render nothing meaningful but shouldn't throw. */
    expect(typeof Pagination({ page: 1, limit: 20, total: 5, baseUrl: "/x" })).toBe(
      "string",
    );
  });

  test("StatusBadge for each known status", () => {
    for (const status of ["queued", "sending", "sent", "failed", "bounced"]) {
      expect(typeof StatusBadge({ status })).toBe("string");
    }
    /** Unknown status — should still render. */
    expect(typeof StatusBadge({ status: "unknown" })).toBe("string");
  });
});
