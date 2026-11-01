import { describe, test, expect, beforeEach } from "bun:test";
import {
  INVITE_TOKEN,
  INVITE_URL,
  TAKEN_INVITE_TOKEN,
  acceptInvitation,
  app,
  cookieValue,
  fakeSessions,
  findLiveInvitation,
  getWithSession,
  seedSession,
  setIssueResult,
  useDashboardMocks,
  warnLog,
  UNKNOWN_TOKEN,
} from "./dashboard-setup.ts";

/** Dashboard E2E: invitations. Setup, fakes and helpers: `dashboard-setup.ts` (#291). */
useDashboardMocks();

describe("Dashboard E2E: invitations", () => {
  describe("Invitations (#217)", () => {
    const GOOD_PASSWORD = "correct horse battery staple";

    /** Form-POSTs to /dashboard/invite; same-origin unless overridden. */
    const postInvite = (
      fields: Record<string, string>,
      headers: Record<string, string> = { origin: "http://localhost" },
    ): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/invite", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    /** Same-origin form POST with a session cookie. */
    const postWithSession = (
      path: string,
      token: string,
      fields: Record<string, string>,
    ): Promise<Response> =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
            cookie: `bm_session=${token}`,
          },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    beforeEach(() => {
      fakeSessions.clear();
    });

    test("GET with a live token renders the form with the auth-page headers (public)", async () => {
      const response = await app.handle(
        new Request(`http://localhost/dashboard/invite?token=${INVITE_TOKEN}`),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      const html = await response.text();
      expect(html).toContain('action="/dashboard/invite"');
      expect(html).toContain(`name="token" value="${INVITE_TOKEN}"`);
      expect(html).toContain("new@example.com");
      expect(html).toContain('name="name"');
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
    });

    test("GET without, with a malformed or with an unknown token: identical 400s", async () => {
      const calls = findLiveInvitation.mock.calls.length;
      const missing = await app.handle(new Request("http://localhost/dashboard/invite"));
      const malformed = await app.handle(
        new Request("http://localhost/dashboard/invite?token=not-a-token"),
      );
      expect(findLiveInvitation.mock.calls.length).toBe(calls);
      const unknown = await app.handle(
        new Request(`http://localhost/dashboard/invite?token=${UNKNOWN_TOKEN}`),
      );
      const bodies: string[] = [];
      for (const response of [missing, malformed, unknown]) {
        expect(response.status).toBe(400);
        bodies.push(await response.text());
      }
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toContain("This invitation link is not valid");
    });

    test("POST cross-origin is refused before any lookup", async () => {
      const calls = findLiveInvitation.mock.calls.length;
      const response = await postInvite(
        {
          token: INVITE_TOKEN,
          name: "Ann",
          password: GOOD_PASSWORD,
          confirm: GOOD_PASSWORD,
        },
        { origin: "https://evil.example.com" },
      );
      expect(response.status).toBe(403);
      expect(findLiveInvitation.mock.calls.length).toBe(calls);
    });

    test("POST with a policy problem re-renders the form and never accepts", async () => {
      const calls = acceptInvitation.mock.calls.length;
      const short = await postInvite({
        token: INVITE_TOKEN,
        name: "Ann",
        password: "short",
        confirm: "short",
      });
      expect(short.status).toBe(200);
      expect(await short.text()).toContain("at least 15 characters");
      const noName = await postInvite({
        token: INVITE_TOKEN,
        name: "   ",
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(noName.status).toBe(200);
      expect(await noName.text()).toContain("Enter your name.");
      expect(acceptInvitation.mock.calls.length).toBe(calls);
    });

    test("POST success: new session cookie, the presented session revoked, 302 to /dashboard", async () => {
      const old = seedSession();
      warnLog.mockClear();
      const response = await postInvite(
        {
          token: INVITE_TOKEN,
          name: "  Ann  ",
          password: GOOD_PASSWORD,
          confirm: GOOD_PASSWORD,
        },
        { origin: "http://localhost", cookie: `bm_session=${old}` },
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const token = cookieValue(response) ?? "";
      expect(fakeSessions.has(token)).toBe(true);
      expect(fakeSessions.has(old)).toBe(false);
      expect(acceptInvitation).toHaveBeenLastCalledWith(
        INVITE_TOKEN,
        { name: "Ann", password: GOOD_PASSWORD },
        { ip: "unknown", userAgent: null },
      );
      const accepted = warnLog.mock.calls.find(([m]) => m === "Invitation accepted");
      expect(accepted?.[1]).toMatchObject({ userId: "usr_new", role: "admin" });
      expect(JSON.stringify(accepted)).not.toContain(INVITE_TOKEN);
    });

    test("POST when the address got an account meanwhile: 409, no cookie", async () => {
      const response = await postInvite({
        token: TAKEN_INVITE_TOKEN,
        name: "Ann",
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(response.status).toBe(409);
      expect(cookieValue(response)).toBeNull();
      expect(await response.text()).toContain("An account already exists");
    });

    test("the Invitations page escapes stored values; a member gets 403", async () => {
      const owner = seedSession();
      const page = await getWithSession("/dashboard/invitations", owner);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("&lt;img src=x&gt;@example.com");
      expect(html).toContain("&lt;b&gt;Ann&lt;/b&gt;");
      expect(html).not.toContain("<img src=x>");
      /** The owner may grant both roles. */
      expect(html).toContain('<option value="admin">');

      const member = seedSession({ role: "member" });
      const denied = await getWithSession("/dashboard/invitations", member);
      expect(denied.status).toBe(403);
    });

    test.each(["/dashboard/invitations", "/dashboard/api-keys", "/dashboard/webhooks"])(
      "%s (can reveal a one-time secret) is sent with Cache-Control: no-store",
      async (path) => {
        const owner = seedSession();
        const response = await getWithSession(path, owner);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
      },
    );

    test("a higher-role pending invitation is an error flash, not a 403", async () => {
      setIssueResult({ ok: false, reason: "pending_higher_role" });
      const admin = seedSession({ role: "admin" });
      const response = await postWithSession("/dashboard/invitations", admin, {
        email: "new@example.com",
        role: "member",
      });
      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.get("location") ?? "");
      expect(location).toContain("A pending invitation from a higher role exists");
      expect(location).toContain("flashType=error");
    });

    test("an admin's role select offers member only", async () => {
      const admin = seedSession({ role: "admin" });
      const html = await (await getWithSession("/dashboard/invitations", admin)).text();
      expect(html).toContain('<option value="member">');
      expect(html).not.toContain('<option value="admin">');
    });

    test("email not sent: the link is revealed once, never in the redirect URL", async () => {
      setIssueResult({
        ok: true,
        invitation: {
          invitationId: "utk_new",
          token: INVITE_TOKEN,
          email: "new@example.com",
          role: "member",
          expiresAt: new Date(),
          replaced: 0,
        },
        url: INVITE_URL,
        delivery: { sent: false, reason: "not_configured" },
      });
      const owner = seedSession();
      const response = await postWithSession("/dashboard/invitations", owner, {
        email: "new@example.com",
        role: "member",
      });
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).not.toContain(INVITE_TOKEN);
      expect(decodeURIComponent(location)).toContain("no system sender is configured");
      const reveal = new URL(location, "http://localhost").searchParams.get("reveal");
      expect(reveal).toBeTruthy();

      const first = await (await getWithSession(location, owner)).text();
      expect(first).toContain(INVITE_URL);
      const second = await (await getWithSession(location, owner)).text();
      expect(second).not.toContain(INVITE_URL);
    });

    test("email sent: a plain success flash and no reveal", async () => {
      setIssueResult({
        ok: true,
        invitation: {
          invitationId: "utk_new",
          token: INVITE_TOKEN,
          email: "new@example.com",
          role: "member",
          expiresAt: new Date(),
          replaced: 0,
        },
        url: INVITE_URL,
        delivery: { sent: true },
      });
      const owner = seedSession();
      const response = await postWithSession("/dashboard/invitations", owner, {
        email: "new@example.com",
        role: "member",
      });
      const location = response.headers.get("location") ?? "";
      expect(decodeURIComponent(location)).toContain("Invitation sent by email.");
      expect(location).not.toContain("reveal=");
    });

    test("a role the actor cannot grant gets the 403 page", async () => {
      setIssueResult({ ok: false, reason: "role_not_allowed" });
      const admin = seedSession({ role: "admin" });
      const response = await postWithSession("/dashboard/invitations", admin, {
        email: "new@example.com",
        role: "owner",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("cannot grant");
    });
  });
});
