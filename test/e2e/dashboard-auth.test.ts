import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import {
  ACCOUNT,
  OWNER,
  UserStoreError,
  app,
  cookieValue,
  createSession,
  errorLog,
  fakeSessions,
  fakeToken,
  findActiveSession,
  getWithSession,
  infoLog,
  pagesPlugin,
  postLogin,
  recognizeSignInDevice,
  revokeAllUserSessions,
  revokeSessionByToken,
  rotateSession,
  securityHeadersPlugin,
  seedSession,
  useDashboardMocks,
  verifyPasswordLogin,
  warnLog,
} from "./dashboard-setup.ts";

/** Dashboard E2E: sign-in, sessions and sign-out. Setup, fakes and helpers: `dashboard-setup.ts` (#291). */
useDashboardMocks();

describe("Dashboard E2E: sign-in, sessions and sign-out", () => {
  describe("GET /dashboard/login", () => {
    test("returns 200 with the email and password form", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/login"));
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Sign in");
      expect(html).toContain('name="email"');
      expect(html).toContain('name="password"');
    });

    test("carries the auth-page headers: no-store, nosniff, DENY, strict-origin", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/login"));
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
    });

    test("shows the generic error when error=invalid", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/login?error=invalid"),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Invalid email or password.");
    });
  });

  describe("Self-hosted assets (#255, part 2)", () => {
    /** With the real security headers, whose `no-store` the assets must override. */
    const withHeaders = new Elysia()
      .use(securityHeadersPlugin({ httpsBaseUrl: false }))
      .use(pagesPlugin);

    /** The `?v=` the login page links `name` with. */
    async function linkedVersion(name: string): Promise<string | undefined> {
      const html = await (
        await app.handle(new Request("http://localhost/dashboard/login"))
      ).text();
      return html.match(
        new RegExp(`/dashboard/assets/${name.replace(".", "\\.")}\\?v=([0-9a-f]{12})`),
      )?.[1];
    }

    test("the script is public, typed, cached for a year and matches its ?v= hash", async () => {
      const response = await withHeaders.handle(
        new Request("http://localhost/dashboard/assets/dashboard.js"),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe(
        "public, max-age=31536000, immutable",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const body = new Uint8Array(await response.arrayBuffer());
      const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex");
      expect(await linkedVersion("dashboard.js")).toBe(hash.slice(0, 12));
    });

    test("the stylesheet is served when built, a plain 404 otherwise", async () => {
      const built = await Bun.file(
        new URL("../../src/pages/assets/dashboard.css", import.meta.url),
      ).exists();
      const response = await withHeaders.handle(
        new Request("http://localhost/dashboard/assets/dashboard.css"),
      );
      if (built) {
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
        expect(response.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
        expect(await linkedVersion("dashboard.css")).toMatch(/^[0-9a-f]{12}$/);
      } else {
        expect(response.status).toBe(404);
        expect(await linkedVersion("dashboard.css")).toBeUndefined();
      }
    });
  });

  describe("POST /dashboard/login", () => {
    beforeEach(() => {
      fakeSessions.clear();
    });

    test("correct email and password: session cookie and 302 to /dashboard", async () => {
      infoLog.mockClear();
      const response = await postLogin(
        { email: " Owner@Example.com ", password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.1", "user-agent": "e2e-agent" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      expect(response.headers.get("cache-control")).toBe("no-store");

      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/dashboard");
      expect(setCookie).toContain("Max-Age=604800");
      expect(setCookie).not.toContain("Secure");
      const token = cookieValue(response) ?? "";
      expect(fakeSessions.has(token)).toBe(true);

      /** The email is normalized before the check; the session gets the client data. */
      expect(verifyPasswordLogin).toHaveBeenLastCalledWith(
        "owner@example.com",
        ACCOUNT.password,
      );
      expect(createSession).toHaveBeenLastCalledWith({
        userId: OWNER.userId,
        assurance: "password",
        authMethod: "password",
        credentialId: "crd_owner",
        ip: "198.51.100.1",
        userAgent: "e2e-agent",
      });

      /** The success log carries ids, never the token. */
      const call = infoLog.mock.calls.find(([m]) => m === "Dashboard login successful");
      expect(call?.[1]).toEqual({
        userId: OWNER.userId,
        sessionId: expect.stringMatching(/^ses_/),
        ip: "198.51.100.1",
      });
      expect(JSON.stringify(infoLog.mock.calls)).not.toContain(token);
    });

    test("two logins get distinct cookies (fresh token each time)", async () => {
      const first = cookieValue(
        await postLogin({ email: ACCOUNT.email, password: ACCOUNT.password }),
      );
      const second = cookieValue(
        await postLogin({ email: ACCOUNT.email, password: ACCOUNT.password }),
      );
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first).not.toBe(second);
    });

    test("sets the bm_device cookie and starts the new-device check (#282)", async () => {
      recognizeSignInDevice.mockClear();
      const response = await postLogin(
        { email: " Owner@Example.com ", password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.4", "user-agent": "e2e-agent" },
      );
      expect(response.status).toBe(302);
      const cookies = response.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      expect(cookies[0]).toStartWith("bm_session=");
      const device = cookies[1] ?? "";
      expect(device).toMatch(
        /^bm_device=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Lax; Path=\/dashboard; Max-Age=34560000$/,
      );
      const value = device.match(/^bm_device=([^;]+)/)?.[1];
      /** A device id, not the session token. */
      expect(value).not.toBe(cookieValue(response));

      expect(recognizeSignInDevice).toHaveBeenCalledTimes(1);
      expect(recognizeSignInDevice.mock.calls[0]?.[0]).toMatchObject({
        userId: OWNER.userId,
        email: "owner@example.com",
        deviceToken: value,
        ip: "198.51.100.4",
        userAgent: "e2e-agent",
      });
    });

    test("keeps a well-formed device cookie; a malformed or oversized one is replaced", async () => {
      const kept = "D".repeat(43);
      for (const [presented, keep] of [
        [kept, true],
        ["not-a-device-id", false],
        ["A".repeat(44), false],
        ["A".repeat(4096), false],
      ] as const) {
        recognizeSignInDevice.mockClear();
        const response = await postLogin(
          { email: ACCOUNT.email, password: ACCOUNT.password },
          { cookie: `bm_device=${presented}`, "x-forwarded-for": "198.51.100.5" },
        );
        const value = response.headers
          .getSetCookie()
          .find((c) => c.startsWith("bm_device="))
          ?.match(/^bm_device=([^;]+)/)?.[1];
        expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
        if (keep) expect(value).toBe(presented);
        else expect(value).not.toBe(presented);
        expect(recognizeSignInDevice.mock.calls[0]?.[0].deviceToken).toBe(value);
      }
    });

    test("a failed login sets no device cookie and runs no device check", async () => {
      recognizeSignInDevice.mockClear();
      const response = await postLogin(
        { email: ACCOUNT.email, password: "not the password" },
        { "x-forwarded-for": "198.51.100.6" },
      );
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(recognizeSignInDevice).not.toHaveBeenCalled();
    });

    test("an unknown email and a wrong password get identical responses", async () => {
      warnLog.mockClear();
      const unknown = await postLogin(
        { email: "nobody@example.com", password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.2" },
      );
      const wrong = await postLogin(
        { email: ACCOUNT.email, password: "not the password" },
        { "x-forwarded-for": "198.51.100.3" },
      );
      for (const response of [unknown, wrong]) {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(await unknown.text()).toBe(await wrong.text());

      /** The reason reaches the server log only. */
      expect(warnLog).toHaveBeenCalledWith(
        "Dashboard login failed",
        expect.objectContaining({ reason: "unknown", email: "nobody@example.com" }),
      );
      expect(warnLog).toHaveBeenCalledWith(
        "Dashboard login failed",
        expect.objectContaining({ reason: "bad_password" }),
      );
    });

    test("over-long input fails the same way without reaching the password check", async () => {
      const calls = verifyPasswordLogin.mock.calls.length;
      const longPassword = await postLogin(
        { email: ACCOUNT.email, password: "p".repeat(257) },
        { "x-forwarded-for": "198.51.100.4" },
      );
      const longEmail = await postLogin(
        { email: `${"a".repeat(250)}@example.com`, password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.4" },
      );
      for (const response of [longPassword, longEmail]) {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
      }
      expect(verifyPasswordLogin.mock.calls.length).toBe(calls);
    });

    test("a cross-origin or origin-less login is 403 before any work", async () => {
      const calls = verifyPasswordLogin.mock.calls.length;
      const evil = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { origin: "http://evil.example" },
      );
      expect(evil.status).toBe(403);
      expect(evil.headers.get("set-cookie")).toBeNull();

      const none = await app.handle(
        new Request("http://localhost/dashboard/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            email: ACCOUNT.email,
            password: ACCOUNT.password,
          }).toString(),
        }),
      );
      expect(none.status).toBe(403);
      expect(verifyPasswordLogin.mock.calls.length).toBe(calls);
      expect(warnLog).toHaveBeenCalledWith(
        "Dashboard login POST rejected: cross-origin (possible CSRF)",
        expect.objectContaining({ origin: "http://evil.example" }),
      );
    });

    test("a session the browser already holds is revoked before the new one opens", async () => {
      const old = seedSession();
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { cookie: `bm_session=${old}` },
      );
      expect(response.status).toBe(302);
      expect(revokeSessionByToken).toHaveBeenLastCalledWith(old);
      expect(fakeSessions.has(old)).toBe(false);
      expect(fakeSessions.has(cookieValue(response) ?? "")).toBe(true);
    });

    test("a legacy cookie on login is not looked up, just replaced", async () => {
      const calls = revokeSessionByToken.mock.calls.length;
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { cookie: `bm_session=1700000000.${"a".repeat(64)}` },
      );
      expect(response.status).toBe(302);
      expect(revokeSessionByToken.mock.calls.length).toBe(calls);
    });

    test("a session store error is a 503 page, not a 500", async () => {
      createSession.mockImplementationOnce(() => Promise.reject(new Error("db down")));
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.5" },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("Dashboard temporarily unavailable");
      expect(errorLog).toHaveBeenCalledWith(
        "Dashboard login failed: session store error",
        expect.objectContaining({ error: "db down" }),
      );
    });

    test("a credential replaced between the check and the session (#277) is a failed login", async () => {
      createSession.mockImplementationOnce(() =>
        Promise.reject(new UserStoreError("23503")),
      );
      warnLog.mockClear();
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { "x-forwarded-for": "198.51.100.6" },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login?error=invalid");
      expect(response.headers.get("set-cookie")).toBeNull();
      const failed = warnLog.mock.calls.find(([m]) => m === "Dashboard login failed");
      expect(failed?.[1]).toMatchObject({ reason: "credential_replaced" });
    });
  });

  describe("POST /dashboard/login brute-force protection (#109)", () => {
    /** Each test uses a distinct X-Forwarded-For so the module-level
     *  attempt map doesn't bleed across cases. */
    const wrongLogin = (ip: string): Promise<Response> =>
      postLogin(
        { email: ACCOUNT.email, password: "wrongpassword" },
        { "x-forwarded-for": ip },
      );

    test("blocks with 429 + Retry-After after 5 failed attempts from one IP", async () => {
      const ip = "9.9.9.9";
      /** First 5 wrong attempts redirect with the generic error. */
      for (let i = 0; i < 5; i++) {
        const res = await wrongLogin(ip);
        expect(res.status).toBe(302);
      }
      /** The 6th is locked out, before the password check. */
      const calls = verifyPasswordLogin.mock.calls.length;
      const blocked = await wrongLogin(ip);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).toBeTruthy();
      expect(verifyPasswordLogin.mock.calls.length).toBe(calls);
      const html = await blocked.text();
      expect(html).toContain("Too many failed attempts");
      /** The lockout response disables the form (standalone `disabled`
       *  attribute, distinct from the `disabled:` Tailwind classes). */
      expect(/disabled(?![:\w-])/.test(html)).toBe(true);
    });

    test("a parallel burst cannot outrun the limit (attempt counted before the password check)", async () => {
      const ip = "9.9.9.14";
      const calls = verifyPasswordLogin.mock.calls.length;
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => wrongLogin(ip)),
      );
      const blocked = responses.filter((r) => r.status === 429).length;
      expect(verifyPasswordLogin.mock.calls.length - calls).toBeLessThanOrEqual(5);
      expect(blocked).toBeGreaterThanOrEqual(5);
    });

    test("every failure kind counts: unknown emails lock the IP out too", async () => {
      const ip = "9.9.9.13";
      for (let i = 0; i < 5; i++) {
        await postLogin(
          { email: `nobody${i}@example.com`, password: "x" },
          { "x-forwarded-for": ip },
        );
      }
      expect((await wrongLogin(ip)).status).toBe(429);
    });

    test("lockout is per-IP: a different IP is unaffected", async () => {
      const attacker = "9.9.9.10";
      for (let i = 0; i < 6; i++) await wrongLogin(attacker);

      /** A wrong password from a fresh IP still gets the normal redirect,
       *  not a 429. */
      const other = await wrongLogin("9.9.9.11");
      expect(other.status).toBe(302);
      expect(other.headers.get("location")).toBe("/dashboard/login?error=invalid");
    });

    test("a successful login clears the IP's failure counter", async () => {
      const ip = "9.9.9.12";
      /** Burn 4 failures (still under the limit of 5). */
      for (let i = 0; i < 4; i++) await wrongLogin(ip);

      /** The right password from the same IP succeeds and resets the counter. */
      const ok = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { "x-forwarded-for": ip },
      );
      expect(ok.status).toBe(302);
      expect(ok.headers.get("location")).toBe("/dashboard");

      /** With the counter cleared, 5 fresh failures are needed again, so a
       *  single wrong attempt still just redirects. */
      const after = await wrongLogin(ip);
      expect(after.status).toBe(302);
      expect(after.headers.get("location")).toBe("/dashboard/login?error=invalid");
    });
  });

  describe("Protected routes without a usable session", () => {
    test("GET /dashboard redirects to login", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });

    test("GET /dashboard/emails redirects to login", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/emails"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });

    test("a legacy <ts>.<hmac> cookie is cleared with no lookup", async () => {
      const calls = findActiveSession.mock.calls.length;
      const response = await getWithSession(
        "/dashboard",
        `${Math.floor(Date.now() / 1000)}.${"a".repeat(64)}`,
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(cookieValue(response)).toBe("");
      expect(findActiveSession.mock.calls.length).toBe(calls);
    });

    test("an unknown well-formed token is looked up, then cleared", async () => {
      const response = await getWithSession("/dashboard", fakeToken());
      expect(response.status).toBe(302);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    });

    test("a pending (second factor outstanding) session is rejected", async () => {
      const token = seedSession({ assurance: "pending" });
      const response = await getWithSession("/dashboard", token);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });

    test("a session lookup error is a 503, never a pass-through or a logout", async () => {
      const token = seedSession();
      findActiveSession.mockImplementationOnce(() =>
        Promise.reject(new Error("User store query failed (SQLSTATE 57P01)")),
      );
      const response = await getWithSession("/dashboard", token);
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toBe("Dashboard temporarily unavailable");
      expect(errorLog).toHaveBeenCalledWith(
        "Dashboard session lookup failed",
        expect.objectContaining({ error: "User store query failed (SQLSTATE 57P01)" }),
      );
      /** The session itself is untouched: the next request works. */
      expect((await getWithSession("/dashboard", token)).status).toBe(200);
    });
  });

  describe("Session rotation and reuse detection (#216)", () => {
    /**
     * A thief who keeps a stolen session active rotates it every minute,
     * so the victim's copy falls two or more generations behind. The
     * history table still recognizes it: every session of the user ends.
     */
    test("a token two or more rotations old is reuse: every session of the user is revoked", async () => {
      const stale = fakeToken();
      const thief = seedSession({ history: [stale, fakeToken()] });
      const otherDevice = seedSession();
      const revokes = revokeAllUserSessions.mock.calls.length;

      const response = await getWithSession("/dashboard", stale);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(revokeAllUserSessions.mock.calls.length).toBe(revokes + 1);
      expect(fakeSessions.has(thief)).toBe(false);
      expect(fakeSessions.has(otherDevice)).toBe(false);
    });

    test("signing in again with a superseded cookie also ends the thief's session", async () => {
      const stale = fakeToken();
      const thief = seedSession({ history: [stale] });
      const response = await postLogin(
        { email: ACCOUNT.email, password: ACCOUNT.password },
        { "x-forwarded-for": "9.9.8.1", cookie: `bm_session=${stale}` },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      expect(fakeSessions.has(thief)).toBe(false);
    });

    test("logging out with a superseded cookie also ends the thief's session", async () => {
      const stale = fakeToken();
      const thief = seedSession({ history: [stale] });
      const response = await app.handle(
        new Request("http://localhost/dashboard/logout", {
          method: "POST",
          headers: { origin: "http://localhost", cookie: `bm_session=${stale}` },
        }),
      );
      expect(response.status).toBe(302);
      expect(fakeSessions.has(thief)).toBe(false);
    });

    test("an unknown well-formed token is rejected without revoking anything", async () => {
      const bystander = seedSession();
      const revokes = revokeAllUserSessions.mock.calls.length;
      const response = await getWithSession("/dashboard", fakeToken());
      expect(response.status).toBe(302);
      expect(revokeAllUserSessions.mock.calls.length).toBe(revokes);
      expect(fakeSessions.has(bystander)).toBe(true);
    });

    test("a due rotation sends a new cookie that then works", async () => {
      const token = seedSession({ rotationDue: true });
      const response = await getWithSession("/dashboard", token);
      expect(response.status).toBe(200);
      const fresh = cookieValue(response) ?? "";
      expect(fresh).not.toBe(token);
      expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=3600");
      expect(response.headers.get("set-cookie")).toContain("HttpOnly");

      const next = await getWithSession("/dashboard", fresh);
      expect(next.status).toBe(200);
      expect(next.headers.get("set-cookie")).toBeNull();
    });

    test("no rotation due: served without a new cookie and without a write", async () => {
      const calls = rotateSession.mock.calls.length;
      const response = await getWithSession("/dashboard", seedSession());
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(rotateSession.mock.calls.length).toBe(calls);
    });

    test("the previous token inside the grace period is served, no cookie, no write", async () => {
      const token = seedSession({ rotationDue: true });
      await getWithSession("/dashboard", token);
      const calls = rotateSession.mock.calls.length;

      const late = await getWithSession("/dashboard", token);
      expect(late.status).toBe(200);
      expect(late.headers.get("set-cookie")).toBeNull();
      expect(rotateSession.mock.calls.length).toBe(calls);
    });

    test("a lost rotation race is served without a new cookie", async () => {
      rotateSession.mockImplementationOnce(() => Promise.resolve(null));
      const response = await getWithSession(
        "/dashboard",
        seedSession({ rotationDue: true }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
    });

    test("a rotation error is logged and the request still served", async () => {
      rotateSession.mockImplementationOnce(() => Promise.reject(new Error("db hiccup")));
      const response = await getWithSession(
        "/dashboard",
        seedSession({ rotationDue: true }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(errorLog).toHaveBeenCalledWith(
        "Dashboard session rotation failed",
        expect.objectContaining({ error: "db hiccup" }),
      );
    });

    test("the previous token after the grace period revokes every session of the user", async () => {
      warnLog.mockClear();
      const stolen = seedSession({ rotationDue: true, userId: "usr_victim" });
      const rotated = await getWithSession("/dashboard", stolen);
      const fresh = cookieValue(rotated) ?? "";
      const otherDevice = seedSession({ userId: "usr_victim" });
      const bystander = seedSession({ userId: "usr_someone_else" });

      /** The grace period runs out. */
      const session = fakeSessions.get(fresh);
      if (session) session.graceOver = true;

      const reuse = await app.handle(
        new Request("http://localhost/dashboard", {
          headers: { cookie: `bm_session=${stolen}`, "x-forwarded-for": "203.0.113.9" },
        }),
      );
      expect(reuse.status).toBe(302);
      expect(reuse.headers.get("location")).toBe("/dashboard/login");
      expect(reuse.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(revokeAllUserSessions).toHaveBeenLastCalledWith("usr_victim");
      expect(warnLog).toHaveBeenCalledWith(
        "Session token reuse detected: all sessions of the user revoked",
        {
          userId: "usr_victim",
          sessionId: expect.stringMatching(/^ses_/),
          ip: "203.0.113.9",
        },
      );

      /** Both of the victim's sessions are gone, the other user's stays. */
      expect((await getWithSession("/dashboard", fresh)).status).toBe(302);
      expect((await getWithSession("/dashboard", otherDevice)).status).toBe(302);
      expect((await getWithSession("/dashboard", bystander)).status).toBe(200);
    });

    test("a failed revoke on reuse is a 503, never a pass-through", async () => {
      const stolen = seedSession({ rotationDue: true });
      const fresh = cookieValue(await getWithSession("/dashboard", stolen)) ?? "";
      const session = fakeSessions.get(fresh);
      if (session) session.graceOver = true;

      revokeAllUserSessions.mockImplementationOnce(() =>
        Promise.reject(new Error("down")),
      );
      const response = await getWithSession("/dashboard", stolen);
      expect(response.status).toBe(503);
    });

    test("a cross-origin POST is refused before any rotation", async () => {
      const calls = rotateSession.mock.calls.length;
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: `bm_session=${seedSession({ rotationDue: true })}`,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://evil.example",
          },
          body: "name=CsrfKey",
        }),
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(rotateSession.mock.calls.length).toBe(calls);
    });
  });

  describe("POST /dashboard/logout", () => {
    /** Form-POSTs to /dashboard/logout; same-origin unless overridden. */
    const postLogout = (headers: Record<string, string>): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/logout", {
          method: "POST",
          headers: { origin: "http://localhost", ...headers },
        }),
      );

    test("revokes the session, clears the cookie, and the replayed cookie is dead", async () => {
      const token = seedSession();
      expect((await getWithSession("/dashboard", token)).status).toBe(200);

      const response = await postLogout({ cookie: `bm_session=${token}` });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("Max-Age=0");
      expect(setCookie).toContain("Path=/dashboard");
      expect(revokeSessionByToken).toHaveBeenLastCalledWith(token);

      const replay = await getWithSession("/dashboard", token);
      expect(replay.status).toBe(302);
      expect(replay.headers.get("location")).toBe("/dashboard/login");
    });

    test("without a cookie, or with a legacy one, it still clears and redirects", async () => {
      const calls = revokeSessionByToken.mock.calls.length;
      const cases: Record<string, string>[] = [
        {},
        { cookie: `bm_session=1700000000.${"a".repeat(64)}` },
      ];
      for (const headers of cases) {
        const response = await postLogout(headers);
        expect(response.status).toBe(302);
        expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      }
      expect(revokeSessionByToken.mock.calls.length).toBe(calls);
    });

    test("a revoke error is logged and the cookie still cleared", async () => {
      revokeSessionByToken.mockImplementationOnce(() =>
        Promise.reject(new Error("down")),
      );
      const response = await postLogout({ cookie: `bm_session=${seedSession()}` });
      expect(response.status).toBe(302);
      expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
      expect(errorLog).toHaveBeenCalledWith(
        "Dashboard logout: session revoke failed",
        expect.objectContaining({ error: "down" }),
      );
    });

    test("a cross-origin logout is 403 and the session survives", async () => {
      const token = seedSession();
      const evil = await postLogout({
        cookie: `bm_session=${token}`,
        origin: "http://evil.example",
      });
      expect(evil.status).toBe(403);
      expect(evil.headers.get("set-cookie")).toBeNull();
      expect((await getWithSession("/dashboard", token)).status).toBe(200);
    });
  });
});
