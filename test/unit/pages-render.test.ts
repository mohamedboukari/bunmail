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
import { AccountPasswordPage } from "../../src/pages/routes/account-password.tsx";
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
  createdByUserId: null,
  disabledReason: null,
  createdAt: now,
};

/** No accounts: every record reads as the owner's (#219). */
const creators: ReadonlyMap<string, string> = new Map();
/** An admin viewer: sees every edit and delete control (#219). */
const viewer = { id: "usr_admin", canManageAll: true };

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
  createdByUserId: null,
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
  createdByUserId: null,
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
  createdByUserId: null,
};

describe("Dashboard page render smoke tests", () => {
  test("ApiKeysPage with empty list renders", async () => {
    const html = await ApiKeysPage({
      keys: [],
      creators,
      adminCreatorIds: new Set(),
      canManageAll: true,
    });
    expect(typeof html).toBe("string");
    expect(html.length).toBeGreaterThan(100);
  });

  test("ApiKeysPage with keys + flash + rawKey", async () => {
    const html = await ApiKeysPage({
      keys: [apiKey],
      creators,
      adminCreatorIds: new Set(),
      canManageAll: true,
      flash: { message: "ok", type: "success" },
      rawKey: "bm_live_xxx",
    });
    expect(html).toContain("Test");
  });

  test("DomainsPage", () => {
    expect(typeof DomainsPage({ domains: [domain], creators })).toBe("string");
    expect(
      typeof DomainsPage({
        domains: [],
        flash: { message: "x", type: "error" },
        creators,
      }),
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
    expect(typeof TemplatesPage({ templates: [template], creators, viewer })).toBe(
      "string",
    );
    expect(typeof TemplatesPage({ templates: [], creators, viewer })).toBe("string");
    /** Create form ships the live HTML preview iframe + its data block (#255). */
    expect(await TemplatesPage({ templates: [], creators, viewer })).toContain(
      "live-html-preview-frame",
    );
  });

  test("TemplateDetailPage", async () => {
    expect(typeof TemplateDetailPage({ template, creators, canEdit: true })).toBe(
      "string",
    );
    /** Edit form seeds the preview from the saved HTML with sample-rendered
     *  variables ({{name}} -> Alex Doe), not the raw placeholder. */
    const html = await TemplateDetailPage({ template, creators, canEdit: true });
    expect(html).toContain("live-html-preview-frame");
    expect(html).toContain("Alex Doe");
  });

  test("WebhooksPage", () => {
    expect(typeof WebhooksPage({ webhooks: [webhook], creators })).toBe("string");
    expect(typeof WebhooksPage({ webhooks: [], secret: "shown-once", creators })).toBe(
      "string",
    );
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

  describe("Change password page (#279)", () => {
    test("AccountPasswordPage: the fixed action, three empty password fields, hostile values escaped", async () => {
      const html = await AccountPasswordPage({
        email: "<script>alert(1)</script>@example.com",
        flash: { message: "<img src=x onerror=alert(2)>", type: "error" },
      });
      expect(html).toContain('action="/dashboard/account/password"');
      for (const name of ["current", "password", "confirm"]) {
        expect(html).toMatch(new RegExp(`<input[^>]*type="password"[^>]*name="${name}"`));
      }
      expect(html).toContain('autocomplete="current-password"');
      /** No field is ever refilled: no password reaches a page. */
      expect(html).not.toMatch(/<input[^>]*type="password"[^>]*value=/);
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;@example.com");
      expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
    });

    test("the sidebar links every role to the page, highlighted on it", async () => {
      const html = await AccountPasswordPage({ email: "member@example.com" });
      expect(html).toContain('href="/dashboard/account/password"');
      expect(html).toContain("Change password");
      const other = await TemplatesPage({ templates: [], creators, viewer });
      expect(other).toContain('href="/dashboard/account/password"');
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

describe("Record ownership on the pages (#219)", () => {
  const names: ReadonlyMap<string, string> = new Map([["usr_ann", "Ann"]]);

  test("a member's API keys page has no admin checkbox, toggle or Created by column", async () => {
    const html = await ApiKeysPage({
      keys: [{ ...apiKey, createdByUserId: "usr_ann" }],
      creators: names,
      adminCreatorIds: new Set(),
      canManageAll: false,
    });
    expect(html).toContain("The keys you created");
    expect(html).not.toContain('name="isAdmin"');
    expect(html).not.toContain("/dashboard/api-keys/key_x/admin");
    expect(html).not.toContain("Created by");
    /** Revoke and senders stay: they act on the member's own key. */
    expect(html).toContain("/dashboard/api-keys/key_x/revoke");
  });

  test("an admin's API keys page names each key's creator and why it is disabled", async () => {
    const html = await ApiKeysPage({
      keys: [
        { ...apiKey, id: "key_a", createdByUserId: "usr_ann" },
        { ...apiKey, id: "key_b", createdByUserId: null },
        {
          ...apiKey,
          id: "key_c",
          isActive: false,
          disabledReason: "creator_deactivated",
          createdByUserId: "usr_ann",
        },
        { ...apiKey, id: "key_d", isActive: false, disabledReason: "creator_removed" },
        { ...apiKey, id: "key_e", isActive: false, disabledReason: null },
      ],
      creators: names,
      adminCreatorIds: new Set(),
      canManageAll: true,
    });
    expect(html).toContain("Created by");
    expect(html).toContain("Ann");
    expect(html).toContain("Owner");
    expect(html).toContain("Disabled: creator deactivated");
    expect(html).toContain("Disabled: creator removed");
    expect(html).toContain("Removed account");
    expect(html).toContain("Revoked");
    expect(html).toContain('name="isAdmin"');
  });

  test("a member sees the delete button on its own templates only", async () => {
    const html = await TemplatesPage({
      templates: [
        { ...template, id: "tpl_own", createdByUserId: "usr_ann" },
        { ...template, id: "tpl_other", createdByUserId: "usr_bob" },
      ],
      creators: names,
      viewer: { id: "usr_ann", canManageAll: false },
    });
    expect(html).toContain("/dashboard/templates/tpl_own/delete");
    expect(html).not.toContain("/dashboard/templates/tpl_other/delete");
    /** An id missing from the accounts reads as a removed account. */
    expect(html).toContain("Removed account");
  });

  test("a read-only template detail has no save or delete", async () => {
    const html = await TemplateDetailPage({ template, creators: names, canEdit: false });
    expect(html).toContain("Read-only");
    expect(html).not.toContain("Save Changes");
    expect(html).not.toContain("/dashboard/templates/tpl_x/delete");
  });

  test("domains and webhooks lists name the creator", async () => {
    const domainsHtml = await DomainsPage({
      domains: [{ ...domain, createdByUserId: "usr_ann" }],
      creators: names,
    });
    expect(domainsHtml).toContain("Created by");
    expect(domainsHtml).toContain("Ann");
    const hooksHtml = await WebhooksPage({ webhooks: [webhook], creators: names });
    expect(hooksHtml).toContain("Owner");
  });
});

describe("API keys page: the Make admin button (#219)", () => {
  test("only keys of an active admin or the owner (or with no creator) can be promoted", async () => {
    const html = await ApiKeysPage({
      keys: [
        { ...apiKey, id: "key_admins", createdByUserId: "usr_admin" },
        { ...apiKey, id: "key_members", createdByUserId: "usr_member" },
        { ...apiKey, id: "key_owners", createdByUserId: null },
        {
          ...apiKey,
          id: "key_member_admin",
          isAdmin: true,
          createdByUserId: "usr_member",
        },
      ],
      creators: new Map(),
      adminCreatorIds: new Set(["usr_admin"]),
      canManageAll: true,
    });
    expect(html).toContain("/dashboard/api-keys/key_admins/admin");
    expect(html).toContain("/dashboard/api-keys/key_owners/admin");
    expect(html).not.toContain("/dashboard/api-keys/key_members/admin");
    /** Making an admin key restricted always stays possible. */
    expect(html).toContain("/dashboard/api-keys/key_member_admin/admin");
  });
});
