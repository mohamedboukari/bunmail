import { describe, test, expect, beforeAll, beforeEach } from "bun:test";
import {
  CREATION_OPTIONS,
  OWNER,
  REQUEST_OPTIONS,
  UserStoreError,
  app,
  completePasskeySignIn,
  completePasskeyTwoFactor,
  deletePasskey,
  fakeToken,
  findPendingSession,
  finishRegistration,
  infoLog,
  listPasskeys,
  openPasskeySession,
  renamePasskey,
  revokeSessionByToken,
  seedSession,
  sendTwoFactorAlert,
  startPasskeyTwoFactor,
  startRegistration,
  useDashboardMocks,
  warnLog,
} from "./dashboard-setup.ts";

/** Dashboard E2E: passkeys. Setup, fakes and helpers: `dashboard-setup.ts` (#291). */
useDashboardMocks();

describe("Passkey routes (#223)", () => {
  const BINDING = "b".repeat(43);
  const CREDENTIAL = JSON.stringify({
    id: "Y3JlZA",
    rawId: "Y3JlZA",
    type: "public-key",
  });
  let address = 0;

  /** A request with optional cookies and a form body; same-origin unless overridden. */
  function call(
    method: "GET" | "POST",
    path: string,
    opts: {
      session?: string;
      wa?: string;
      body?: Record<string, string>;
      origin?: string;
      ip?: string;
    } = {},
  ): Promise<Response> {
    const cookies = [
      ...(opts.session ? [`bm_session=${opts.session}`] : []),
      ...(opts.wa ? [`bm_wa=${opts.wa}`] : []),
    ];
    address += 1;
    const headers: Record<string, string> = {
      "x-forwarded-for": opts.ip ?? `198.18.9.${address % 250}`,
    };
    if (cookies.length > 0) headers["cookie"] = cookies.join("; ");
    if (method === "POST") {
      headers["origin"] = opts.origin ?? "http://localhost";
      headers["content-type"] = "application/x-www-form-urlencoded";
    }
    const url = `http://localhost${path}`;
    if (method === "GET") return app.handle(new Request(url, { headers }));
    return app.handle(
      new Request(url, {
        method: "POST",
        headers,
        body: new URLSearchParams(opts.body ?? {}).toString(),
      }),
    );
  }

  /** The JSON body of an options answer. */
  async function json(
    response: Response,
  ): Promise<{ options?: unknown; error?: string; redirect?: string }> {
    const text = await response.text();
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    return {
      options: Reflect.get(parsed, "options"),
      error: Reflect.get(parsed, "error"),
      redirect: Reflect.get(parsed, "redirect"),
    };
  }

  /** The flash of a redirect. */
  function flashOf(response: Response): string {
    return (
      new URL(
        response.headers.get("location") ?? "",
        "http://localhost",
      ).searchParams.get("flash") ?? ""
    );
  }

  /** A pending session the second-step routes will find. */
  function pending(): string {
    const token = fakeToken();
    findPendingSession.mockImplementation((presented: string) =>
      Promise.resolve(
        presented === token
          ? { sessionId: "ses_pending", userId: OWNER.userId, email: OWNER.email }
          : null,
      ),
    );
    return token;
  }

  let config: { appBaseUrl: string } = { appBaseUrl: "" };
  beforeAll(async () => {
    const loaded = await import("../../src/config.ts");
    config = loaded.config;
  });
  beforeEach(() => {
    expect(Reflect.set(config, "appBaseUrl", "http://localhost")).toBe(true);
    findPendingSession.mockImplementation(() => Promise.resolve(null));
    sendTwoFactorAlert.mockClear();
  });

  describe("passwordless sign-in", () => {
    test("the login page offers it only while passkeys are on", async () => {
      expect(await (await call("GET", "/dashboard/login")).text()).toContain(
        "Sign in with a passkey",
      );
      expect(Reflect.set(config, "appBaseUrl", "")).toBe(true);
      expect(await (await call("GET", "/dashboard/login")).text()).not.toContain(
        "Sign in with a passkey",
      );
    });

    test("options: the bm_wa cookie and the options; off, cross-origin and over budget are refused", async () => {
      const ok = await call("POST", "/dashboard/login/passkey/options");
      expect(ok.status).toBe(200);
      const cookie = ok.headers.get("set-cookie") ?? "";
      expect(cookie).toContain(`bm_wa=${BINDING}`);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Max-Age=300");
      expect((await json(ok)).options).toEqual(REQUEST_OPTIONS);

      const evil = await call("POST", "/dashboard/login/passkey/options", {
        origin: "http://evil.example",
      });
      expect(evil.status).toBe(403);

      const ip = "203.0.113.200";
      for (let i = 0; i < 5; i++) {
        expect(
          (await call("POST", "/dashboard/login/passkey/options", { ip })).status,
        ).toBe(200);
      }
      const limited = await call("POST", "/dashboard/login/passkey/options", { ip });
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).not.toBeNull();
      expect((await json(limited)).error).toStartWith("Too many failed attempts.");

      expect(Reflect.set(config, "appBaseUrl", "")).toBe(true);
      const off = await call("POST", "/dashboard/login/passkey/options");
      expect(off.status).toBe(404);
      expect((await json(off)).error).toBe("Passkeys are switched off on this server.");
    });

    test("finish: a verified passkey opens a session, replacing the browser's previous one", async () => {
      const previous = seedSession();
      const revokes = revokeSessionByToken.mock.calls.length;
      const response = await call("POST", "/dashboard/login/passkey", {
        wa: BINDING,
        session: previous,
        body: { credential: CREDENTIAL },
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/dashboard");
      const cookies = response.headers.getSetCookie();
      expect(cookies.some((c) => c.startsWith("bm_session=T"))).toBe(true);
      expect(cookies.some((c) => c.startsWith("bm_wa=;"))).toBe(true);
      expect(cookies.some((c) => c.startsWith("bm_device="))).toBe(true);
      expect(revokeSessionByToken.mock.calls.length).toBe(revokes + 1);
      expect(infoLog).toHaveBeenCalledWith(
        "Dashboard login successful",
        expect.objectContaining({ method: "passkey", passkeyId: "crd_passkey" }),
      );
    });

    test("finish: every refusal is one generic redirect; a counter regression emails the account", async () => {
      const noCookie = await call("POST", "/dashboard/login/passkey", {
        body: { credential: CREDENTIAL },
      });
      expect(noCookie.headers.get("location")).toBe("/dashboard/login?error=passkey");

      for (const reason of [
        "rejected",
        "unknown_credential",
        "account_disabled",
      ] as const) {
        completePasskeySignIn.mockImplementationOnce(() =>
          Promise.resolve({ ok: false, reason, userId: OWNER.userId }),
        );
        const response = await call("POST", "/dashboard/login/passkey", {
          wa: BINDING,
          body: { credential: CREDENTIAL },
        });
        expect(response.headers.get("location")).toBe("/dashboard/login?error=passkey");
      }
      expect(sendTwoFactorAlert).not.toHaveBeenCalled();

      completePasskeySignIn.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          reason: "counter_regressed",
          userId: OWNER.userId,
          passkey: {
            id: "crd_passkey",
            name: "Laptop",
            userId: OWNER.userId,
            email: OWNER.email,
          },
        }),
      );
      const regressed = await call("POST", "/dashboard/login/passkey", {
        wa: BINDING,
        body: { credential: CREDENTIAL },
      });
      expect(regressed.headers.get("location")).toBe("/dashboard/login?error=passkey");
      expect(sendTwoFactorAlert.mock.calls.map(([input]) => input.event)).toEqual([
        "passkey_counter_regressed",
      ]);
      expect(warnLog).toHaveBeenCalledWith(
        "Passkey refused: signature counter did not increase (possible clone)",
        expect.objectContaining({ passkeyId: "crd_passkey" }),
      );
    });

    test("finish: a passkey removed meanwhile fails; a store error is 503; cross-origin is 403", async () => {
      openPasskeySession.mockImplementationOnce(() =>
        Promise.reject(new UserStoreError("23503")),
      );
      const removed = await call("POST", "/dashboard/login/passkey", {
        wa: BINDING,
        body: { credential: CREDENTIAL },
      });
      expect(removed.headers.get("location")).toBe("/dashboard/login?error=passkey");

      openPasskeySession.mockImplementationOnce(() => Promise.reject(new Error("down")));
      const down = await call("POST", "/dashboard/login/passkey", {
        wa: BINDING,
        body: { credential: CREDENTIAL },
      });
      expect(down.status).toBe(503);

      const evil = await call("POST", "/dashboard/login/passkey", {
        wa: BINDING,
        origin: "http://evil.example",
        body: { credential: CREDENTIAL },
      });
      expect(evil.status).toBe(403);
    });
  });

  describe("second login step", () => {
    test("the step page offers the passkey; options need a pending session and a passkey", async () => {
      const token = pending();
      const page = await call("GET", "/dashboard/login/two-factor", { session: token });
      expect(await page.text()).toContain("Use a passkey");

      const ok = await call("POST", "/dashboard/login/two-factor/passkey/options", {
        session: token,
      });
      expect((await json(ok)).options).toEqual(REQUEST_OPTIONS);

      startPasskeyTwoFactor.mockImplementationOnce(() => Promise.resolve(null));
      const none = await call("POST", "/dashboard/login/two-factor/passkey/options", {
        session: token,
      });
      expect(none.status).toBe(400);

      const gone = await call("POST", "/dashboard/login/two-factor/passkey/options", {
        session: fakeToken(),
      });
      expect(gone.status).toBe(401);
      expect((await json(gone)).redirect).toBe("/dashboard");

      findPendingSession.mockImplementationOnce(() => Promise.reject(new Error("down")));
      const down = await call("POST", "/dashboard/login/two-factor/passkey/options", {
        session: token,
      });
      expect(down.status).toBe(503);

      const evil = await call("POST", "/dashboard/login/two-factor/passkey/options", {
        session: token,
        origin: "http://evil.example",
      });
      expect(evil.status).toBe(403);

      expect(Reflect.set(config, "appBaseUrl", "")).toBe(true);
      const off = await call("POST", "/dashboard/login/two-factor/passkey/options", {
        session: token,
      });
      expect(off.status).toBe(404);
    });

    test("finish: success, a refusal, a counter regression, a gone session and the lock", async () => {
      const token = pending();
      const ok = await call("POST", "/dashboard/login/two-factor/passkey", {
        session: token,
        body: { credential: CREDENTIAL },
      });
      expect(ok.headers.get("location")).toBe("/dashboard");
      expect(ok.headers.getSetCookie().some((c) => c.includes("Max-Age=600"))).toBe(true);

      completePasskeyTwoFactor.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, reason: "rejected" }),
      );
      const refused = await call("POST", "/dashboard/login/two-factor/passkey", {
        session: token,
        body: { credential: CREDENTIAL },
      });
      expect(refused.status).toBe(200);
      expect(await refused.text()).toContain("That passkey was not accepted. Try again.");

      completePasskeyTwoFactor.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          reason: "counter_regressed",
          passkey: {
            id: "crd_passkey",
            name: "Laptop",
            userId: OWNER.userId,
            email: OWNER.email,
          },
        }),
      );
      await call("POST", "/dashboard/login/two-factor/passkey", {
        session: token,
        body: { credential: CREDENTIAL },
      });
      expect(sendTwoFactorAlert.mock.calls.map(([input]) => input.event)).toEqual([
        "passkey_counter_regressed",
      ]);

      completePasskeyTwoFactor.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, reason: "session_gone" }),
      );
      const gone = await call("POST", "/dashboard/login/two-factor/passkey", {
        session: token,
        body: { credential: CREDENTIAL },
      });
      expect(gone.headers.get("location")).toBe("/dashboard");

      completePasskeyTwoFactor.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, reason: "rate_limited" }),
      );
      const locked = await call("POST", "/dashboard/login/two-factor/passkey", {
        session: token,
        body: { credential: CREDENTIAL },
      });
      expect(locked.headers.get("location")).toBe(
        "/dashboard/login?error=two_factor_locked",
      );
      expect(locked.headers.get("set-cookie")).toContain("Max-Age=0");
    });

    test("finish: no pending session, passkeys off, a store error and cross-origin", async () => {
      const none = await call("POST", "/dashboard/login/two-factor/passkey", {
        session: fakeToken(),
        body: { credential: CREDENTIAL },
      });
      expect(none.headers.get("location")).toBe("/dashboard");

      const token = pending();
      completePasskeyTwoFactor.mockImplementationOnce(() =>
        Promise.reject(new Error("down")),
      );
      const down = await call("POST", "/dashboard/login/two-factor/passkey", {
        session: token,
        body: { credential: CREDENTIAL },
      });
      expect(down.status).toBe(503);

      const evil = await call("POST", "/dashboard/login/two-factor/passkey", {
        session: token,
        origin: "http://evil.example",
        body: { credential: CREDENTIAL },
      });
      expect(evil.status).toBe(403);

      expect(Reflect.set(config, "appBaseUrl", "")).toBe(true);
      const off = await call("POST", "/dashboard/login/two-factor/passkey", {
        session: token,
        body: { credential: CREDENTIAL },
      });
      expect(off.status).toBe(200);
      expect(await off.text()).toContain("Passkeys are switched off on this server.");
    });
  });

  describe("the Passkeys page", () => {
    test("lists the passkeys; a store error is a 500 page", async () => {
      const session = seedSession();
      const page = await call("GET", "/dashboard/account/passkeys", { session });
      expect(page.status).toBe(200);
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(await page.text()).toContain("Laptop");

      listPasskeys.mockImplementationOnce(() => Promise.reject(new Error("down")));
      const down = await call("GET", "/dashboard/account/passkeys", { session });
      expect(down.status).toBe(500);
      expect(await down.text()).toContain("Failed to load your passkeys.");
    });

    test("options: the name and the password first; each refusal has its answer", async () => {
      const session = seedSession();
      const body = { name: " Key ", password: "x" };
      const ok = await call("POST", "/dashboard/account/passkeys/options", {
        session,
        body,
      });
      expect((await json(ok)).options).toEqual(CREATION_OPTIONS);
      expect(startRegistration.mock.calls.at(-1)?.[0].name).toBe("Key");

      startRegistration.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          reason: "invalid_name",
          problem: "Give the passkey a name.",
        }),
      );
      const named = await call("POST", "/dashboard/account/passkeys/options", {
        session,
        body,
      });
      expect(named.status).toBe(400);
      expect((await json(named)).error).toBe("Give the passkey a name.");

      startRegistration.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, reason: "wrong_password" }),
      );
      const wrong = await call("POST", "/dashboard/account/passkeys/options", {
        session,
        body,
      });
      expect(wrong.status).toBe(400);
      expect((await json(wrong)).error).toBe("Current password is incorrect.");

      startRegistration.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, reason: "rate_limited" }),
      );
      const limited = await call("POST", "/dashboard/account/passkeys/options", {
        session,
        body,
      });
      expect(limited.status).toBe(429);

      startRegistration.mockImplementationOnce(() => Promise.reject(new Error("down")));
      const down = await call("POST", "/dashboard/account/passkeys/options", {
        session,
        body,
      });
      expect(down.status).toBe(500);

      expect(Reflect.set(config, "appBaseUrl", "")).toBe(true);
      const off = await call("POST", "/dashboard/account/passkeys/options", {
        session,
        body,
      });
      expect(off.status).toBe(404);
    });

    test("finish: added (with and without other sessions signed out), refused, failed, off", async () => {
      const session = seedSession();
      const body = { credential: CREDENTIAL };
      expect(
        flashOf(await call("POST", "/dashboard/account/passkeys", { session, body })),
      ).toBe("Passkey added.");
      expect(sendTwoFactorAlert.mock.calls.map(([input]) => input.event)).toEqual([
        "passkey_added",
      ]);

      finishRegistration.mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          credentialId: "crd_new",
          name: "New",
          sessionsRevoked: 2,
        }),
      );
      expect(
        flashOf(await call("POST", "/dashboard/account/passkeys", { session, body })),
      ).toBe("Passkey added. You were signed out on every other device.");

      finishRegistration.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, reason: "already_registered" }),
      );
      expect(
        flashOf(await call("POST", "/dashboard/account/passkeys", { session, body })),
      ).toBe("That passkey is already registered.");

      finishRegistration.mockImplementationOnce(() => Promise.reject(new Error("down")));
      expect(
        flashOf(await call("POST", "/dashboard/account/passkeys", { session, body })),
      ).toBe("Failed to add the passkey: nothing was changed.");

      expect(Reflect.set(config, "appBaseUrl", "")).toBe(true);
      expect(
        flashOf(await call("POST", "/dashboard/account/passkeys", { session, body })),
      ).toBe("Passkeys are switched off on this server.");
    });

    test("rename and remove: done, refused, failed", async () => {
      const session = seedSession();
      const rename = (): Promise<Response> =>
        call("POST", "/dashboard/account/passkeys/crd_passkey/rename", {
          session,
          body: { name: "Desk" },
        });
      expect(flashOf(await rename())).toBe("Passkey renamed.");
      renamePasskey.mockImplementationOnce(() =>
        Promise.resolve({
          ok: false,
          reason: "invalid_name",
          problem: "Give the passkey a name.",
        }),
      );
      expect(flashOf(await rename())).toBe("Give the passkey a name.");
      renamePasskey.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, reason: "not_found" }),
      );
      expect(flashOf(await rename())).toBe(
        "That passkey was not found: nothing was changed.",
      );
      renamePasskey.mockImplementationOnce(() => Promise.reject(new Error("down")));
      expect(flashOf(await rename())).toBe(
        "Failed to rename the passkey: nothing was changed.",
      );

      const remove = (): Promise<Response> =>
        call("POST", "/dashboard/account/passkeys/crd_passkey/delete", {
          session,
          body: { password: "x" },
        });
      expect(flashOf(await remove())).toBe("Passkey removed.");
      expect(sendTwoFactorAlert.mock.calls.map(([input]) => input.event)).toEqual([
        "passkey_removed",
      ]);
      deletePasskey.mockImplementationOnce(() =>
        Promise.resolve({ ok: false, reason: "wrong_password" }),
      );
      expect(flashOf(await remove())).toBe("Current password is incorrect.");
      deletePasskey.mockImplementationOnce(() => Promise.reject(new Error("down")));
      expect(flashOf(await remove())).toBe(
        "Failed to remove the passkey: nothing was changed.",
      );
    });
  });
});
