import { describe, expect, test } from "bun:test";
import { config, readSsoSettings } from "../../src/config.ts";
import { ssoAutoLinkEmail } from "../../src/modules/users/services/sso-link-policy.service.ts";
import { ssoLogoKind, type SsoLogoKind } from "../../src/pages/components/sso-logo.tsx";
import { ssoSignInButtons } from "../../src/pages/lib/sso.ts";
import { LoginPage } from "../../src/pages/routes/login.tsx";

/**
 * The login page's SSO buttons (#224): only the providers whose client
 * credentials are set get one, each with a logo chosen by its issuer's
 * host, the label escaped. Driven through `readSsoSettings`, so the
 * presets and the credentials switch are covered end to end.
 */

const BASE = "https://mail.example.com";

/** Renders the login page with `config.sso` read from `env`, restoring it after. */
async function loginPageWith(env: Record<string, string | undefined>): Promise<string> {
  const original = config.sso;
  expect(
    Reflect.set(config, "sso", readSsoSettings({ APP_BASE_URL: BASE, ...env })),
  ).toBe(true);
  try {
    return await LoginPage({ sso: ssoSignInButtons() });
  } finally {
    expect(Reflect.set(config, "sso", original)).toBe(true);
  }
}

/** The `/dashboard/login/sso/<id>` form actions on a rendered page, in order. */
function ssoActions(html: string): string[] {
  return [...html.matchAll(/action="\/dashboard\/login\/sso\/([^"]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

/** The `data-sso-logo` kinds on a rendered page, in order. */
function logos(html: string): string[] {
  return [...html.matchAll(/data-sso-logo="([a-z0-9]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

describe("ssoLogoKind: by the issuer's host", () => {
  const cases: [string, string, SsoLogoKind][] = [
    ["google", "https://accounts.google.com", "google"],
    ["corp", "https://accounts.google.com", "google"],
    ["entra", "https://login.microsoftonline.com/0000-tenant/v2.0", "microsoft"],
    ["entra", "https://STS.windows.net/0000-tenant/", "microsoft"],
    ["entra-us", "https://login.microsoftonline.us/0000-tenant/v2.0", "microsoft"],
    ["gitlab", "https://gitlab.com", "gitlab"],
    ["code", "https://gitlab.com", "gitlab"],
    ["gitlab", "https://gitlab.example.com", "gitlab"],
    ["okta", "https://example.okta.com", "okta"],
    ["okta", "https://example.oktapreview.com/oauth2/default", "okta"],
    ["auth0", "https://example.eu.auth0.com/", "auth0"],
    ["kc", "https://sso.example.com/realms/corp", "keycloak"],
    ["kc-old", "https://sso.example.com/auth/realms/corp", "keycloak"],
    ["authentik", "https://auth.example.com/application/o/bunmail/", "generic"],
  ];
  for (const [id, issuer, kind] of cases) {
    test(`${id} at ${issuer}: ${kind}`, () => {
      expect(ssoLogoKind({ id, issuer })).toBe(kind);
    });
  }

  test("the id never brands a look-alike host", () => {
    expect(
      ssoLogoKind({ id: "google", issuer: "https://accounts.google.com.example.com" }),
    ).toBe("generic");
    expect(ssoLogoKind({ id: "okta", issuer: "https://okta.com.example.com" })).toBe(
      "generic",
    );
    expect(ssoLogoKind({ id: "microsoft", issuer: "https://login.example.com" })).toBe(
      "generic",
    );
    expect(ssoLogoKind({ id: "corp", issuer: "https://gitlab.example.com" })).toBe(
      "generic",
    );
  });
});

describe("LoginPage: one SSO button per configured provider", () => {
  test("no SSO_PROVIDERS and no credentials: no SSO button at all", async () => {
    const html = await loginPageWith({});
    expect(ssoActions(html)).toEqual([]);
    expect(logos(html)).toEqual([]);
    expect(html).not.toContain("Sign in with Google");
  });

  test("google and okta configured: exactly those two buttons, each with its logo", async () => {
    const html = await loginPageWith({
      SSO_PROVIDERS: "google,okta",
      SSO_GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
      SSO_GOOGLE_CLIENT_SECRET: "GOCSPX-abc",
      SSO_OKTA_ISSUER: "https://example.okta.com",
      SSO_OKTA_LABEL: "Okta",
      SSO_OKTA_CLIENT_ID: "0oa-client",
      SSO_OKTA_CLIENT_SECRET: "okta-secret",
    });
    expect(ssoActions(html)).toEqual(["google", "okta"]);
    expect(logos(html)).toEqual(["google", "okta"]);
    expect(html).toContain("Sign in with Google");
    expect(html).toContain("Sign in with Okta");
    expect(html).not.toContain("GOCSPX-abc");
    expect(html).not.toContain("okta-secret");
  });

  test("google by its credentials alone gets a button", async () => {
    const html = await loginPageWith({
      SSO_GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
      SSO_GOOGLE_CLIENT_SECRET: "GOCSPX-abc",
    });
    expect(ssoActions(html)).toEqual(["google"]);
    expect(logos(html)).toEqual(["google"]);
  });

  test("a configured provider and a listed one without credentials: one button", async () => {
    const html = await loginPageWith({
      SSO_PROVIDERS: "corp,gitlab",
      SSO_CORP_ISSUER: "https://sso.example.com/realms/corp",
      SSO_CORP_CLIENT_ID: "bunmail",
      SSO_CORP_CLIENT_SECRET: "s3cr3t-value",
    });
    expect(ssoActions(html)).toEqual(["corp"]);
    expect(logos(html)).toEqual(["keycloak"]);
  });

  test("an http APP_BASE_URL: SSO is off, no button", async () => {
    const html = await loginPageWith({
      APP_BASE_URL: "http://mail.example.com",
      SSO_GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
      SSO_GOOGLE_CLIENT_SECRET: "GOCSPX-abc",
    });
    expect(ssoActions(html)).toEqual([]);
  });

  test("the label stays escaped next to the logo", async () => {
    const html = await loginPageWith({
      SSO_PROVIDERS: "corp",
      SSO_CORP_ISSUER: "https://idp.example.com",
      SSO_CORP_LABEL: "<img src=x onerror=alert(1)>",
      SSO_CORP_CLIENT_ID: "bunmail",
      SSO_CORP_CLIENT_SECRET: "s3cr3t-value",
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(logos(html)).toEqual(["generic"]);
  });
});

describe("the Google preset keeps the hd rule (#224, part 4)", () => {
  test("a non-gmail address from the default Google issuer needs an hd claim", () => {
    const [google] = readSsoSettings({
      APP_BASE_URL: BASE,
      SSO_GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
      SSO_GOOGLE_CLIENT_SECRET: "GOCSPX-abc",
      SSO_GOOGLE_ALLOWED_DOMAINS: "example.com",
      SSO_GOOGLE_AUTO_LINK: "true",
    }).providers;
    if (google === undefined) throw new Error("google preset not configured");
    expect(
      ssoAutoLinkEmail(google, {
        email: "alice@example.com",
        emailVerified: true,
        hostedDomain: null,
      }),
    ).toEqual({ ok: false, reason: "hosted_domain_not_allowed" });
    expect(
      ssoAutoLinkEmail(google, {
        email: "alice@example.com",
        emailVerified: true,
        hostedDomain: "example.com",
      }),
    ).toEqual({ ok: true, email: "alice@example.com" });
  });
});
