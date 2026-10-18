/**
 * The new-device sign-in alert (#282) against real Postgres, through the
 * real `pagesPlugin` over HTTP: the `bm_device` cookie, the
 * `user_devices` rows and when an alert goes out.
 *
 * - The account's first device is recorded without an alert.
 * - A browser new to the account (no cookie, a forged or malformed one,
 *   or one only another account used) gets exactly one alert and a cookie.
 * - The same browser within 30 days gets none and moves `last_seen_at`;
 *   after 31 days it alerts again.
 * - No `SYSTEM_MAIL_FROM`: no email, the event logged, the login fine. A
 *   failing send or device check never breaks the login.
 * - The email has no link and nothing token-like.
 * - Owner setup, invitation accept, password reset and password change
 *   never run the check.
 * - The purge removes devices not seen for 400 days; removing an account
 *   removes its devices.
 *
 * No SMTP: `sendMail` is stubbed with `spyOn`, so the real sender
 * decision (`SYSTEM_MAIL_FROM`, the registered DKIM-verified domain, the
 * DKIM key) runs and only the delivery is fake. The background check is
 * awaited through a call-through spy on `recognizeSignInDevice`.
 */
import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  type Mock,
} from "bun:test";
import { Elysia } from "elysia";
import { eq, sql } from "drizzle-orm";
import { db, seed, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { readSessionCookie } from "../../src/pages/session.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { domains } from "../../src/modules/domains/models/domain.schema.ts";
import * as mailer from "../../src/modules/emails/services/mailer.service.ts";
import { runDeviceSweep } from "../../src/modules/trash/services/purge.service.ts";
import { UserStoreError } from "../../src/modules/users/errors.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { userDevices } from "../../src/modules/users/models/user-device.schema.ts";
import * as geoip from "../../src/modules/users/services/geoip.service.ts";
import { createInvitation } from "../../src/modules/users/services/invite.service.ts";
import { bootstrapOwner } from "../../src/modules/users/services/owner.service.ts";
import * as signInDevice from "../../src/modules/users/services/sign-in-device.service.ts";
import { hashToken, mintToken } from "../../src/modules/users/services/token.service.ts";
import { issuePasswordReset } from "../../src/modules/users/services/user-admin.service.ts";
import * as userDevice from "../../src/modules/users/services/user-device.service.ts";
import { generateId } from "../../src/utils/id.ts";
import { logger } from "../../src/utils/logger.ts";
import { config } from "../../src/config.ts";

const app = new Elysia().use(pagesPlugin);

const PASSWORD = "the member password, long enough";
const NEW_PASSWORD = "a brand new password, long enough";
const MEMBER = "member@example.com";
const OWNER = "owner@example.com";
const SENDER = "security@example.com";
const ALERT_SUBJECT = "New sign-in to your BunMail account";
const FIREFOX_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const originalProxyHops = config.dashboard.trustedProxyHops;
const originalFrom = config.systemMailFrom;

let memberId = "";
let ownerId = "";

/** Every `sendMail` call; resolves as accepted unless a test says otherwise. */
let sendMail: Mock<typeof mailer.sendMail>;
/** Call-through spy: its results are the background checks' promises. */
let check: Mock<typeof signInDevice.recognizeSignInDevice>;

/** Sets `config.systemMailFrom` (read-only only to TypeScript). */
function setSystemMailFrom(value: string | null): void {
  expect(Reflect.set(config, "systemMailFrom", value)).toBe(true);
}

beforeEach(async () => {
  loginAttemptMap.clear();
  await truncateAll();
  ownerId = (await seed.user({ email: OWNER, role: "owner", password: PASSWORD })).id;
  memberId = (await seed.user({ email: MEMBER, role: "member", password: PASSWORD })).id;

  /** A registered, DKIM-verified sender domain, so the real sender decision says yes. */
  const domain = await seed.domain({ name: "example.com" });
  await db.update(domains).set({ dkimVerified: true }).where(eq(domains.id, domain.id));
  setSystemMailFrom(SENDER);
  expect(Reflect.set(config.dashboard, "trustedProxyHops", 1)).toBe(true);

  sendMail = spyOn(mailer, "sendMail").mockImplementation((options) =>
    Promise.resolve({
      messageId: options.messageId,
      deliveryState: {
        "mx.example.com": { status: "sent", recipients: [options.to], attempts: 1 },
      },
    }),
  );
  check = spyOn(signInDevice, "recognizeSignInDevice");
});

afterEach(() => {
  sendMail.mockRestore();
  check.mockRestore();
  setSystemMailFrom(originalFrom);
  expect(Reflect.set(config.dashboard, "trustedProxyHops", originalProxyHops)).toBe(true);
});

/* ─── Helpers ─── */

/** Waits for every background device check started since call number `from`. */
async function settleChecks(from: number): Promise<void> {
  await Promise.all(check.mock.results.slice(from).map((result) => result.value));
}

/** The `bm_device` value a response sets, or undefined. */
function deviceCookieOf(response: Response): string | undefined {
  return response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith("bm_device="))
    ?.match(/^bm_device=([^;]*)/)?.[1];
}

/**
 * Signs in with a password, optionally presenting a `bm_device` cookie,
 * and waits for the background check. Returns the response and the device
 * cookie it set.
 */
async function login(
  opts: { email?: string; device?: string; ip?: string; userAgent?: string } = {},
): Promise<{ response: Response; device: string }> {
  const before = check.mock.calls.length;
  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded",
    origin: "http://localhost",
    "x-forwarded-for": opts.ip ?? "203.0.113.9",
    "user-agent": opts.userAgent ?? FIREFOX_WIN,
  };
  if (opts.device !== undefined) headers["cookie"] = `bm_device=${opts.device}`;
  const response = await app.handle(
    new Request("http://localhost/dashboard/login", {
      method: "POST",
      headers,
      body: new URLSearchParams({
        email: opts.email ?? MEMBER,
        password: PASSWORD,
      }).toString(),
    }),
  );
  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/dashboard");
  await settleChecks(before);
  const device = deviceCookieOf(response);
  if (!device) throw new Error("the login set no bm_device cookie");
  return { response, device };
}

/** The alerts handed to `sendMail` so far. */
function alerts(): Array<Parameters<typeof mailer.sendMail>[0]> {
  return sendMail.mock.calls
    .map(([options]) => options)
    .filter((options) => options.subject === ALERT_SUBJECT);
}

/** The device rows of an account. */
function devicesOf(userId: string): Promise<Array<typeof userDevices.$inferSelect>> {
  return db.select().from(userDevices).where(eq(userDevices.userId, userId));
}

/** Moves a device row's `last_seen_at` back by `days`. */
async function age(deviceCookie: string, days: number): Promise<void> {
  await db
    .update(userDevices)
    .set({ lastSeenAt: sql.raw(`now() - interval '${days} days'`) })
    .where(eq(userDevices.deviceHash, hashToken(deviceCookie)));
}

/* ─── Recognition and alerts ─── */

describe("sign-in from a device", () => {
  test("the account's first device is recorded, without an alert", async () => {
    const { device, response } = await login();
    expect(device).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(device).not.toBe(readSessionCookie(response.headers.get("set-cookie")));

    const rows = await devicesOf(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toMatch(/^udv_/);
    /** Only the hash is stored. */
    expect(rows[0]?.deviceHash).toBe(hashToken(device));
    expect(JSON.stringify(rows)).not.toContain(device);
    expect(rows[0]?.userAgent).toBe("Firefox on Windows");
    expect(rows[0]?.ip).toBe("203.0.113.9");
    expect(alerts()).toHaveLength(0);
  });

  test("a new browser (no cookie) gets exactly one alert and its own cookie", async () => {
    const first = await login();
    const second = await login({ userAgent: CHROME_MAC, ip: "198.51.100.20" });
    expect(second.device).not.toBe(first.device);
    expect(await devicesOf(memberId)).toHaveLength(2);

    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.to).toBe(MEMBER);
    expect(alerts()[0]?.text).toContain("Chrome on macOS");
    expect(alerts()[0]?.text).toContain("198.51.100.20");
  });

  test("the same browser again: no alert, last_seen_at, IP and label move forward", async () => {
    const { device } = await login();
    await age(device, 1);
    const [before] = await devicesOf(memberId);

    const again = await login({ device, ip: "198.51.100.77", userAgent: CHROME_MAC });
    expect(again.device).toBe(device);
    expect(alerts()).toHaveLength(0);

    const rows = await devicesOf(memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.lastSeenAt.getTime()).toBeGreaterThan(
      before?.lastSeenAt.getTime() ?? 0,
    );
    expect(rows[0]?.firstSeenAt.getTime()).toBe(before?.firstSeenAt.getTime() ?? -1);
    expect(rows[0]?.ip).toBe("198.51.100.77");
    expect(rows[0]?.userAgent).toBe("Chrome on macOS");
  });

  test("seen 29 days ago: still known; 31 days ago: alerts again", async () => {
    const { device } = await login();

    await age(device, 29);
    await login({ device });
    expect(alerts()).toHaveLength(0);

    await age(device, 31);
    await login({ device });
    expect(alerts()).toHaveLength(1);

    /** The alert refreshed it: known again. */
    await login({ device });
    expect(alerts()).toHaveLength(1);
    expect(await devicesOf(memberId)).toHaveLength(1);
  });

  test("a stale browser alerts even while another browser of the account is recent", async () => {
    const laptop = (await login()).device;
    const phone = (await login({ userAgent: CHROME_MAC })).device;
    expect(alerts()).toHaveLength(1);

    await age(phone, 31);
    await login({ device: laptop });
    expect(alerts()).toHaveLength(1);
    await login({ device: phone });
    expect(alerts()).toHaveLength(2);
  });

  test("a forged or malformed cookie is treated as a new browser", async () => {
    await login();

    const garbage = await login({ device: "garbage;value" });
    expect(garbage.device).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(alerts()).toHaveLength(1);

    const oversized = await login({ device: "A".repeat(500) });
    expect(oversized.device).not.toBe("A".repeat(500));
    expect(alerts()).toHaveLength(2);

    /** Well-formed but never seen by this account: kept, and new. */
    const forged = mintToken().token;
    const kept = await login({ device: forged });
    expect(kept.device).toBe(forged);
    expect(alerts()).toHaveLength(3);
  });

  test("a browser another account used is new to this one", async () => {
    const memberBrowser = (await login()).device;
    await login({ email: OWNER, device: mintToken().token });
    expect(alerts()).toHaveLength(0);

    await login({ email: OWNER, device: memberBrowser });
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.to).toBe(OWNER);
    expect(await devicesOf(ownerId)).toHaveLength(2);
    expect(await devicesOf(memberId)).toHaveLength(1);
  });
});

/* ─── The email ─── */

describe("the alert email", () => {
  test("from SYSTEM_MAIL_FROM, DKIM-signed, with the facts and no link or token", async () => {
    const lookup = spyOn(geoip, "lookupLocation").mockResolvedValue("Paris, France");
    try {
      const first = await login();
      const second = await login({ ip: "198.51.100.20" });

      expect(alerts()).toHaveLength(1);
      const mail = alerts()[0];
      expect(mail?.from).toBe(SENDER);
      expect(mail?.to).toBe(MEMBER);
      expect(mail?.dkim?.domainName).toBe("example.com");

      const text = mail?.text ?? "";
      const html = mail?.html ?? "";
      expect(text).toContain("m***@example.com");
      expect(text).toContain("Device: Firefox on Windows");
      expect(text).toContain("IP address: 198.51.100.20");
      expect(text).toContain("Approximate location: Paris, France");
      expect(text).toMatch(/Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
      expect(text).toContain("Account > Active sessions > Sign out all other devices");

      for (const part of [text, html]) {
        expect(part).not.toMatch(/https?:/i);
        expect(part).not.toMatch(/<a[\s>]|href/i);
        expect(part).not.toMatch(/[A-Za-z0-9_-]{24,}/);
        for (const secret of [
          first.device,
          second.device,
          readSessionCookie(second.response.headers.get("set-cookie")) ?? "",
          hashToken(second.device),
        ]) {
          expect(part).not.toContain(secret);
        }
      }

      /** The device row keeps the location too. */
      const rows = await devicesOf(memberId);
      expect(rows.every((row) => row.location === "Paris, France")).toBe(true);
    } finally {
      lookup.mockRestore();
    }
  });

  test("no SYSTEM_MAIL_FROM: no email, the login works, the event is logged", async () => {
    setSystemMailFrom(null);
    const info = spyOn(logger, "info");
    try {
      await login();
      const second = await login({ ip: "198.51.100.20" });
      expect(readSessionCookie(second.response.headers.get("set-cookie"))).toBeDefined();
      expect(sendMail).not.toHaveBeenCalled();

      const row = (await devicesOf(memberId)).find(
        (r) => r.deviceHash === hashToken(second.device),
      );
      const event = info.mock.calls.find(([m]) => m === "New-device sign-in");
      expect(event?.[1]).toEqual({
        userId: memberId,
        deviceId: row?.id,
        ip: "198.51.100.20",
      });
      const notSent = info.mock.calls.find(
        ([m]) => m === "New-device sign-in alert not sent",
      );
      expect(notSent?.[1]).toMatchObject({ userId: memberId, reason: "not_configured" });
    } finally {
      info.mockRestore();
    }
  });

  test("a throwing sender never breaks the login", async () => {
    await login();
    sendMail.mockImplementation(() =>
      Promise.reject(new Error("SMTP refused member@example.com")),
    );
    const warn = spyOn(logger, "warn");
    try {
      const second = await login();
      expect(readSessionCookie(second.response.headers.get("set-cookie"))).toBeDefined();
      const line = warn.mock.calls.find(
        ([m]) => m === "New-device sign-in alert not sent",
      );
      expect(line?.[1]).toMatchObject({ userId: memberId, reason: "send_failed" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("SMTP refused");
    } finally {
      warn.mockRestore();
    }
  });

  test("a failing device check never breaks the login", async () => {
    const record = spyOn(userDevice, "recordSignInDevice").mockRejectedValue(
      new UserStoreError("57P01"),
    );
    const warn = spyOn(logger, "warn");
    try {
      const { response } = await login();
      expect(readSessionCookie(response.headers.get("set-cookie"))).toBeDefined();
      const line = warn.mock.calls.find(([m]) => m === "New-device sign-in check failed");
      expect(line?.[1]).toMatchObject({
        userId: memberId,
        errorName: "UserStoreError",
        sqlState: "57P01",
      });
      expect(alerts()).toHaveLength(0);
    } finally {
      record.mockRestore();
      warn.mockRestore();
    }
  });
});

/* ─── Flows that are not a password sign-in ─── */

describe("other sign-in flows never run the check", () => {
  /** A form POST from a browser with no device cookie. */
  function post(
    path: string,
    body: Record<string, string>,
    sessionToken?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
      "x-forwarded-for": "198.51.100.30",
    };
    if (sessionToken) headers["cookie"] = `bm_session=${sessionToken}`;
    return app.handle(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers,
        body: new URLSearchParams(body).toString(),
      }),
    );
  }

  /** Asserts a flow signed in (302 and a session cookie) without the device check. */
  function expectSignedInWithoutCheck(response: Response, checksBefore: number): void {
    expect(response.status).toBe(302);
    expect(readSessionCookie(response.headers.get("set-cookie"))).toBeDefined();
    expect(deviceCookieOf(response)).toBeUndefined();
    expect(check.mock.calls.length).toBe(checksBefore);
  }

  test("owner setup, invitation accept, password reset and password change", async () => {
    /** The member already has a device, so a check would alert. */
    const { response: loggedIn } = await login();
    const memberSession = readSessionCookie(loggedIn.headers.get("set-cookie")) ?? "";
    const checks = check.mock.calls.length;

    /** Password change from the signed-in browser. */
    const changed = await post(
      "/dashboard/account/password",
      { current: PASSWORD, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
      memberSession,
    );
    expect(changed.status).toBe(302);
    expect(deviceCookieOf(changed)).toBeUndefined();
    expect(check.mock.calls.length).toBe(checks);

    /** Password reset issued by the owner. */
    const issued = await issuePasswordReset(ownerId, memberId);
    if (!issued.ok) throw new Error(`expected a reset link, got ${issued.reason}`);
    const resetToken = new URL(issued.url).searchParams.get("token") ?? "";
    const reset = await post("/dashboard/reset", {
      token: resetToken,
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expectSignedInWithoutCheck(reset, checks);

    /** Invitation accept. */
    const invited = await createInvitation(
      { id: ownerId, role: "owner" },
      "new@example.org",
      "member",
    );
    if (!invited.ok) throw new Error(`expected an invitation, got ${invited.reason}`);
    const accepted = await post("/dashboard/invite", {
      token: invited.invitation.token,
      name: "New Person",
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expectSignedInWithoutCheck(accepted, checks);

    /** Owner setup (a fresh install: the seeded owner is removed first). */
    await db.delete(users).where(eq(users.id, ownerId));
    const bootstrapped = await bootstrapOwner("first.owner@example.com");
    if (bootstrapped.kind !== "created") throw new Error(`got ${bootstrapped.kind}`);
    const setup = await post("/dashboard/setup", {
      token: bootstrapped.token,
      password: PASSWORD,
      confirm: PASSWORD,
    });
    expectSignedInWithoutCheck(setup, checks);

    expect(alerts()).toHaveLength(0);
    expect(await db.select().from(userDevices)).toHaveLength(1);
  });
});

/* ─── Housekeeping ─── */

describe("retention", () => {
  /** Inserts a device row for the member last seen `days` ago. */
  async function deviceSeen(days: number): Promise<string> {
    const id = generateId("udv");
    await db.insert(userDevices).values({
      id,
      userId: memberId,
      deviceHash: hashToken(mintToken().token),
      userAgent: "Firefox on Windows",
      lastSeenAt: sql.raw(`now() - interval '${days} days'`),
      firstSeenAt: sql.raw(`now() - interval '${days} days'`),
    });
    return id;
  }

  test("the purge removes devices not seen for 400 days, and only those", async () => {
    const old = await deviceSeen(401);
    const recent = await deviceSeen(399);
    expect(await runDeviceSweep()).toEqual({ deleted: 1 });
    const ids = (await devicesOf(memberId)).map((row) => row.id);
    expect(ids).toEqual([recent]);
    expect(ids).not.toContain(old);
  });

  test("removing an account removes its devices", async () => {
    await login();
    await login({ email: OWNER });
    await db.delete(users).where(eq(users.id, memberId));
    expect(await devicesOf(memberId)).toHaveLength(0);
    expect(await devicesOf(ownerId)).toHaveLength(1);
  });
});
