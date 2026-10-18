import { describe, test, expect } from "bun:test";
import {
  buildTwoFactorAlertEmail,
  sendTwoFactorAlert,
  type TwoFactorAlertEvent,
} from "../../src/modules/users/services/two-factor-alert.service.ts";
import type { SystemMailDeps } from "../../src/modules/users/services/system-mail.service.ts";
import { readLoginRateLimitNumbers } from "../../src/config.ts";
import {
  resetCodesExhaustedAlerts,
  shouldAlertCodesExhausted,
} from "../../src/pages/lib/two-factor-limiter.ts";
import { TWO_FACTOR_WINDOW_SECONDS } from "../../src/modules/users/services/two-factor-policy.service.ts";

/**
 * Security review of #220: the 2FA security emails (contents, no links,
 * never throwing), the once-per-window rule of the exhausted-budget
 * email, and the strict login rate limit numbers.
 */

const EVENTS: TwoFactorAlertEvent[] = [
  "enabled",
  "disabled",
  "recovery_codes_regenerated",
  "removed_by_reset",
  "login_codes_exhausted",
];

describe("buildTwoFactorAlertEmail", () => {
  test.each(EVENTS)(
    "%p: a fixed subject, the facts, the advice, and no link",
    (event) => {
      const mail = buildTwoFactorAlertEmail({
        event,
        email: "member@example.com",
        ip: "203.0.113.5",
        at: new Date(Date.UTC(2026, 9, 18, 14, 3, 27)),
      });
      expect(mail.subject).toContain("BunMail account");
      expect(mail.text).toContain("m***@example.com");
      expect(mail.text).not.toContain("member@example.com");
      expect(mail.text).toContain("IP address: 203.0.113.5");
      expect(mail.text).toContain("2026-10-18 14:03:27 UTC");
      expect(mail.text).toContain("change your password");
      expect(`${mail.text}${mail.html}`).not.toMatch(/https?:|href=|www\./);
    },
  );

  test("each event has its own subject", () => {
    const subjects = EVENTS.map(
      (event) =>
        buildTwoFactorAlertEmail({
          event,
          email: "a@example.com",
          ip: null,
          at: new Date(),
        }).subject,
    );
    expect(new Set(subjects).size).toBe(EVENTS.length);
  });

  test("hostile values are escaped in HTML and flattened in text", () => {
    const mail = buildTwoFactorAlertEmail({
      event: "enabled",
      email: "a@example.com",
      ip: "<script>x</script>\r\nBcc: evil@example.com",
      at: new Date(),
    });
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(mail.text).not.toContain("\r\nBcc:");
  });
});

describe("sendTwoFactorAlert", () => {
  const baseDeps: SystemMailDeps = {
    from: null,
    findDomain: () => Promise.resolve(undefined),
    resolveDkim: () => undefined,
    send: () => Promise.reject(new Error("must not send")),
    hostname: "mail.example.com",
  };

  test("no system sender: not sent, never throws", async () => {
    expect(
      await sendTwoFactorAlert(
        { event: "disabled", userId: "usr_1", email: "a@example.com", ip: null },
        baseDeps,
      ),
    ).toEqual({ sent: false, reason: "not_configured" });
  });

  test("a failing dependency: not sent, never throws", async () => {
    const outcome = await sendTwoFactorAlert(
      { event: "disabled", userId: "usr_1", email: "a@example.com", ip: null },
      {
        ...baseDeps,
        from: "security@example.com",
        findDomain: () => Promise.reject(new Error("db down")),
      },
    );
    expect(outcome.sent).toBe(false);
  });
});

describe("shouldAlertCodesExhausted", () => {
  test("once per account and window", () => {
    resetCodesExhaustedAlerts();
    const now = 1_000_000;
    expect(shouldAlertCodesExhausted("usr_a", now)).toBe(true);
    expect(shouldAlertCodesExhausted("usr_a", now + 1000)).toBe(false);
    expect(shouldAlertCodesExhausted("usr_b", now + 1000)).toBe(true);
    expect(
      shouldAlertCodesExhausted("usr_a", now + TWO_FACTOR_WINDOW_SECONDS * 1000),
    ).toBe(true);
    resetCodesExhaustedAlerts();
  });
});

describe("readLoginRateLimitNumbers", () => {
  test("defaults: 5 per 900 seconds", () => {
    expect(readLoginRateLimitNumbers({ max: undefined, window: "" })).toEqual({
      maxAttempts: 5,
      windowSec: 900,
    });
  });

  test("accepts values in range", () => {
    expect(readLoginRateLimitNumbers({ max: "10", window: "3600" })).toEqual({
      maxAttempts: 10,
      windowSec: 3600,
    });
  });

  test.each([
    ["0", "900"],
    ["abc", "900"],
    ["101", "900"],
    ["-5", "900"],
    ["5", "0"],
    ["5", "59"],
    ["5", "86401"],
    ["5", "1e3"],
    ["5.5", "900"],
  ])("refuses max %p window %p (boot fails)", (max, window) => {
    expect(() => readLoginRateLimitNumbers({ max, window })).toThrow(
      "DASHBOARD_LOGIN_RATE_LIMIT_",
    );
  });
});
