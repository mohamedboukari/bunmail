import { describe, test, expect } from "bun:test";
import {
  LIVE_TOKEN,
  UNKNOWN_TOKEN,
  app,
  completeOwnerSetup,
  cookieValue,
  findLiveOwnerSetup,
  lastSetupSessionToken,
  useDashboardMocks,
  warnLog,
} from "./dashboard-setup.ts";

/** Dashboard E2E: owner setup. Setup, fakes and helpers: `dashboard-setup.ts` (#291). */
useDashboardMocks();

describe("Dashboard E2E: owner setup", () => {
  describe("Owner setup", () => {
    const GOOD_PASSWORD = "correct horse battery staple";

    /** Form-POSTs to /dashboard/setup; same-origin unless overridden. */
    const postSetup = (
      fields: Record<string, string>,
      headers: Record<string, string> = { origin: "http://localhost" },
    ): Promise<Response> =>
      app.handle(
        new Request("http://localhost/dashboard/setup", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams(fields).toString(),
        }),
      );

    /** The leak-hardening headers every setup response carries. */
    const expectAuthPageHeaders = (response: Response): void => {
      expect(response.headers.get("cache-control")).toBe("no-store");
      /**
       * strict-origin, never no-referrer: under no-referrer browsers send
       * `Origin: null` on the form POST and setup could never complete.
       */
      expect(response.headers.get("referrer-policy")).toBe("strict-origin");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
    };

    test("GET with a live token and no cookie renders the form (public route)", async () => {
      const response = await app.handle(
        new Request(`http://localhost/dashboard/setup?token=${LIVE_TOKEN}`),
      );
      expect(response.status).toBe(200);
      expectAuthPageHeaders(response);
      const html = await response.text();
      expect(html).toContain('action="/dashboard/setup"');
      expect(html).toContain(`name="token" value="${LIVE_TOKEN}"`);
      expect(html).toContain("owner@example.com");
      expect(html).toContain('<meta name="referrer" content="strict-origin"');
    });

    test("GET without, with a malformed or with an unknown token: identical 400s", async () => {
      const calls = findLiveOwnerSetup.mock.calls.length;
      const missing = await app.handle(new Request("http://localhost/dashboard/setup"));
      const malformed = await app.handle(
        new Request("http://localhost/dashboard/setup?token=not-a-token"),
      );
      /** Neither reached the database. */
      expect(findLiveOwnerSetup.mock.calls.length).toBe(calls);

      const unknown = await app.handle(
        new Request(`http://localhost/dashboard/setup?token=${UNKNOWN_TOKEN}`),
      );
      expect(findLiveOwnerSetup.mock.calls.length).toBe(calls + 1);

      const bodies: string[] = [];
      for (const response of [missing, malformed, unknown]) {
        expect(response.status).toBe(400);
        expectAuthPageHeaders(response);
        bodies.push(await response.text());
      }
      expect(bodies[1]).toBe(bodies[0]);
      expect(bodies[2]).toBe(bodies[0]);
      expect(bodies[0]).toContain("reset-owner");
      expect(bodies[1]).not.toContain("not-a-token");
      expect(bodies[2]).not.toContain(UNKNOWN_TOKEN);
    });

    test("POST with Origin: null (what a no-referrer page would send) is 403", async () => {
      /**
       * Pins why the setup pages use strict-origin: a page under
       * no-referrer makes browsers send `Origin: null`, which the
       * same-origin check rightly rejects, so setup would be impossible.
       */
      const calls = completeOwnerSetup.mock.calls.length;
      const response = await postSetup(
        {
          token: LIVE_TOKEN,
          password: "a-long-enough-password",
          confirm: "a-long-enough-password",
        },
        { origin: "null" },
      );
      expect(response.status).toBe(403);
      expect(completeOwnerSetup.mock.calls.length).toBe(calls);
    });

    test("POST from another origin, or with no origin, is 403 before any work", async () => {
      const findCalls = findLiveOwnerSetup.mock.calls.length;
      const completeCalls = completeOwnerSetup.mock.calls.length;
      const fields = {
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      };

      const evil = await postSetup(fields, { origin: "http://evil.example" });
      expect(evil.status).toBe(403);
      expectAuthPageHeaders(evil);
      expect(evil.headers.get("set-cookie")).toBeNull();

      const noOrigin = await postSetup(fields, {});
      expect(noOrigin.status).toBe(403);

      expect(findLiveOwnerSetup.mock.calls.length).toBe(findCalls);
      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
      expect(warnLog).toHaveBeenCalledWith(
        "Owner setup POST rejected: cross-origin (possible CSRF)",
        expect.objectContaining({ origin: "http://evil.example" }),
      );
    });

    test("POST with a short password or a mismatch re-renders the form, no write", async () => {
      const completeCalls = completeOwnerSetup.mock.calls.length;

      const short = await postSetup({
        token: LIVE_TOKEN,
        password: "short",
        confirm: "short",
      });
      expect(short.status).toBe(200);
      expectAuthPageHeaders(short);
      const shortHtml = await short.text();
      expect(shortHtml).toContain("at least 15 characters");
      expect(shortHtml).toContain(`name="token" value="${LIVE_TOKEN}"`);

      const mismatch = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: `${GOOD_PASSWORD}!`,
      });
      expect(mismatch.status).toBe(200);
      const mismatchHtml = await mismatch.text();
      expect(mismatchHtml).toContain("do not match");
      expect(mismatchHtml).toContain(`name="token" value="${LIVE_TOKEN}"`);
      /** The password is never echoed back. */
      expect(mismatchHtml).not.toContain(GOOD_PASSWORD);

      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
    });

    test("POST with an unknown or malformed token is the invalid page, no write", async () => {
      const completeCalls = completeOwnerSetup.mock.calls.length;
      for (const token of [UNKNOWN_TOKEN, "bad"]) {
        const response = await postSetup({
          token,
          password: GOOD_PASSWORD,
          confirm: GOOD_PASSWORD,
        });
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("not valid");
      }
      expect(completeOwnerSetup.mock.calls.length).toBe(completeCalls);
    });

    test("a valid POST signs in with the session cookie and redirects to /dashboard", async () => {
      warnLog.mockClear();
      const response = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(response.status).toBe(302);
      expectAuthPageHeaders(response);
      const location = response.headers.get("location");
      expect(location).toBe("/dashboard");
      expect(location).not.toContain(LIVE_TOKEN);

      const setCookie = response.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("bm_session=");
      /** The cookie is the session completeOwnerSetup opened, nothing else. */
      expect(cookieValue(response)).toBe(lastSetupSessionToken);
      expect(setCookie).toContain("Max-Age=604800");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Lax");
      expect(setCookie).toContain("Path=/dashboard");

      expect(completeOwnerSetup).toHaveBeenLastCalledWith(LIVE_TOKEN, GOOD_PASSWORD, {
        ip: "unknown",
        userAgent: null,
      });
      expect(warnLog).toHaveBeenCalledWith(
        "Owner setup completed",
        expect.objectContaining({ owner: "owner@example.com" }),
      );

      /** The issued cookie opens the dashboard. */
      const cookie = setCookie.match(/bm_session=([^;]+)/)?.[1] ?? "";
      const home = await app.handle(
        new Request("http://localhost/dashboard", {
          headers: { cookie: `bm_session=${cookie}` },
        }),
      );
      expect(home.status).toBe(200);
    });

    test("a token spent between the check and the write gets the invalid page", async () => {
      completeOwnerSetup.mockImplementationOnce(() => Promise.resolve(null));
      const response = await postSetup({
        token: LIVE_TOKEN,
        password: GOOD_PASSWORD,
        confirm: GOOD_PASSWORD,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain("not valid");
    });

    test("protected routes still redirect to login without a cookie", async () => {
      const response = await app.handle(new Request("http://localhost/dashboard/emails"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard/login");
    });
  });
});
