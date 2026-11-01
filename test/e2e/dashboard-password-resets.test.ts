import { describe, test, expect, beforeEach } from "bun:test";
import {
  OWNER,
  RACED_RESET_TOKEN,
  RESET_TARGET,
  RESET_TOKEN,
  RESET_URL,
  app,
  completePasswordReset,
  cookieValue,
  errorLog,
  fakeSessions,
  findLivePasswordReset,
  getWithSession,
  issuePasswordReset,
  seedSession,
  setResetIssueResult,
  useDashboardMocks,
  warnLog,
  UNKNOWN_TOKEN,
} from "./dashboard-setup.ts";

/** Dashboard E2E: password resets. Setup, fakes and helpers: `dashboard-setup.ts` (#291). */
useDashboardMocks();

describe("Dashboard E2E: password resets", () => {
  describe("Password resets (#277)", () => {
    const NEW_PASSWORD = "a brand new passphrase, long";

    /** Form-POSTs to /dashboard/reset; same-origin unless overridden. */
    const postReset = (
      fields: Record<string, string>,
      headers: Record<string, string> = { origin: "http://localhost" },
    ): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/reset", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    /** Same-origin form POST with a session cookie. */
    const postWithSession = (path: string, token: string): Promise<Response> =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            cookie: `bm_session=${token}`,
            origin: "http://localhost",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "",
        }),
      );

    beforeEach(() => {
      fakeSessions.clear();
      issuePasswordReset.mockClear();
      completePasswordReset.mockClear();
      setResetIssueResult({
        ok: true,
        resetId: RESET_TARGET.resetId,
        url: RESET_URL,
        usedFallback: false,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    });

    test("GET with a live token renders the form with the auth-page headers (public)", async () => {
      const response = await app.handle(
        new Request(`http://localhost/dashboard/reset?token=${RESET_TOKEN}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const html = await response.text();
      expect(html).toContain('action="/dashboard/reset"');
      expect(html).toContain(`name="token" value="${RESET_TOKEN}"`);
      expect(html).toContain("&lt;i&gt;a&lt;/i&gt;@example.com");
      expect(html).not.toContain("<i>a</i>");
    });

    test("GET without, with a malformed or with an unknown token: identical 400s", async () => {
      const calls = findLivePasswordReset.mock.calls.length;
      const missing = await app.handle(new Request("http://localhost/dashboard/reset"));
      const malformed = await app.handle(
        new Request("http://localhost/dashboard/reset?token=not-a-token"),
      );
      expect(findLivePasswordReset.mock.calls.length).toBe(calls);
      const unknown = await app.handle(
        new Request(`http://localhost/dashboard/reset?token=${UNKNOWN_TOKEN}`),
      );
      const bodies: string[] = [];
      for (const response of [missing, malformed, unknown]) {
        expect(response.status).toBe(400);
        bodies.push(await response.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toContain("This password reset link is not valid");
    });

    test("POST cross-origin is refused before any lookup", async () => {
      const calls = findLivePasswordReset.mock.calls.length;
      const response = await postReset(
        { token: RESET_TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
        { origin: "https://evil.example.com" },
      );
      expect(response.status).toBe(403);
      expect(findLivePasswordReset.mock.calls.length).toBe(calls);
    });

    test("POST with a policy problem re-renders the form and never completes", async () => {
      const short = await postReset({
        token: RESET_TOKEN,
        password: "short",
        confirm: "short",
      });
      expect(short.status).toBe(200);
      expect(await short.text()).toContain("at least 15 characters");
      const mismatch = await postReset({
        token: RESET_TOKEN,
        password: NEW_PASSWORD,
        confirm: `${NEW_PASSWORD}!`,
      });
      expect(mismatch.status).toBe(200);
      expect(await mismatch.text()).toContain("do not match");
      expect(completePasswordReset).not.toHaveBeenCalled();
    });

    test("POST success: new session cookie, the presented session revoked, logged without secrets", async () => {
      const old = seedSession();
      warnLog.mockClear();
      const response = await postReset(
        { token: RESET_TOKEN, password: NEW_PASSWORD, confirm: NEW_PASSWORD },
        { origin: "http://localhost", cookie: `bm_session=${old}` },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const token = cookieValue(response) ?? "";
      expect(fakeSessions.has(token)).toBe(true);
      expect(fakeSessions.has(old)).toBe(false);
      expect(completePasswordReset).toHaveBeenLastCalledWith(RESET_TOKEN, NEW_PASSWORD, {
        ip: "unknown",
        userAgent: null,
      });
      const done = warnLog.mock.calls.find(([m]) => m === "Password reset completed");
      expect(done?.[1]).toMatchObject({
        resetId: RESET_TARGET.resetId,
        userId: RESET_TARGET.userId,
        issuedBy: OWNER.userId,
        sessionsRevoked: 2,
      });
      expect(JSON.stringify(done)).not.toContain(RESET_TOKEN);
      expect(JSON.stringify(warnLog.mock.calls)).not.toContain(NEW_PASSWORD);
    });

    test("POST whose spend fails gets the same 400 page and no cookie", async () => {
      const response = await postReset({
        token: RACED_RESET_TOKEN,
        password: NEW_PASSWORD,
        confirm: NEW_PASSWORD,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("This password reset link is not valid");
    });

    test("the owner sees Reset password for an active admin, not for a disabled member", async () => {
      const html = await (await getWithSession("/dashboard/users", seedSession())).text();
      expect(html).toContain('action="/dashboard/users/usr_admin/reset-password"');
      expect(html).not.toContain("/dashboard/users/usr_member/reset-password");
      expect(html).not.toContain(`/dashboard/users/${OWNER.userId}/reset-password`);
    });

    test("issuing reveals the link once, to the issuing session only, never in the URL", async () => {
      const owner = seedSession();
      const response = await postWithSession(
        "/dashboard/users/usr_admin/reset-password",
        owner,
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toContain("reveal=");
      expect(location).not.toContain(RESET_TOKEN);
      expect(decodeURIComponent(location)).toContain("Password reset link created");
      expect(issuePasswordReset).toHaveBeenCalledWith(
        OWNER.userId,
        "usr_admin",
        expect.objectContaining({ ip: expect.any(String) }),
      );

      /** Another session of the same user cannot redeem it, nor destroy it. */
      const other = await (await getWithSession(location, seedSession())).text();
      expect(other).not.toContain(RESET_TOKEN);

      const first = await getWithSession(location, owner);
      expect(first.headers.get("cache-control")).toBe("no-store");
      expect(await first.text()).toContain(RESET_URL);
      const second = await (await getWithSession(location, owner)).text();
      expect(second).not.toContain(RESET_TOKEN);
    });

    test("a localhost link says so in the flash", async () => {
      setResetIssueResult({
        ok: true,
        resetId: RESET_TARGET.resetId,
        url: `http://localhost:3000/dashboard/reset?token=${RESET_TOKEN}`,
        usedFallback: true,
        expiresAt: new Date(),
      });
      const response = await postWithSession(
        "/dashboard/users/usr_admin/reset-password",
        seedSession(),
      );
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "APP_BASE_URL is not set",
      );
    });

    test("a member gets 403 and the service is never called", async () => {
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await postWithSession(
        "/dashboard/users/usr_x/reset-password",
        member,
      );
      expect(response.status).toBe(403);
      expect(issuePasswordReset).not.toHaveBeenCalled();
    });

    test("refusals: a crafted target gets the 403 page, a disabled account an error flash", async () => {
      setResetIssueResult({ ok: false, reason: "target_is_owner" });
      const admin = seedSession({ userId: "usr_admin", role: "admin" });
      const forbidden = await postWithSession(
        `/dashboard/users/${OWNER.userId}/reset-password`,
        admin,
      );
      expect(forbidden.status).toBe(403);

      setResetIssueResult({ ok: false, reason: "account_disabled" });
      const disabled = await postWithSession(
        "/dashboard/users/usr_member/reset-password",
        seedSession(),
      );
      expect(disabled.status).toBe(302);
      const location = decodeURIComponent(disabled.headers.get("location") ?? "");
      expect(location).toContain("Reactivate the account before resetting its password.");
      expect(location).toContain("flashType=error");
      expect(location).not.toContain("reveal=");
    });

    test("an issue failure is logged and answered with an error flash", async () => {
      issuePasswordReset.mockImplementationOnce(() =>
        Promise.reject(new Error("User store query failed")),
      );
      errorLog.mockClear();
      const response = await postWithSession(
        "/dashboard/users/usr_admin/reset-password",
        seedSession(),
      );
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Failed to create the password reset link.",
      );
      expect(
        errorLog.mock.calls.some(
          ([m]) => m === "Failed to issue a password reset link via dashboard",
        ),
      ).toBe(true);
    });
  });
});
