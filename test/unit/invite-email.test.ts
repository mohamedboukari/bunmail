import { describe, test, expect, spyOn } from "bun:test";
import {
  buildInviteEmail,
  sendInviteEmail,
  type InviteMailDeps,
  type SendInviteEmailInput,
} from "../../src/modules/users/services/invite-email.service.ts";
import type {
  DkimOptions,
  SendMailResult,
} from "../../src/modules/emails/services/mailer.service.ts";
import type { Domain } from "../../src/modules/domains/types/domain.types.ts";
import { UserStoreError } from "../../src/modules/users/errors.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The invitation email (#217): the pure builder (escaping, exactly one
 * link) and the send decision, with injected dependencies (no DB, no
 * network, no `mock.module`).
 */

const URL_ = "https://mail.example.com/dashboard/invite?token=" + "T".repeat(43);
const EXPIRES = new Date("2026-10-25T12:00:00.000Z");

/** Counts `http(s)://` occurrences: the accept link must be the only URL. */
function urlCount(value: string): number {
  return value.match(/https?:\/\//g)?.length ?? 0;
}

describe("buildInviteEmail", () => {
  test("static subject; text and HTML name the inviter, role, link and expiry", () => {
    const mail = buildInviteEmail({
      url: URL_,
      inviter: "Ann",
      role: "admin",
      expiresAt: EXPIRES,
    });
    expect(mail.subject).toBe("You're invited to BunMail");
    expect(mail.text).toContain("Ann invited you to join BunMail as an admin.");
    expect(mail.text).toContain(URL_);
    expect(mail.text).toContain(EXPIRES.toUTCString());
    expect(mail.html).toContain(`href="${URL_}"`);
    expect(mail.html).toContain("as an admin.");
  });

  test("a hostile inviter name is escaped in HTML and flattened in text", () => {
    const hostile = `<img src=x onerror=alert(1)>"Eve"\r\nBcc: x@example.com`;
    const mail = buildInviteEmail({
      url: URL_,
      inviter: hostile,
      role: "member",
      expiresAt: EXPIRES,
    });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;Eve&quot;");
    expect(mail.text.split("\n")[0]).toBe(
      `<img src=x onerror=alert(1)>"Eve" Bcc: x@example.com invited you to join BunMail as a member.`,
    );
    expect(mail.subject).not.toContain("Eve");
  });

  test("exactly one link in each part, even when the inviter is an email address", () => {
    const mail = buildInviteEmail({
      url: URL_,
      inviter: "ann@example.com",
      role: "member",
      expiresAt: EXPIRES,
    });
    expect(mail.html.match(/<a\s/g)?.length).toBe(1);
    expect(mail.html.match(/href=/g)?.length).toBe(1);
    expect(urlCount(mail.html)).toBe(1);
    expect(urlCount(mail.text)).toBe(1);
    expect(mail.html).not.toContain("<img");
  });

  test("an attribute-breaking link is escaped inside href", () => {
    const mail = buildInviteEmail({
      url: `https://mail.example.com/x"><script>`,
      inviter: "Ann",
      role: "member",
      expiresAt: EXPIRES,
    });
    expect(mail.html).toContain(
      `href="https://mail.example.com/x&quot;&gt;&lt;script&gt;"`,
    );
    expect(mail.html).not.toContain("<script>");
  });
});

/* ─── sendInviteEmail ─── */

const DOMAIN: Domain = {
  id: "dom_1",
  name: "example.com",
  dkimPrivateKey: "v1:a:b:c",
  dkimPublicKey: null,
  dkimSelector: "bunmail",
  spfVerified: true,
  dkimVerified: true,
  dmarcVerified: true,
  verifiedAt: new Date(),
  unsubscribeEmail: null,
  unsubscribeUrl: null,
  notifyEmail: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const DKIM: DkimOptions = {
  domainName: "example.com",
  keySelector: "bunmail",
  privateKey: "PEM",
};

const INPUT: SendInviteEmailInput = {
  invitationId: "utk_1",
  to: "new@example.org",
  url: URL_,
  inviter: "Ann",
  role: "member",
  expiresAt: EXPIRES,
};

type SendArgs = Parameters<InviteMailDeps["send"]>[0];

/** Fake deps; `sent` collects every send call. */
function deps(overrides: Partial<InviteMailDeps> = {}): {
  deps: InviteMailDeps;
  sent: SendArgs[];
} {
  const sent: SendArgs[] = [];
  return {
    sent,
    deps: {
      from: "noreply@example.com",
      findDomain: (name) => Promise.resolve(name === "example.com" ? DOMAIN : undefined),
      resolveDkim: () => DKIM,
      send: (options): Promise<SendMailResult> => {
        sent.push(options);
        return Promise.resolve({
          messageId: options.messageId,
          deliveryState: {
            "mx.example.org": { status: "sent", recipients: [options.to], attempts: 1 },
          },
        });
      },
      hostname: "mail.example.com",
      ...overrides,
    },
  };
}

describe("sendInviteEmail", () => {
  test("sends from SYSTEM_MAIL_FROM, signed with the domain's DKIM key", async () => {
    const { deps: d, sent } = deps();
    expect(await sendInviteEmail(INPUT, d)).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    const call = sent[0];
    expect(call?.from).toBe("noreply@example.com");
    expect(call?.to).toBe("new@example.org");
    expect(call?.subject).toBe("You're invited to BunMail");
    expect(call?.dkim).toEqual(DKIM);
    expect(call?.messageId).toMatch(/^<[0-9a-f]{32}@mail\.example\.com>$/);
    expect(call?.text).toContain(URL_);
  });

  test("no SYSTEM_MAIL_FROM: not_configured, nothing sent", async () => {
    const { deps: d, sent } = deps({ from: null });
    expect(await sendInviteEmail(INPUT, d)).toEqual({
      sent: false,
      reason: "not_configured",
    });
    expect(sent).toHaveLength(0);
  });

  test("sender domain not registered: sender_unavailable", async () => {
    const { deps: d, sent } = deps({ from: "noreply@other.example.net" });
    expect(await sendInviteEmail(INPUT, d)).toEqual({
      sent: false,
      reason: "sender_unavailable",
    });
    expect(sent).toHaveLength(0);
  });

  test("sender domain not DKIM-verified: sender_unavailable", async () => {
    const { deps: d, sent } = deps({
      findDomain: () => Promise.resolve({ ...DOMAIN, dkimVerified: false }),
    });
    expect(await sendInviteEmail(INPUT, d)).toEqual({
      sent: false,
      reason: "sender_unavailable",
    });
    expect(sent).toHaveLength(0);
  });

  test("no usable DKIM key: sender_unavailable, never sent unsigned", async () => {
    const { deps: d, sent } = deps({ resolveDkim: () => undefined });
    expect(await sendInviteEmail(INPUT, d)).toEqual({
      sent: false,
      reason: "sender_unavailable",
    });
    expect(sent).toHaveLength(0);
  });

  test("a throwing send or lookup: send_failed, never thrown", async () => {
    const throwing = deps({ send: () => Promise.reject(new Error("boom")) });
    expect(await sendInviteEmail(INPUT, throwing.deps)).toEqual({
      sent: false,
      reason: "send_failed",
    });
    const lookup = deps({ findDomain: () => Promise.reject(new Error("db down")) });
    expect(await sendInviteEmail(INPUT, lookup.deps)).toEqual({
      sent: false,
      reason: "send_failed",
    });
  });

  test("a failing lookup is logged by name and SQLSTATE, never by its raw message", async () => {
    const warn = spyOn(logger, "warn");
    /** Start from zero: a spy left on logger.warn by another file keeps its history. */
    warn.mockClear();
    try {
      const leaky = new Error(
        "Failed query: select * from domains where name = $1\nparams: secret@example.com",
      );
      const d1 = deps({ findDomain: () => Promise.reject(leaky) });
      await sendInviteEmail(INPUT, d1.deps);
      const d2 = deps({ findDomain: () => Promise.reject(new UserStoreError("57P01")) });
      await sendInviteEmail(INPUT, d2.deps);

      const lines = warn.mock.calls.filter(([m]) => m === "Invitation email not sent");
      expect(lines).toHaveLength(2);
      expect(JSON.stringify(lines)).not.toContain("Failed query");
      expect(JSON.stringify(lines)).not.toContain("secret@example.com");
      expect(lines[0]?.[1]).toMatchObject({ reason: "send_failed", errorName: "Error" });
      expect(lines[1]?.[1]).toMatchObject({
        errorName: "UserStoreError",
        sqlState: "57P01",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("no MX group accepted it: send_failed", async () => {
    const { deps: d } = deps({
      send: (options) =>
        Promise.resolve({
          messageId: options.messageId,
          deliveryState: {
            "mx.example.org": { status: "retry", recipients: [options.to], attempts: 1 },
          },
        }),
    });
    expect(await sendInviteEmail(INPUT, d)).toEqual({
      sent: false,
      reason: "send_failed",
    });
  });
});
