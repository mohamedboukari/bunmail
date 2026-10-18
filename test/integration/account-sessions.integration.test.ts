/**
 * The Active sessions page (#281), through the real `pagesPlugin` over
 * HTTP against real Postgres: the list shows only the signed-in user's
 * live sessions (expired and `pending` ones never), the current one
 * marked; signing out one session revokes exactly that row and only when
 * it belongs to the user (another user's id or an unknown id changes
 * nothing); "sign out all other devices" keeps exactly the current
 * session; signing out the current session signs this browser out; a
 * cross-origin POST is refused. And the approximate location: looked up
 * after a login, in the background, and stored on the session; a failing
 * lookup never breaks the login.
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { Elysia } from "elysia";
import { eq, sql } from "drizzle-orm";
import { db, seed, sessions, truncateAll } from "./_helpers.ts";
import { pagesPlugin } from "../../src/pages/pages.plugin.tsx";
import { readSessionCookie } from "../../src/pages/session.ts";
import { loginAttemptMap } from "../../src/middleware/login-rate-limit.ts";
import { createSession } from "../../src/modules/users/services/session.service.ts";
import { hashToken } from "../../src/modules/users/services/token.service.ts";
import * as geoip from "../../src/modules/users/services/geoip.service.ts";
import { logger } from "../../src/utils/logger.ts";
import { config } from "../../src/config.ts";

const app = new Elysia().use(pagesPlugin);

const PAGE = "/dashboard/account/sessions";
const PASSWORD = "the member password, long enough";
const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";

const originalProxyHops = config.dashboard.trustedProxyHops;

/** The member and its sessions, and a bystander with one session. */
let memberId = "";
let otherUserId = "";
/** This browser. */
let current = { id: "", token: "" };
/** Another device of the member. */
let laptop = { id: "", token: "" };
/** The member's expired and pending sessions: never listed. */
let expiredId = "";
let pendingId = "";
/** The bystander's session. */
let foreign = { id: "", token: "" };

beforeEach(async () => {
  loginAttemptMap.clear();
  await truncateAll();
  memberId = (
    await seed.user({ email: "member@example.com", role: "member", password: PASSWORD })
  ).id;
  otherUserId = (await seed.user({ email: "other@example.com", role: "admin" })).id;

  const created = await createSession({
    userId: memberId,
    assurance: "password",
    authMethod: "password",
    ip: "203.0.113.7",
    userAgent: CHROME_MAC,
  });
  current = { id: created.sessionId, token: created.token };

  laptop = await seed.session({ userId: memberId });
  await db
    .update(sessions)
    .set({ ip: "198.51.100.20", userAgent: FIREFOX_WIN, location: "Lyon, France" })
    .where(eq(sessions.id, laptop.id));

  expiredId = (
    await seed.session({
      userId: memberId,
      expiresAt: sql`now() - interval '1 minute'`,
    })
  ).id;
  pendingId = (await seed.session({ userId: memberId, assurance: "pending" })).id;
  foreign = await seed.session({ userId: otherUserId });
});

afterEach(() => {
  expect(Reflect.set(config.dashboard, "trustedProxyHops", originalProxyHops)).toBe(true);
});

/* ─── Helpers ─── */

/** A request with a session cookie; POSTs are same-origin unless overridden. */
function call(
  method: "GET" | "POST",
  path: string,
  token: string,
  origin = "http://localhost",
): Promise<Response> {
  const url = `http://localhost${path}`;
  const cookie = `bm_session=${token}`;
  if (method === "GET") return app.handle(new Request(url, { headers: { cookie } }));
  return app.handle(
    new Request(url, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    }),
  );
}

/** The ids of the member's session rows still stored. */
async function sessionIdsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.userId, userId));
  return rows.map((row) => row.id).toSorted();
}

/** Logs the member in from `forwardedFor` (one trusted proxy hop). */
function login(forwardedFor: string): Promise<Response> {
  expect(Reflect.set(config.dashboard, "trustedProxyHops", 1)).toBe(true);
  return app.handle(
    new Request("http://localhost/dashboard/login", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
        "x-forwarded-for": forwardedFor,
        "user-agent": FIREFOX_WIN,
      },
      body: new URLSearchParams({
        email: "member@example.com",
        password: PASSWORD,
      }).toString(),
    }),
  );
}

/** Polls a session's stored location until `done` or about a second passed. */
async function waitForLocation(
  sessionId: string,
  done: (location: string | null) => boolean,
): Promise<string | null> {
  let location: string | null = null;
  for (let i = 0; i < 50; i++) {
    const [row] = await db
      .select({ location: sessions.location })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    location = row?.location ?? null;
    if (done(location)) return location;
    await Bun.sleep(20);
  }
  return location;
}

/** The `ses_` id of the session a cookie token belongs to. */
async function sessionIdOfCookie(response: Response): Promise<string> {
  const token = readSessionCookie(response.headers.get("set-cookie"));
  expect(token).toBeDefined();
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.tokenHash, hashToken(token ?? "")));
  if (!row) throw new Error("no session for the cookie");
  return row.id;
}

/** The table row of the page that shows `label` (up to its `</tr>`). */
function rowOf(page: string, label: string): string {
  const start = page.indexOf(label);
  expect(start).toBeGreaterThan(-1);
  return page.slice(start, page.indexOf("</tr>", start));
}

/* ─── The list ─── */

describe("GET /dashboard/account/sessions", () => {
  test("lists only the user's own live sessions, the current one marked", async () => {
    const response = await call("GET", PAGE, current.token);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const page = await response.text();

    /** One revoke form per live session of the member: this one and the laptop. */
    expect(page).toContain(`/dashboard/account/sessions/${current.id}/revoke`);
    expect(page).toContain(`/dashboard/account/sessions/${laptop.id}/revoke`);
    expect(page.match(/\/revoke"/g)?.length).toBe(2);
    expect(page).not.toContain(expiredId);
    expect(page).not.toContain(pendingId);
    expect(page).not.toContain(foreign.id);

    expect(page).toContain("Chrome on macOS");
    expect(page).toContain("Firefox on Windows");
    expect(page).toContain("203.0.113.7");
    expect(page).toContain("198.51.100.20");
    expect(page.match(/This device/g)?.length).toBe(1);

    /** A stored location shows the column, labelled approximate. */
    expect(page).toContain("Approximate location");
    expect(page).toContain("Lyon, France");
    expect(page).toContain("Sign out all other devices");
  });

  test("the This device marker sits on the session of the request", async () => {
    const fromCurrent = await (await call("GET", PAGE, current.token)).text();
    expect(rowOf(fromCurrent, "Chrome on macOS")).toContain("This device");
    expect(rowOf(fromCurrent, "Firefox on Windows")).not.toContain("This device");

    const fromLaptop = await (await call("GET", PAGE, laptop.token)).text();
    expect(rowOf(fromLaptop, "Firefox on Windows")).toContain("This device");
    expect(rowOf(fromLaptop, "Chrome on macOS")).not.toContain("This device");
  });

  test("no location stored: no location column", async () => {
    await db.update(sessions).set({ location: null }).where(eq(sessions.id, laptop.id));
    const page = await (await call("GET", PAGE, current.token)).text();
    expect(page).not.toContain("Approximate location");
  });

  test("a stored user agent and location are escaped", async () => {
    await db
      .update(sessions)
      .set({ location: "<b>x</b>, France" })
      .where(eq(sessions.id, laptop.id));
    const page = await (await call("GET", PAGE, current.token)).text();
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain("&lt;b");
  });

  test("no cookie: to the login page", async () => {
    const response = await app.handle(new Request(`http://localhost${PAGE}`));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard/login");
  });
});

/* ─── Sign out one device ─── */

describe("POST /dashboard/account/sessions/:id/revoke", () => {
  test("revokes the user's own other session, and its cookie dies", async () => {
    const warn = spyOn(logger, "warn");
    try {
      const response = await call("POST", `${PAGE}/${laptop.id}/revoke`, current.token);
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Signed out that device.",
      );
      expect(await sessionIdsOf(memberId)).toEqual(
        [current.id, expiredId, pendingId].toSorted(),
      );
      expect(warn).toHaveBeenCalledWith(
        "Session revoked by its user",
        expect.objectContaining({
          userId: memberId,
          sessionId: laptop.id,
          current: false,
        }),
      );
    } finally {
      warn.mockRestore();
    }

    const replay = await call("GET", PAGE, laptop.token);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("/dashboard/login");
    /** This browser is still signed in. */
    expect((await call("GET", PAGE, current.token)).status).toBe(200);
  });

  test("another user's session id: 404, nothing changes", async () => {
    const before = await sessionIdsOf(otherUserId);
    const response = await call("POST", `${PAGE}/${foreign.id}/revoke`, current.token);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("That session was not found");
    expect(await sessionIdsOf(otherUserId)).toEqual(before);
    expect(await sessionIdsOf(memberId)).toHaveLength(4);
    /** The bystander is still signed in. */
    expect((await call("GET", PAGE, foreign.token)).status).toBe(200);
  });

  test("an unknown session id: 404, nothing changes", async () => {
    const response = await call("POST", `${PAGE}/ses_unknown/revoke`, current.token);
    expect(response.status).toBe(404);
    expect(await sessionIdsOf(memberId)).toHaveLength(4);
    expect(await sessionIdsOf(otherUserId)).toEqual([foreign.id]);
  });

  test("the current session: signs this browser out", async () => {
    const response = await call("POST", `${PAGE}/${current.id}/revoke`, current.token);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard/login");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await sessionIdsOf(memberId)).not.toContain(current.id);
    expect(await sessionIdsOf(memberId)).toContain(laptop.id);

    const replay = await call("GET", PAGE, current.token);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe("/dashboard/login");
  });

  test("a cross-origin POST is refused, nothing changes", async () => {
    const response = await call(
      "POST",
      `${PAGE}/${laptop.id}/revoke`,
      current.token,
      "https://evil.example",
    );
    expect(response.status).toBe(403);
    expect(await sessionIdsOf(memberId)).toHaveLength(4);
  });
});

/* ─── Sign out all other devices ─── */

describe("POST /dashboard/account/sessions/revoke-others", () => {
  test("keeps exactly the current session, other users untouched", async () => {
    const warn = spyOn(logger, "warn");
    try {
      const response = await call("POST", `${PAGE}/revoke-others`, current.token);
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Signed out 3 other devices.",
      );
      expect(warn).toHaveBeenCalledWith(
        "Other sessions revoked by their user",
        expect.objectContaining({
          userId: memberId,
          sessionId: current.id,
          sessionsRevoked: 3,
        }),
      );
    } finally {
      warn.mockRestore();
    }
    expect(await sessionIdsOf(memberId)).toEqual([current.id]);
    expect(await sessionIdsOf(otherUserId)).toEqual([foreign.id]);

    expect((await call("GET", PAGE, current.token)).status).toBe(200);
    expect((await call("GET", PAGE, laptop.token)).status).toBe(302);
    expect((await call("GET", PAGE, foreign.token)).status).toBe(200);
  });

  test("a cross-origin POST is refused, nothing changes", async () => {
    const response = await call(
      "POST",
      `${PAGE}/revoke-others`,
      current.token,
      "https://evil.example",
    );
    expect(response.status).toBe(403);
    expect(await sessionIdsOf(memberId)).toHaveLength(4);
  });
});

/* ─── Approximate location ─── */

describe("session location", () => {
  test("a login stores the location once the background lookup is done", async () => {
    const lookup = spyOn(geoip, "lookupLocation").mockResolvedValue("Paris, France");
    try {
      const response = await login("8.8.8.8");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const sessionId = await sessionIdOfCookie(response);

      expect(await waitForLocation(sessionId, (location) => location !== null)).toBe(
        "Paris, France",
      );
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(lookup.mock.calls[0]?.[0]).toBe("8.8.8.8");
    } finally {
      lookup.mockRestore();
    }
  });

  test("a failing lookup never breaks the login, and is logged", async () => {
    const lookup = spyOn(geoip, "lookupLocation").mockRejectedValue(
      new Error("ipinfo answered HTTP 429"),
    );
    const warn = spyOn(logger, "warn");
    try {
      const response = await login("8.8.4.4");
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const sessionId = await sessionIdOfCookie(response);

      /** Wait for the background lookup to settle, then check it logged and stored nothing. */
      for (let i = 0; i < 50 && warn.mock.calls.length === 0; i++) await Bun.sleep(20);
      expect(warn).toHaveBeenCalledWith(
        "Session location lookup failed",
        expect.objectContaining({ sessionId, error: "ipinfo answered HTTP 429" }),
      );
      expect(await waitForLocation(sessionId, () => false)).toBeNull();

      /** The new session works. */
      const token = readSessionCookie(response.headers.get("set-cookie")) ?? "";
      expect((await call("GET", PAGE, token)).status).toBe(200);
    } finally {
      lookup.mockRestore();
      warn.mockRestore();
    }
  });

  test("location off (the default): nothing is stored", async () => {
    const response = await login("8.8.8.8");
    expect(response.status).toBe(302);
    const sessionId = await sessionIdOfCookie(response);
    expect(await waitForLocation(sessionId, () => false)).toBeNull();
  });
});
