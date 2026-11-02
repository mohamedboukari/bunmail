import { describe, test, expect, beforeEach } from "bun:test";
import {
  OWNER,
  accountAction,
  app,
  getWithSession,
  seedSession,
  setAccountResult,
  useDashboardMocks,
} from "./dashboard-setup.ts";

/** Dashboard E2E: users. Setup, fakes and helpers: `dashboard-setup.ts` (#291). */
useDashboardMocks();

describe("Dashboard E2E: users", () => {
  describe("Users (#218)", () => {
    /** Same-origin form POST with a session cookie. */
    const postWithSession = (
      path: string,
      token: string,
      fields: Record<string, string> = {},
    ): Promise<Response> =>
      app.handle(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: {
            cookie: `bm_session=${token}`,
            origin: "http://localhost",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    beforeEach(() => {
      setAccountResult({ ok: true });
      accountAction.mockClear();
    });

    test("the owner sees every account, escaped, with the actions it may take", async () => {
      const response = await getWithSession("/dashboard/users", seedSession());
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("&lt;b&gt;Ada&lt;/b&gt;");
      expect(html).toContain("&lt;i&gt;m&lt;/i&gt;@example.com");
      expect(html).not.toContain("<b>Ada</b>");
      expect(html).not.toContain("<i>m</i>");
      expect(html).toContain("(you)");
      /** The admin row: role change, deactivate, transfer, remove. */
      expect(html).toContain('action="/dashboard/users/usr_admin/role"');
      expect(html).toContain('action="/dashboard/users/usr_admin/deactivate"');
      expect(html).toContain('action="/dashboard/users/usr_admin/transfer"');
      expect(html).toContain('action="/dashboard/users/usr_admin/remove"');
      /** The disabled member: reactivate, not deactivate. */
      expect(html).toContain('action="/dashboard/users/usr_member/reactivate"');
      expect(html).not.toContain('action="/dashboard/users/usr_member/deactivate"');
      expect(html).not.toContain('action="/dashboard/users/usr_member/transfer"');
      /** Nothing on the owner's own row. */
      expect(html).not.toContain(`/dashboard/users/${OWNER.userId}/`);
      expect(html).toContain('href="/dashboard/invitations"');
    });

    test("an admin sees member actions only, and no role change", async () => {
      const admin = seedSession({ userId: "usr_admin", role: "admin" });
      const html = await (await getWithSession("/dashboard/users", admin)).text();
      expect(html).not.toContain("/role");
      expect(html).not.toContain("/transfer");
      expect(html).not.toContain('action="/dashboard/users/usr_admin/');
      expect(html).toContain('action="/dashboard/users/usr_member/reactivate"');
      expect(html).toContain('action="/dashboard/users/usr_member/remove"');
    });

    test("a member gets 403 on the page and on every action, and the service is never called", async () => {
      const member = seedSession({ userId: "usr_member", role: "member" });
      expect((await getWithSession("/dashboard/users", member)).status).toBe(403);
      for (const action of ["deactivate", "reactivate", "remove", "role", "transfer"]) {
        const response = await postWithSession(
          `/dashboard/users/usr_x/${action}`,
          member,
          {
            role: "admin",
            confirm: "x",
            password: "x",
          },
        );
        expect(response.status).toBe(403);
      }
      expect(accountAction).not.toHaveBeenCalled();
    });

    test("an applied action redirects with a success flash", async () => {
      const response = await postWithSession(
        "/dashboard/users/usr_admin/role",
        seedSession(),
        {
          role: "member",
        },
      );
      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.get("location") ?? "");
      expect(location).toContain("/dashboard/users?flash=Role changed to member.");
      /** The request's client goes along, for the audit log (#221). */
      expect(accountAction).toHaveBeenCalledWith(
        OWNER.userId,
        "usr_admin",
        "member",
        expect.objectContaining({ ip: expect.any(String) }),
      );
    });

    test("a refusal no button leads to gets the 403 page", async () => {
      setAccountResult({ ok: false, reason: "role_not_allowed" });
      const admin = seedSession({ userId: "usr_admin", role: "admin" });
      const response = await postWithSession("/dashboard/users/usr_x/role", admin, {
        role: "admin",
      });
      expect(response.status).toBe(403);
      expect(await response.text()).toContain("Your role cannot do this");
    });

    test("a wrong transfer password is an error flash and never echoes the password", async () => {
      setAccountResult({ ok: false, reason: "wrong_password" });
      const response = await postWithSession(
        "/dashboard/users/usr_admin/transfer",
        seedSession(),
        { password: "hunter2-not-it" },
      );
      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.get("location") ?? "");
      expect(location).toContain("Wrong password");
      expect(location).toContain("flashType=error");
      expect(location).not.toContain("hunter2");
      const call = accountAction.mock.calls.at(-1);
      expect(call?.slice(0, 3)).toEqual([OWNER.userId, "usr_admin", "hunter2-not-it"]);
      /** The route hands the service the transfer budget (#218). */
      expect(typeof call?.[3]?.take).toBe("function");
    });

    test("an exhausted transfer budget is an error flash", async () => {
      setAccountResult({ ok: false, reason: "rate_limited" });
      const response = await postWithSession(
        "/dashboard/users/usr_admin/transfer",
        seedSession(),
        { password: "x" },
      );
      expect(response.status).toBe(302);
      const location = decodeURIComponent(response.headers.get("location") ?? "");
      expect(location).toContain("Too many failed attempts, try again later.");
      expect(location).toContain("flashType=error");
    });

    test("a removal without the right confirmation is an error flash", async () => {
      setAccountResult({ ok: false, reason: "confirm_mismatch" });
      const response = await postWithSession(
        "/dashboard/users/usr_member/remove",
        seedSession(),
        { confirm: "nope" },
      );
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Type the account's email address exactly",
      );
    });
  });
});
