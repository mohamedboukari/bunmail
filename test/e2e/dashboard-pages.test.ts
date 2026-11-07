import { describe, test, expect, beforeAll } from "bun:test";
import { Elysia } from "elysia";
import {
  ACCOUNT,
  type FakeTemplateChange,
  app,
  cookieValue,
  createApiKey,
  deleteTemplateAs,
  getWithSession,
  listApiKeys,
  pagesPlugin,
  postLogin,
  seedSession,
  updateTemplateAs,
  useDashboardMocks,
  withRequestContext,
} from "./dashboard-setup.ts";

/** Dashboard E2E: pages behind a session. Setup, fakes and helpers: `dashboard-setup.ts` (#291). */
useDashboardMocks();

describe("Dashboard E2E: pages behind a session", () => {
  describe("Protected routes with valid session", () => {
    /** Get a valid session cookie by logging in */
    let sessionCookie: string;

    beforeAll(async () => {
      const loginResponse = await postLogin({
        email: ACCOUNT.email,
        password: ACCOUNT.password,
      });
      sessionCookie = `bm_session=${cookieValue(loginResponse) ?? ""}`;
    });

    test("GET /dashboard returns 200 with stats", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Dashboard");
      expect(html).toContain("42"); /** totalEmails */
    });

    test("GET /dashboard/emails returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/emails", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Emails");
    });

    test("GET /dashboard/api-keys returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("API Keys");
    });

    test("GET /dashboard/domains returns 200", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/domains", {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Domains");
    });

    test("POST /dashboard/api-keys creates key, redirects with a reveal token, NOT the raw key (#132)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            /** Same-origin: passes the CSRF guard (#133). */
            origin: "http://localhost",
          },
          body: "name=TestKey",
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/dashboard/api-keys");
      /** The raw key MUST NOT appear in the URL (leaks to logs/history/Referer). */
      expect(location).not.toContain("rawKey=");
      expect(location).not.toContain("bm_live_");
      /** Only an opaque one-time reveal token rides in the query. */
      expect(location).toMatch(/[?&]reveal=[a-f0-9]{64}\b/);
    });

    describe("dashboard pagination is clamped, never a 500 (#172)", () => {
      /** Renders /dashboard/inbound and checks what reached the service. */
      const expectListedWith = async (qs: string, expected: object): Promise<void> => {
        const inbound =
          await import("../../src/modules/inbound/services/inbound.service.ts");
        const res = await app.handle(
          new Request(`http://localhost/dashboard/inbound?${qs}`, {
            headers: { cookie: sessionCookie },
          }),
        );
        expect(res.status).toBe(200);
        expect(inbound.listInboundEmails).toHaveBeenLastCalledWith(
          expect.objectContaining(expected),
        );
      };

      test("garbage page/limit fall back to defaults", async () => {
        await expectListedWith("page=0&limit=abc", { page: 1, limit: 20 });
        await expectListedWith("page=-1&limit=0", { page: 1, limit: 20 });
      });

      test("huge page/limit are capped", async () => {
        await expectListedWith("page=99999999999999999999&limit=99999999", {
          page: 1_000_000,
          limit: 100,
        });
      });
    });

    describe("POST /dashboard/send header-injection guard (#202)", () => {
      /** Form-encodes a send with one field overridden. */
      const sendForm = (overrides: Record<string, string>): Promise<Response> =>
        app.handle(
          new Request("http://localhost/dashboard/send", {
            method: "POST",
            headers: {
              cookie: sessionCookie,
              "content-type": "application/x-www-form-urlencoded",
              origin: "http://localhost",
            },
            body: new URLSearchParams({
              apiKeyId: "key_test123",
              from: "hello@example.com",
              to: "user@example.com",
              subject: "hi",
              text: "body",
              ...overrides,
            }).toString(),
          }),
        );

      test("a clean payload passes validation and reaches the handler", async () => {
        /** The mocked key list is empty, so the handler redirects: proof
         *  validation didn't reject it. */
        const response = await sendForm({ cc: "a@example.com, b@example.com" });
        expect(response.status).toBe(302);
      });

      for (const field of ["cc", "bcc", "subject", "replyTo"]) {
        test(`rejects CR/LF in ${field} with 422`, async () => {
          const response = await sendForm({
            [field]: "a@example.com\r\nBcc: victim@example.com",
          });
          expect(response.status).toBe(422);
        });
      }

      test("rejects an over-long cc with 422", async () => {
        const response = await sendForm({ cc: "a@example.com,".repeat(200) });
        expect(response.status).toBe(422);
      });
    });

    test("reveal token shows the raw key exactly once, then is spent (#132)", async () => {
      /** Create → capture the reveal token from the redirect. */
      const created = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: "name=RevealKey",
        }),
      );
      const location = created.headers.get("location")!;
      const token = location.match(/[?&]reveal=([a-f0-9]{64})\b/)![1];

      /** First GET with the token renders the raw key from the mock. */
      const first = await app.handle(
        new Request(`http://localhost/dashboard/api-keys?reveal=${token}`, {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(first.status).toBe(200);
      expect(await first.text()).toContain("bm_live_test1234567890abcdef12345678");

      /** Second GET with the SAME token no longer reveals it (single-use). */
      const second = await app.handle(
        new Request(`http://localhost/dashboard/api-keys?reveal=${token}`, {
          headers: { cookie: sessionCookie },
        }),
      );
      expect(second.status).toBe(200);
      expect(await second.text()).not.toContain("bm_live_test1234567890abcdef12345678");
    });

    /** Creates an API key in the session behind `cookie`; returns its reveal token. */
    async function createKeyRevealToken(cookie: string): Promise<string> {
      const created = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: "name=BoundKey",
        }),
      );
      return (
        created.headers.get("location")?.match(/[?&]reveal=([a-f0-9]{64})\b/)?.[1] ?? ""
      );
    }

    /** GETs `path` with `cookie` and returns the HTML. */
    async function pageText(path: string, cookie: string): Promise<string> {
      const response = await app.handle(
        new Request(`http://localhost${path}`, { headers: { cookie } }),
      );
      expect(response.status).toBe(200);
      return response.text();
    }

    test("another session cannot redeem the reveal token, and the creator still can (#280)", async () => {
      const token = await createKeyRevealToken(sessionCookie);
      expect(token).not.toBe("");
      const otherSession = `bm_session=${seedSession()}`;

      const stolen = await pageText(`/dashboard/api-keys?reveal=${token}`, otherSession);
      expect(stolen).not.toContain("bm_live_test1234567890abcdef12345678");

      /** The mismatch did not burn it: the creator still sees the key once. */
      const own = await pageText(`/dashboard/api-keys?reveal=${token}`, sessionCookie);
      expect(own).toContain("bm_live_test1234567890abcdef12345678");
    });

    test("an API-key reveal token shows nothing on the webhooks page (#280)", async () => {
      const token = await createKeyRevealToken(sessionCookie);
      const webhooks = await pageText(
        `/dashboard/webhooks?reveal=${token}`,
        sessionCookie,
      );
      expect(webhooks).not.toContain("bm_live_test1234567890abcdef12345678");

      const own = await pageText(`/dashboard/api-keys?reveal=${token}`, sessionCookie);
      expect(own).toContain("bm_live_test1234567890abcdef12345678");
    });

    test("POST /dashboard/domains creates domain and redirects", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/domains", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: "name=example.com",
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location")!;
      expect(location).toContain("/dashboard/domains");
      expect(location).toContain("flash=");
    });

    test("POST /dashboard/domains with an invalid name redirects with an error flash (#406)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/domains", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            origin: "http://localhost",
          },
          body: new URLSearchParams({ name: "https://example.com" }).toString(),
        }),
      );
      expect(response.status).toBe(302);
      const location = response.headers.get("location") ?? "";
      expect(location).toStartWith("/dashboard/domains?flash=");
      expect(location).toContain("flashType=error");
      const flash = new URL(location, "http://localhost").searchParams.get("flash");
      expect(flash).toContain("must be a host name such as example.com");
      /** The submitted value is not echoed into the redirect URL. */
      expect(flash).not.toContain("https://");
    });

    test("rejects a cross-origin POST with 403 (CSRF guard, #133)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
            /** Attacker's origin ≠ request host → rejected. */
            origin: "http://evil.example",
          },
          body: "name=CsrfKey",
        }),
      );
      expect(response.status).toBe(403);
    });

    test("rejects a POST with no Origin/Referer header (CSRF guard, #133)", async () => {
      const response = await app.handle(
        new Request("http://localhost/dashboard/api-keys", {
          method: "POST",
          headers: {
            cookie: sessionCookie,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "name=NoOriginKey",
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe("Key and template ownership in the routes (#219)", () => {
    /** Form-POSTs `fields` to `path` with the session behind `token`. */
    const post = (
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

    test("a member's key list is asked for its own keys, without admin controls", async () => {
      listApiKeys.mockClear();
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await getWithSession("/dashboard/api-keys", member);
      expect(response.status).toBe(200);
      expect(listApiKeys.mock.calls[0]?.[0]).toEqual({
        id: "usr_member",
        role: "member",
      });
      const html = await response.text();
      expect(html).toContain("The keys you created");
      expect(html).not.toContain('name="isAdmin"');
    });

    test("the send page and a send ask for the member's own keys only", async () => {
      listApiKeys.mockClear();
      const member = seedSession({ userId: "usr_member", role: "member" });
      expect((await getWithSession("/dashboard/send", member)).status).toBe(200);
      const response = await post("/dashboard/send", member, {
        apiKeyId: "key_someone_else",
        from: "hello@example.com",
        to: "user@example.org",
        subject: "hi",
      });
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Selected API key is not available",
      );
      const actors = listApiKeys.mock.calls.map((call) => call[0]);
      expect(actors).toEqual([
        { id: "usr_member", role: "member" },
        { id: "usr_member", role: "member" },
      ]);
    });

    test("an admin's key list shows the admin checkbox", async () => {
      const admin = seedSession({ userId: "usr_admin", role: "admin" });
      const html = await (await getWithSession("/dashboard/api-keys", admin)).text();
      expect(html).toContain('name="isAdmin"');
      expect(html).toContain("Every key on this server");
    });

    test("a member's create passes the member as actor; the service drops isAdmin", async () => {
      createApiKey.mockClear();
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await post("/dashboard/api-keys", member, {
        name: "Mine",
        isAdmin: "on",
      });
      expect(response.status).toBe(302);
      expect(createApiKey.mock.calls[0]?.[1]).toEqual({
        id: "usr_member",
        role: "member",
      });
    });

    test("a member's crafted admin toggle is refused by the guard", async () => {
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await post("/dashboard/api-keys/key_test123/admin", member, {
        isAdmin: "true",
      });
      expect(response.status).toBe(403);
    });

    test("a refused template edit or delete is the 403 page", async () => {
      const forbidden: FakeTemplateChange = { ok: false, reason: "forbidden" };
      const member = seedSession({ userId: "usr_member", role: "member" });

      updateTemplateAs.mockResolvedValueOnce(forbidden);
      const edit = await post("/dashboard/templates/tpl_x/edit", member, { name: "x" });
      expect(edit.status).toBe(403);
      expect(await edit.text()).toContain("admins and the owner can edit or delete it");

      deleteTemplateAs.mockResolvedValueOnce(forbidden);
      const del = await post("/dashboard/templates/tpl_x/delete", member, {});
      expect(del.status).toBe(403);
    });

    test("a template that is gone redirects with a not-found flash", async () => {
      const member = seedSession({ userId: "usr_member", role: "member" });
      const response = await post("/dashboard/templates/tpl_gone/delete", member, {});
      expect(response.status).toBe(302);
      expect(decodeURIComponent(response.headers.get("location") ?? "")).toContain(
        "Template not found",
      );
    });
  });

  describe("Sidebar by role (#218)", () => {
    /** The app as `src/index.ts` mounts it: with the per-request context. */
    const wrapped = new Elysia().wrap(withRequestContext).use(pagesPlugin);

    const home = async (token: string): Promise<string> =>
      (
        await wrapped.handle(
          new Request("http://localhost/dashboard", {
            headers: { cookie: `bm_session=${token}` },
          }),
        )
      ).text();

    test("a member's page has no link to an admin-only page", async () => {
      const html = await home(seedSession({ userId: "usr_member", role: "member" }));
      expect(html).toContain('href="/dashboard/emails"');
      /** A member's own keys (#219). */
      expect(html).toContain('href="/dashboard/api-keys"');
      expect(html).not.toContain('href="/dashboard/users"');
      expect(html).not.toContain('href="/dashboard/invitations"');
    });

    test("an admin's and the owner's pages link to them", async () => {
      for (const role of ["admin", "owner"] as const) {
        const html = await home(seedSession({ userId: `usr_${role}`, role }));
        expect(html).toContain('href="/dashboard/api-keys"');
        expect(html).toContain('href="/dashboard/users"');
        expect(html).toContain('href="/dashboard/invitations"');
      }
    });

    test("without the per-request context the admin links are hidden (fail closed)", async () => {
      const html = await (await getWithSession("/dashboard", seedSession())).text();
      expect(html).not.toContain('href="/dashboard/users"');
    });
  });
});
