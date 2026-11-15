import { describe, test, expect } from "bun:test";
import {
  app,
  getWithSession,
  seedSession,
  setAccountResult,
  useDashboardMocks,
} from "./dashboard-setup.ts";

/**
 * Dashboard E2E: flash codes (#421). A redirect after a form action
 * carries a code, and the page it lands on shows the message written for
 * that code; a link with any other `flash` text shows no banner at all.
 * Setup, fakes and helpers: `dashboard-setup.ts` (#291).
 */
useDashboardMocks();

/** The banner's colour classes (`FlashMessage`). */
const ERROR_BANNER = "bg-red-50 text-red-800";
const SUCCESS_BANNER = "bg-emerald-50 text-emerald-800";

/** Same-origin form POST with a session cookie. */
function post(
  path: string,
  token: string,
  fields: Record<string, string> = {},
): Promise<Response> {
  return app.handle(
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
}

/** The HTML of `path` for the session behind `token`. */
async function page(path: string, token: string): Promise<string> {
  const response = await getWithSession(path, token);
  expect(response.status).toBe(200);
  return response.text();
}

describe("Dashboard E2E: flash codes (#421)", () => {
  test("a refused action redirects with a code and the next page shows its error banner", async () => {
    const owner = seedSession();
    const response = await post("/dashboard/templates/tpl_gone/delete", owner);
    expect(response.status).toBe(302);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("/dashboard/templates?flash=template_not_found");

    const html = await page(location, owner);
    expect(html).toContain("Template not found");
    expect(html).toContain(ERROR_BANNER);
  });

  test("an applied action redirects with a code and the next page shows its success banner", async () => {
    setAccountResult({ ok: true });
    const owner = seedSession();
    const response = await post("/dashboard/users/usr_admin/role", owner, {
      role: "member",
    });
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("/dashboard/users?flash=account_role_member");

    const html = await page(location, owner);
    expect(html).toContain("Role changed to member.");
    expect(html).toContain(SUCCESS_BANNER);
  });

  test("attacker-written text in the link shows no banner, whatever its type", async () => {
    const owner = seedSession();
    const text = "Your account was compromised, call +1 555 0100";
    for (const path of [
      `/dashboard/templates?flash=${encodeURIComponent(text)}&flashType=error`,
      `/dashboard/users?flash=${encodeURIComponent(text)}`,
      `/dashboard/account/sessions?flash=${encodeURIComponent(text)}&flashType=error`,
    ]) {
      const html = await page(path, owner);
      expect(html).not.toContain("compromised");
      expect(html).not.toContain(ERROR_BANNER);
      expect(html).not.toContain(SUCCESS_BANNER);
    }
  });

  test("an unknown code, or an old free-text bookmark, shows nothing and is not an error", async () => {
    const owner = seedSession();
    for (const path of [
      "/dashboard/templates?flash=not_a_code",
      "/dashboard/templates?flash=Template%20created",
      "/dashboard/templates?flash=__proto__",
    ]) {
      const html = await page(path, owner);
      expect(html).not.toContain(ERROR_BANNER);
      expect(html).not.toContain(SUCCESS_BANNER);
    }
  });

  test("a numeric code shows its number, and a number with text in it shows nothing", async () => {
    const owner = seedSession();
    const counted = await page(
      "/dashboard/account/sessions?flash=sessions_revoked_others&flashN=2",
      owner,
    );
    expect(counted).toContain("Signed out 2 other devices.");

    const smuggled = await page(
      `/dashboard/account/sessions?flash=sessions_revoked_others&flashN=${encodeURIComponent("2 devices. Call +1 555 0100")}`,
      owner,
    );
    expect(smuggled).not.toContain("555 0100");
    expect(smuggled).not.toContain("Signed out");
  });
});
