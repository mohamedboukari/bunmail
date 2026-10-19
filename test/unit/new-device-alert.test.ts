import { describe, test, expect, spyOn } from "bun:test";
import {
  buildNewDeviceAlertEmail,
  formatAlertTime,
  sendNewDeviceAlert,
  type NewDeviceAlertInput,
  type SendNewDeviceAlertInput,
} from "../../src/modules/users/services/new-device-alert.service.ts";
import type { SystemMailDeps } from "../../src/modules/users/services/system-mail.service.ts";
import type {
  DkimOptions,
  SendMailResult,
} from "../../src/modules/emails/services/mailer.service.ts";
import type { Domain } from "../../src/modules/domains/types/domain.types.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * The new-device sign-in alert (#282): the pure builder (contents,
 * escaping, no links of any kind) and the send decision with injected
 * dependencies (no DB, no network, no `mock.module`).
 */

const AT = new Date("2026-10-18T14:03:27.456Z");

const INPUT: NewDeviceAlertInput = {
  email: "member@example.com",
  device: "Firefox on Windows",
  ip: "203.0.113.7",
  location: "Lyon, France",
  at: AT,
};

/** Anything a mail client could turn into something to click or a credential. */
function assertNoLinks(value: string): void {
  expect(value).not.toMatch(/https?:/i);
  expect(value).not.toMatch(/www\./i);
  expect(value).not.toMatch(/<a[\s>]/i);
  expect(value).not.toMatch(/href|src=|action=/i);
  expect(value).not.toContain("/dashboard");
  expect(value).not.toContain("token");
  /** No token-like run (a 43-character session or device value, a hash). */
  expect(value).not.toMatch(/[A-Za-z0-9_-]{24,}/);
}

describe("buildNewDeviceAlertEmail", () => {
  test("static subject; the device, IP, location, time, masked account and advice", () => {
    const mail = buildNewDeviceAlertEmail(INPUT);
    expect(mail.subject).toBe("New sign-in to your BunMail account");
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain("m***@example.com");
      expect(part).not.toContain("member@example.com");
      expect(part).toContain("Firefox on Windows");
      expect(part).toContain("203.0.113.7");
      expect(part).toContain("Lyon, France");
      expect(part).toContain("2026-10-18 14:03:27 UTC");
    }
    expect(mail.text).toContain(
      "If this was you, you can ignore this email. If it wasn't, sign in and use " +
        "Account > Active sessions > Sign out all other devices, change your " +
        "password, and tell an administrator.",
    );
    expect(mail.html).toContain(
      "Account &gt; Active sessions &gt; Sign out all other devices",
    );
  });

  test("no links of any kind, in either part", () => {
    const mail = buildNewDeviceAlertEmail(INPUT);
    assertNoLinks(mail.text);
    assertNoLinks(mail.html);
  });

  test("an unknown location is left out; an unknown IP says so", () => {
    const mail = buildNewDeviceAlertEmail({ ...INPUT, ip: null, location: null });
    expect(mail.text).not.toContain("location");
    expect(mail.html).not.toContain("location");
    expect(mail.text).toContain("IP address: unknown");
  });

  test("hostile values are escaped in HTML and flattened in text", () => {
    const hostile = `<img src=x onerror=alert(1)>"Lyon"\r\nBcc: x@example.com`;
    const mail = buildNewDeviceAlertEmail({ ...INPUT, location: hostile });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;&quot;Lyon&quot;");
    expect(mail.text).toContain(
      `Approximate location: <img src=x onerror=alert(1)>"Lyon" Bcc: x@example.com`,
    );
    expect(mail.text.split("\n").some((line) => line.startsWith("Bcc:"))).toBe(false);
  });

  test("formatAlertTime: UTC, to the second", () => {
    expect(formatAlertTime(AT)).toBe("2026-10-18 14:03:27 UTC");
  });
});

/* ─── Sending ─── */

const DOMAIN: Domain = {
  id: "dom_1",
  name: "example.com",
  dkimPrivateKey: "encrypted",
  dkimPublicKey: "PUB",
  dkimSelector: "bunmail",
  dkimPendingSelector: null,
  dkimPendingPrivateKey: null,
  dkimPendingPublicKey: null,
  dkimPendingCreatedAt: null,
  dkimPreviousSelector: null,
  dkimPreviousPublicKey: null,
  dkimRotatedAt: null,
  spfVerified: true,
  dkimVerified: true,
  dmarcVerified: true,
  verifiedAt: new Date(),
  lastCheckedAt: null,
  nextCheckAt: null,
  consecutiveFailures: 0,
  lastCheckResult: null,
  unsubscribeEmail: null,
  unsubscribeUrl: null,
  notifyEmail: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdByUserId: null,
};

const DKIM: DkimOptions = {
  domainName: "example.com",
  keySelector: "bunmail",
  privateKey: "PEM",
};

const SEND_INPUT: SendNewDeviceAlertInput = {
  ...INPUT,
  userId: "usr_1",
  deviceId: "udv_1",
};

type SendArgs = Parameters<SystemMailDeps["send"]>[0];

/** Fake deps; `sent` collects every send call. */
function deps(overrides: Partial<SystemMailDeps> = {}): {
  deps: SystemMailDeps;
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
            "mx.example.com": { status: "sent", recipients: [options.to], attempts: 1 },
          },
        });
      },
      hostname: "mail.example.com",
      ...overrides,
    },
  };
}

describe("sendNewDeviceAlert", () => {
  test("sends to the account from SYSTEM_MAIL_FROM, DKIM-signed; logs warn with ids", async () => {
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    try {
      const { deps: d, sent } = deps();
      expect(await sendNewDeviceAlert(SEND_INPUT, d)).toEqual({ sent: true });
      expect(sent).toHaveLength(1);
      expect(sent[0]?.from).toBe("noreply@example.com");
      expect(sent[0]?.to).toBe("member@example.com");
      expect(sent[0]?.subject).toBe("New sign-in to your BunMail account");
      expect(sent[0]?.dkim).toEqual(DKIM);
      const line = warn.mock.calls.find(([m]) => m === "New-device sign-in alert sent");
      expect(line?.[1]).toMatchObject({ userId: "usr_1", deviceId: "udv_1" });
    } finally {
      warn.mockRestore();
    }
  });

  test("no SYSTEM_MAIL_FROM: nothing sent, an info line records the event", async () => {
    const info = spyOn(logger, "info");
    info.mockClear();
    try {
      const { deps: d, sent } = deps({ from: null });
      expect(await sendNewDeviceAlert(SEND_INPUT, d)).toEqual({
        sent: false,
        reason: "not_configured",
      });
      expect(sent).toHaveLength(0);
      const line = info.mock.calls.find(
        ([m]) => m === "New-device sign-in alert not sent",
      );
      expect(line?.[1]).toEqual({
        userId: "usr_1",
        deviceId: "udv_1",
        ip: "203.0.113.7",
        reason: "not_configured",
      });
    } finally {
      info.mockRestore();
    }
  });

  test("an unusable sender or a failed send: warn with the reason, never thrown", async () => {
    const warn = spyOn(logger, "warn");
    warn.mockClear();
    try {
      const unverified = deps({
        findDomain: () => Promise.resolve({ ...DOMAIN, dkimVerified: false }),
      });
      expect(await sendNewDeviceAlert(SEND_INPUT, unverified.deps)).toEqual({
        sent: false,
        reason: "sender_unavailable",
      });
      expect(unverified.sent).toHaveLength(0);

      const leaky = new Error("RCPT failed for member@example.com");
      const throwing = deps({ send: () => Promise.reject(leaky) });
      expect(await sendNewDeviceAlert(SEND_INPUT, throwing.deps)).toEqual({
        sent: false,
        reason: "send_failed",
      });

      const lines = warn.mock.calls.filter(
        ([m]) => m === "New-device sign-in alert not sent",
      );
      expect(lines).toHaveLength(2);
      expect(lines[0]?.[1]).toMatchObject({
        userId: "usr_1",
        reason: "sender_unavailable",
      });
      expect(lines[1]?.[1]).toMatchObject({ reason: "send_failed", errorName: "Error" });
      expect(JSON.stringify(lines)).not.toContain("RCPT failed");
    } finally {
      warn.mockRestore();
    }
  });
});
