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
 * The plugin-level `dashboard.test.ts` e2e covers routing + auth: these
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
import { SuppressionsPage } from "../../src/pages/routes/suppressions.tsx";
import { TemplatesPage } from "../../src/pages/routes/templates.tsx";
import { TemplateDetailPage } from "../../src/pages/routes/template-detail.tsx";
import { WebhooksPage } from "../../src/pages/routes/webhooks.tsx";
import { LoginPage } from "../../src/pages/routes/login.tsx";
import { LandingPage } from "../../src/pages/routes/landing.tsx";
import { OwnerSetupPage, OwnerSetupInvalidPage } from "../../src/pages/routes/setup.tsx";
import {
  InviteAcceptPage,
  InviteAccountExistsPage,
  InviteInvalidPage,
} from "../../src/pages/routes/invite.tsx";
import { InvitationsPage } from "../../src/pages/routes/invitations.tsx";
import {
  PasswordResetInvalidPage,
  PasswordResetPage,
} from "../../src/pages/routes/reset.tsx";
import { UsersPage } from "../../src/pages/routes/users.tsx";
import { FlashMessage } from "../../src/pages/components/flash-message.tsx";
import {
  HtmlPreview,
  LiveHtmlPreview,
} from "../../src/pages/components/html-preview.tsx";
import { Pagination } from "../../src/pages/components/pagination.tsx";
import { StatusBadge } from "../../src/pages/components/status-badge.tsx";

const now = new Date("2026-05-08T00:00:00Z");

const apiKey = {
  id: "key_x",
  name: "Test",
  keyHash: "hash",
  keyPrefix: "bm_live_test",
  isActive: true,
  isAdmin: false,
  allowedSenders: [] as string[],
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
  notifyEmail: null,
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
  replyTo: null,
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
  deletedAt: null,
  deliveryState: null,
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
  test("ApiKeysPage with empty list renders", async () => {
    const html = await ApiKeysPage({ keys: [] });
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(100);
  });

  test("ApiKeysPage with keys + flash + rawKey", async () => {
    const html = await ApiKeysPage({
      keys: [apiKey],
      flash: { message: "ok", type: "success" },
      rawKey: "bm_live_xxx",
    });
    expect(html).toContain("Test");
  });

  test("DomainsPage", () => {
    expect(typeof DomainsPage({ domains: [domain] })).toBe("string");
    expect(
      typeof DomainsPage({ domains: [], flash: { message: "x", type: "error" } }),
    ).toBe("string");
  });

  test("DomainDetailPage", async () => {
    const html = await DomainDetailPage({ domain });
    expect(html).toContain("example.com");
    /** Inbound-notification edit form is present (#106). */
    expect(html).toContain(`/dashboard/domains/${domain.id}/notify-email`);
    expect(html).toContain('name="notifyEmail"');
    /** A configured address pre-fills the input. */
    const withNotify = await DomainDetailPage({
      domain: { ...domain, notifyEmail: "ops@external.com" },
    });
    expect(withNotify).toContain("ops@external.com");
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

  test("EmailDetailPage shows Reply-To only when set, escaped (#169)", async () => {
    const without = await EmailDetailPage({ email, isTrashed: false });
    expect(without).not.toContain("Reply-To");
    const withReplyTo = await EmailDetailPage({
      email: { ...email, replyTo: "support@example.com, <b>x</b>" },
      isTrashed: false,
    });
    expect(withReplyTo).toContain("Reply-To");
    expect(withReplyTo).toContain("support@example.com");
    expect(withReplyTo).not.toContain("<b>x</b>");
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

  test("SendEmailPage has a Reply-To input (#169)", async () => {
    const html = await SendEmailPage({ apiKeys: [apiKey], defaultApiKeyId: apiKey.id });
    expect(html).toContain('name="replyTo"');
  });

  test("SendEmailPage", () => {
    expect(typeof SendEmailPage({ apiKeys: [apiKey], defaultApiKeyId: apiKey.id })).toBe(
      "string",
    );
    expect(
      typeof SendEmailPage({
        apiKeys: [apiKey],
        defaultApiKeyId: apiKey.id,
        flash: { message: "queued", type: "success" },
      }),
    ).toBe("string");
    /** Empty-keys path renders the "create one first" notice (#89). */
    expect(typeof SendEmailPage({ apiKeys: [] })).toBe("string");
    /** Pre-fill path used by the inbound-reply route (#86): every
     *  field populated, including HTML that needs escaping in the
     *  textarea. */
    expect(
      typeof SendEmailPage({
        apiKeys: [apiKey],
        defaultApiKeyId: apiKey.id,
        prefill: {
          from: "hello@example.com",
          to: "sender@other.com",
          subject: "Re: hi there",
          html: "<p>quoted</p>",
          text: "> quoted",
        },
      }),
    ).toBe("string");
  });

  test("SuppressionsPage", () => {
    const suppression = {
      id: "sup_1",
      apiKeyId: apiKey.id,
      email: "blocked@example.com",
      reason: "bounce" as const,
      bounceType: "hard" as const,
      diagnosticCode: "5.1.1",
      sourceEmailId: "msg_abc",
      expiresAt: null,
      createdAt: now,
    };
    const apiKeyLabels = { [apiKey.id]: { name: apiKey.name } };
    /** Populated list with one row. */
    expect(
      typeof SuppressionsPage({
        suppressions: [suppression],
        total: 1,
        page: 1,
        limit: 25,
        filters: {},
        apiKeys: [apiKey],
        apiKeyLabels,
      }),
    ).toBe("string");
    /** Empty-state path. */
    expect(
      typeof SuppressionsPage({
        suppressions: [],
        total: 0,
        page: 1,
        limit: 25,
        filters: { email: "gmail" },
        apiKeys: [apiKey],
        apiKeyLabels,
      }),
    ).toBe("string");
  });

  test("TemplatesPage", async () => {
    expect(typeof TemplatesPage({ templates: [template] })).toBe("string");
    expect(typeof TemplatesPage({ templates: [] })).toBe("string");
    /** Create form ships the live HTML preview iframe + its driver script. */
    expect(await TemplatesPage({ templates: [] })).toContain("live-html-preview-frame");
  });

  test("TemplateDetailPage", async () => {
    expect(typeof TemplateDetailPage({ template })).toBe("string");
    /** Edit form seeds the preview from the saved HTML with sample-rendered
     *  variables ({{name}} -> Alex Doe), not the raw placeholder. */
    const html = await TemplateDetailPage({ template });
    expect(html).toContain("live-html-preview-frame");
    expect(html).toContain("Alex Doe");
  });

  test("WebhooksPage", () => {
    expect(typeof WebhooksPage({ webhooks: [webhook] })).toBe("string");
    expect(typeof WebhooksPage({ webhooks: [], secret: "shown-once" })).toBe("string");
  });

  test("LoginPage renders the email and password inputs (#216)", async () => {
    expect(typeof LoginPage({})).toBe("string");
    const html = await LoginPage({});
    expect(html).toContain('action="/dashboard/login"');
    /**
     * Plain text with an email keyboard, not type="email": browsers refuse
     * or rewrite addresses (accents, international domains) that
     * BUNMAIL_OWNER_EMAIL accepts, which would lock such an owner out.
     */
    expect(html).toContain('type="text"');
    expect(html).toContain('inputmode="email"');
    expect(html).not.toContain('type="email"');
    expect(html).toContain('name="email"');
    expect(html).toContain('autocomplete="username"');
    expect(html).toContain('maxlength="254"');
    expect(html).toContain('name="password"');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('maxlength="256"');
    expect(html).toContain("owner setup link");
    expect(html).not.toContain("DASHBOARD_PASSWORD");
  });

  test("LoginPage escapes the error message", async () => {
    const html = await LoginPage({ error: "<img src=x onerror=alert(1)>" });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("LoginPage disables the form only when rate-limited (#109)", async () => {
    /** Matches a standalone `disabled` attribute, not the `disabled:`
     *  Tailwind variant classes which also contain the substring. */
    const hasDisabledAttr = /disabled(?![:\w-])/;

    /** Normal error (wrong password) keeps the form editable for a retry. */
    const normal = await LoginPage({ error: "Invalid password" });
    expect(hasDisabledAttr.test(normal)).toBe(false);

    /** Rate-limited render disables both inputs + the button. */
    const locked = await LoginPage({
      error: "Too many failed attempts.",
      disabled: true,
    });
    expect(hasDisabledAttr.test(locked)).toBe(true);
    expect(locked.match(/<input[^>]*\sdisabled(?![:\w-])/g)).toHaveLength(2);
    expect(locked.match(/<button[^>]*\sdisabled(?![:\w-])/g)).toHaveLength(1);
  });

  test("LandingPage", () => {
    expect(typeof LandingPage()).toBe("string");
  });

  describe("Owner setup pages (#215)", () => {
    const token = "A".repeat(20) + "b-c_d".repeat(4) + "xyz";

    test("OwnerSetupPage renders the form with the token only in the hidden input", async () => {
      const html = await OwnerSetupPage({ token, email: "owner@example.com" });
      expect(html).toContain('action="/dashboard/setup"');
      expect(html).toContain('method="POST"');
      expect(html).toContain(`<input type="hidden" name="token" value="${token}"`);
      expect(html.split(token).length - 1).toBe(1);
      expect(html).toContain("owner@example.com");
      expect(html).toContain('autocomplete="new-password"');
      expect(html).toContain('name="confirm"');
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
    });

    test("OwnerSetupPage escapes a hostile email and error", async () => {
      const html = await OwnerSetupPage({
        token,
        email: "<script>alert(1)</script>@example.com",
        error: "<img src=x onerror=alert(2)>",
      });
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@example.com");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    });

    test("OwnerSetupInvalidPage points at reset-owner and sends the origin-only referrer", async () => {
      const html = await OwnerSetupInvalidPage();
      expect(html).toContain("not valid");
      expect(html).toContain("src/db/reset-owner.ts");
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
      expect(html).not.toContain("<form");
    });
  });

  describe("Invitation pages (#217)", () => {
    const token = "Q".repeat(20) + "b-c_d".repeat(4) + "xyz";

    test("InviteAcceptPage: token only in the hidden input, hostile values escaped", async () => {
      const html = await InviteAcceptPage({
        token,
        email: "<script>alert(1)</script>@example.com",
        role: "member",
        name: '"><img src=x onerror=alert(3)>',
        error: "<img src=x onerror=alert(2)>",
      });
      expect(html).toContain('action="/dashboard/invite"');
      expect(html).toContain(`<input type="hidden" name="token" value="${token}"`);
      expect(html.split(token).length - 1).toBe(1);
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@example.com");
      expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
      /** Attribute escaping encodes the quote, so the value cannot break out. */
      expect(html).toContain('value="&#34;><img src=x onerror=alert(3)>"');
      expect(html).not.toContain('value=""><img');
    });

    test("InviteInvalidPage and InviteAccountExistsPage carry no form", async () => {
      const invalid = await InviteInvalidPage();
      expect(invalid).toContain("This invitation link is not valid");
      expect(invalid).not.toContain("<form");
      const exists = await InviteAccountExistsPage();
      expect(exists).toContain('href="/dashboard/login"');
      expect(exists).not.toContain("<form");
    });

    test("InvitationsPage escapes stored values and the revealed link", async () => {
      const html = await InvitationsPage({
        invitations: [
          {
            id: "utk_1",
            email: "<b>x</b>@example.com",
            role: "admin",
            invitedBy: "<i>Ann</i>",
            createdAt: new Date(),
            expiresAt: new Date(),
          },
        ],
        grantable: ["member"],
        revealedLink: "https://mail.example.com/dashboard/invite?token=<x>",
      });
      expect(html).not.toContain("<b>x</b>");
      expect(html).not.toContain("<i>Ann</i>");
      expect(html).toContain("token=&lt;x&gt;");
      /** An admin invitation shown to an admin: no Resend/Revoke for it. */
      expect(html).not.toContain("/dashboard/invitations/utk_1/revoke");
      expect(html).toContain("Owner only");
    });
  });

  describe("Password reset pages (#277)", () => {
    const token = "R".repeat(20) + "b-c_d".repeat(4) + "xyz";

    test("PasswordResetPage: token only in the hidden input, hostile values escaped", async () => {
      const html = await PasswordResetPage({
        token,
        email: "<script>alert(1)</script>@example.com",
        error: "<img src=x onerror=alert(2)>",
      });
      expect(html).toContain('action="/dashboard/reset"');
      expect(html).toContain(`<input type="hidden" name="token" value="${token}"`);
      expect(html.split(token).length - 1).toBe(1);
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@example.com");
      expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    });

    test("PasswordResetInvalidPage carries no form", async () => {
      const html = await PasswordResetInvalidPage();
      expect(html).toContain("This password reset link is not valid");
      expect(html).not.toContain("<form");
    });

    test("UsersPage: the reset action only where allowed, the revealed link escaped", async () => {
      const html = await UsersPage({
        accounts: [
          {
            id: "usr_owner",
            email: "owner@example.com",
            name: null,
            role: "owner",
            disabled: false,
            createdAt: new Date(),
          },
          {
            id: "usr_admin",
            email: "admin@example.com",
            name: "Ada",
            role: "admin",
            disabled: false,
            createdAt: new Date(),
          },
          {
            id: "usr_member",
            email: "member@example.com",
            name: "Max",
            role: "member",
            disabled: false,
            createdAt: new Date(),
          },
          {
            id: "usr_off",
            email: "off@example.com",
            name: "Off",
            role: "member",
            disabled: true,
            createdAt: new Date(),
          },
        ],
        viewer: { id: "usr_admin", role: "admin", disabled: false },
        revealedResetLink: "https://mail.example.com/dashboard/reset?token=<x>",
      });
      expect(html).toContain('action="/dashboard/users/usr_member/reset-password"');
      expect(html).not.toContain("/dashboard/users/usr_admin/reset-password");
      expect(html).not.toContain("/dashboard/users/usr_owner/reset-password");
      expect(html).not.toContain("/dashboard/users/usr_off/reset-password");
      expect(html).toContain("token=&lt;x&gt;");
      expect(html).not.toContain("token=<x>");
    });
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

  test("LiveHtmlPreview: sandboxed iframe seeded with sample-rendered HTML", async () => {
    const empty = await LiveHtmlPreview({ textareaId: "html" });
    expect(empty).toContain("live-html-preview-frame");
    expect(empty).toContain('sandbox="allow-same-origin"');
    expect(empty).toContain('data-source="html"');

    /** initialHtml is sample-rendered for the first (pre-JS) paint. */
    const seeded = await LiveHtmlPreview({
      textareaId: "html",
      initialHtml: "<p>Hi {{name}}</p>",
    });
    expect(seeded).toContain("Alex Doe");
    expect(seeded).not.toContain("{{name}}");
  });

  test("Pagination: first / middle / last page", () => {
    expect(
      typeof Pagination({ page: 1, limit: 20, total: 100, baseUrl: "/dashboard/emails" }),
    ).toBe("string");
    expect(
      typeof Pagination({ page: 3, limit: 20, total: 100, baseUrl: "/dashboard/emails" }),
    ).toBe("string");
    expect(
      typeof Pagination({ page: 5, limit: 20, total: 100, baseUrl: "/dashboard/emails" }),
    ).toBe("string");
    /** Single page, should render nothing meaningful but shouldn't throw. */
    expect(typeof Pagination({ page: 1, limit: 20, total: 5, baseUrl: "/x" })).toBe(
      "string",
    );
  });

  test("StatusBadge for each known status", () => {
    for (const status of ["queued", "sending", "sent", "failed", "bounced"]) {
      expect(typeof StatusBadge({ status })).toBe("string");
    }
    /** Unknown status, should still render. */
    expect(typeof StatusBadge({ status: "unknown" })).toBe("string");
  });
});
