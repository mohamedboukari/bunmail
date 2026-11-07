import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SSO_SCOPES,
  MAX_SSO_ISSUER_LENGTH,
  readSsoSettings,
  ssoBaseUrlFrom,
  ssoEnvPrefix,
} from "../../src/config.ts";

/**
 * SSO configuration (#224): `SSO_PROVIDERS` and the `SSO_<ID>_*`
 * variables are read strictly (any malformed value refuses to boot), and
 * an `APP_BASE_URL` that cannot carry redirect URIs turns SSO off instead.
 */

/** A valid one-provider environment, to vary one variable at a time. */
const base: Record<string, string | undefined> = {
  APP_BASE_URL: "https://mail.example.com",
  SSO_PROVIDERS: "corp",
  SSO_CORP_ISSUER: "https://idp.example.com/realms/corp",
  SSO_CORP_CLIENT_ID: "bunmail",
  SSO_CORP_CLIENT_SECRET: "s3cr3t-value",
};

describe("readSsoSettings: off", () => {
  test("unset or blank SSO_PROVIDERS: no providers, nothing else read", () => {
    expect(readSsoSettings({})).toEqual({ providers: [], skipped: [], baseUrl: null });
    expect(
      readSsoSettings({
        SSO_PROVIDERS: " , ",
        SSO_X_ISSUER: "not a url",
        APP_BASE_URL: "https://mail.example.com/",
      }),
    ).toEqual({ providers: [], skipped: [], baseUrl: "https://mail.example.com" });
  });
});

describe("readSsoSettings: valid", () => {
  test("defaults: label is the id, default scopes, no domains, no auto-link", () => {
    const settings = readSsoSettings(base);
    expect(settings.baseUrl).toBe("https://mail.example.com");
    expect(settings.providers).toEqual([
      {
        id: "corp",
        issuer: "https://idp.example.com/realms/corp",
        clientId: "bunmail",
        clientSecret: "s3cr3t-value",
        label: "corp",
        scopes: DEFAULT_SSO_SCOPES,
        allowedDomains: [],
        autoLink: false,
      },
    ]);
  });

  test("every option, two providers, an id with a hyphen", () => {
    const settings = readSsoSettings({
      ...base,
      SSO_PROVIDERS: "corp, google-ws",
      SSO_CORP_LABEL: "  Corporate Keycloak ",
      SSO_CORP_SCOPES: "openid  email openid groups",
      SSO_GOOGLE_WS_ISSUER: "https://accounts.google.com",
      SSO_GOOGLE_WS_CLIENT_ID: "123.apps.googleusercontent.com",
      SSO_GOOGLE_WS_CLIENT_SECRET: "GOCSPX-abc",
      SSO_GOOGLE_WS_ALLOWED_DOMAINS: "Example.COM, example.org.,example.com",
      SSO_GOOGLE_WS_AUTO_LINK: "true",
    });
    const [corp, google] = settings.providers;
    expect(corp?.label).toBe("Corporate Keycloak");
    expect(corp?.scopes).toBe("openid email groups");
    expect(google?.id).toBe("google-ws");
    expect(google?.allowedDomains).toEqual(["example.com", "example.org"]);
    expect(google?.autoLink).toBe(true);
  });

  test("plain http issuer on a loopback host", () => {
    for (const issuer of [
      "http://localhost:8080/realms/dev",
      "http://127.0.0.1:9000",
      "http://[::1]:9000",
    ]) {
      expect(
        readSsoSettings({ ...base, SSO_CORP_ISSUER: issuer }).providers[0]?.issuer,
      ).toBe(issuer);
    }
  });

  test("the issuer is kept exactly, trailing slash included", () => {
    const issuer = "https://idp.example.com/";
    expect(
      readSsoSettings({ ...base, SSO_CORP_ISSUER: issuer }).providers[0]?.issuer,
    ).toBe(issuer);
  });

  test("env prefix: upper-cased, hyphens become underscores", () => {
    expect(ssoEnvPrefix("my-idp-2")).toBe("SSO_MY_IDP_2_");
  });
});

describe("readSsoSettings: refusals", () => {
  const refusals: [string, Record<string, string | undefined>, RegExp][] = [
    ["an uppercase id", { ...base, SSO_PROVIDERS: "Corp" }, /SSO_PROVIDERS entries/],
    ["an id with an underscore", { ...base, SSO_PROVIDERS: "my_idp" }, /SSO_PROVIDERS/],
    [
      "an id over 32 characters",
      { ...base, SSO_PROVIDERS: "a".repeat(33) },
      /SSO_PROVIDERS/,
    ],
    ["a duplicate id", { ...base, SSO_PROVIDERS: "corp,corp" }, /twice/],
    [
      "two ids with the same issuer (#224: links are keyed by the issuer)",
      {
        ...base,
        SSO_PROVIDERS: "corp,corp-2",
        SSO_CORP_2_ISSUER: base["SSO_CORP_ISSUER"],
        SSO_CORP_2_CLIENT_ID: "other",
        SSO_CORP_2_CLIENT_SECRET: "other-secret",
      },
      /SSO_CORP_2_ISSUER is also the issuer of "corp"/,
    ],
    [
      "a missing issuer",
      { ...base, SSO_CORP_ISSUER: undefined },
      /SSO_CORP_ISSUER must be set/,
    ],
    [
      "an issuer that is not a URL",
      { ...base, SSO_CORP_ISSUER: "idp.example.com" },
      /absolute URL/,
    ],
    [
      "a plain http issuer off loopback",
      { ...base, SSO_CORP_ISSUER: "http://idp.example.com" },
      /https:\/\//,
    ],
    [
      "an ftp issuer",
      { ...base, SSO_CORP_ISSUER: "ftp://idp.example.com" },
      /https:\/\//,
    ],
    [
      "an issuer with a query",
      { ...base, SSO_CORP_ISSUER: "https://idp.example.com/?tenant=1" },
      /query/,
    ],
    [
      "an issuer with a fragment",
      { ...base, SSO_CORP_ISSUER: "https://idp.example.com/#x" },
      /fragment/,
    ],
    [
      "an issuer with credentials",
      { ...base, SSO_CORP_ISSUER: "https://user:pw@idp.example.com" },
      /credentials/,
    ],
    [
      "an issuer that is too long",
      {
        ...base,
        SSO_CORP_ISSUER: `https://idp.example.com/${"a".repeat(MAX_SSO_ISSUER_LENGTH)}`,
      },
      /at most 250/,
    ],
    [
      "a missing client id",
      { ...base, SSO_CORP_CLIENT_ID: "" },
      /SSO_CORP_CLIENT_ID must be set/,
    ],
    [
      "a client id with a space",
      { ...base, SSO_CORP_CLIENT_ID: "bun mail" },
      /SSO_CORP_CLIENT_ID/,
    ],
    [
      "a missing client secret",
      { ...base, SSO_CORP_CLIENT_SECRET: undefined },
      /SSO_CORP_CLIENT_SECRET must be set/,
    ],
    [
      "a client secret with a line break",
      { ...base, SSO_CORP_CLIENT_SECRET: "abc\ndef" },
      /SSO_CORP_CLIENT_SECRET/,
    ],
    ["a label over 64 characters", { ...base, SSO_CORP_LABEL: "x".repeat(65) }, /LABEL/],
    [
      "a label with a control character",
      { ...base, SSO_CORP_LABEL: "Corp\u0007" },
      /LABEL/,
    ],
    ["scopes without openid", { ...base, SSO_CORP_SCOPES: "email profile" }, /"openid"/],
    [
      "a scope with a quote",
      { ...base, SSO_CORP_SCOPES: 'openid "email"' },
      /scope names/,
    ],
    [
      "an allowed domain with @",
      { ...base, SSO_CORP_ALLOWED_DOMAINS: "@example.com" },
      /DOMAINS/,
    ],
    [
      "a wildcard allowed domain",
      { ...base, SSO_CORP_ALLOWED_DOMAINS: "*.example.com" },
      /DOMAINS/,
    ],
    [
      "a single-label allowed domain",
      { ...base, SSO_CORP_ALLOWED_DOMAINS: "corp" },
      /DOMAINS/,
    ],
    ["a non-boolean auto-link", { ...base, SSO_CORP_AUTO_LINK: "yes" }, /AUTO_LINK/],
    [
      "auto-link without allowed domains",
      { ...base, SSO_CORP_AUTO_LINK: "true" },
      /AUTO_LINK=true needs SSO_CORP_ALLOWED_DOMAINS/,
    ],
    [
      "auto-link for a Microsoft Entra issuer (login.microsoftonline.com)",
      {
        ...base,
        SSO_CORP_ISSUER: "https://login.microsoftonline.com/0000-tenant/v2.0",
        SSO_CORP_ALLOWED_DOMAINS: "example.com",
        SSO_CORP_AUTO_LINK: "true",
      },
      /AUTO_LINK=true is not allowed for a Microsoft Entra issuer \(login\.microsoftonline\.com\)/,
    ],
    [
      "auto-link for a Microsoft Entra v1 issuer (sts.windows.net)",
      {
        ...base,
        SSO_CORP_ISSUER: "https://STS.windows.net/0000-tenant/",
        SSO_CORP_ALLOWED_DOMAINS: "example.com",
        SSO_CORP_AUTO_LINK: "true",
      },
      /not allowed for a Microsoft Entra issuer \(sts\.windows\.net\)/,
    ],
    [
      "auto-link for a sovereign Microsoft Entra issuer (login.microsoftonline.us)",
      {
        ...base,
        SSO_CORP_ISSUER: "https://login.microsoftonline.us/0000-tenant/v2.0",
        SSO_CORP_ALLOWED_DOMAINS: "example.com",
        SSO_CORP_AUTO_LINK: "true",
      },
      /not allowed for a Microsoft Entra issuer \(login\.microsoftonline\.us\)/,
    ],
  ];

  for (const [name, env, message] of refusals) {
    test(`refuses ${name}`, () => {
      expect(() => readSsoSettings(env)).toThrow(message);
    });
  }

  test("a Microsoft Entra issuer is accepted with auto-link off (explicit links only)", () => {
    const settings = readSsoSettings({
      ...base,
      SSO_CORP_ISSUER: "https://login.microsoftonline.com/0000-tenant/v2.0",
      SSO_CORP_ALLOWED_DOMAINS: "example.com",
    });
    expect(settings.providers[0]?.autoLink).toBe(false);
  });

  test("a refused client secret is never echoed", () => {
    const secret = "has a space";
    let message = "";
    try {
      readSsoSettings({ ...base, SSO_CORP_CLIENT_SECRET: secret });
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("SSO_CORP_CLIENT_SECRET");
    expect(message).not.toContain(secret);
  });

  test("a refused issuer never echoes credentials or a query (L1)", () => {
    for (const issuer of [
      "https://user:hunter2@idp.example.com",
      "https://idp.example.com/?token=hunter2",
      "https://idp.example.com/#hunter2",
      "hunter2 is not a url",
    ]) {
      let message = "";
      try {
        readSsoSettings({ ...base, SSO_CORP_ISSUER: issuer });
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain("SSO_CORP_ISSUER");
      expect(message).not.toContain("hunter2");
    }
  });

  test("an allowed domain with a look-alike that Unicode folds into ASCII is refused", () => {
    expect(() =>
      readSsoSettings({ ...base, SSO_CORP_ALLOWED_DOMAINS: "\u212Aorp.com" }),
    ).toThrow(/DOMAINS/);
  });

  test("a malformed provider refuses to boot even when SSO would be off", () => {
    expect(() =>
      readSsoSettings({ ...base, APP_BASE_URL: "", SSO_CORP_ISSUER: "nope" }),
    ).toThrow(/SSO_CORP_ISSUER/);
  });
});

describe("readSsoSettings: presets (google, gitlab)", () => {
  const google: Record<string, string | undefined> = {
    APP_BASE_URL: "https://mail.example.com",
    SSO_PROVIDERS: "google",
    SSO_GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
    SSO_GOOGLE_CLIENT_SECRET: "GOCSPX-abc",
  };

  test("google with only a client id and secret: Google's issuer and label", () => {
    const [provider] = readSsoSettings(google).providers;
    expect(provider?.id).toBe("google");
    expect(provider?.issuer).toBe("https://accounts.google.com");
    expect(provider?.label).toBe("Google");
    expect(provider?.scopes).toBe(DEFAULT_SSO_SCOPES);
  });

  test("gitlab with only a client id and secret: gitlab.com's issuer and label", () => {
    const [provider] = readSsoSettings({
      APP_BASE_URL: "https://mail.example.com",
      SSO_PROVIDERS: "gitlab",
      SSO_GITLAB_CLIENT_ID: "app-id",
      SSO_GITLAB_CLIENT_SECRET: "gloas-secret",
    }).providers;
    expect(provider?.issuer).toBe("https://gitlab.com");
    expect(provider?.label).toBe("GitLab");
  });

  test("an explicit issuer and label win over the preset (self-hosted GitLab)", () => {
    const [provider] = readSsoSettings({
      APP_BASE_URL: "https://mail.example.com",
      SSO_PROVIDERS: "gitlab",
      SSO_GITLAB_ISSUER: "https://gitlab.example.com",
      SSO_GITLAB_LABEL: "Company GitLab",
      SSO_GITLAB_CLIENT_ID: "app-id",
      SSO_GITLAB_CLIENT_SECRET: "gloas-secret",
    }).providers;
    expect(provider?.issuer).toBe("https://gitlab.example.com");
    expect(provider?.label).toBe("Company GitLab");
  });

  test("a blank issuer or label falls back to the preset", () => {
    const [provider] = readSsoSettings({
      ...google,
      SSO_GOOGLE_ISSUER: "  ",
      SSO_GOOGLE_LABEL: "",
    }).providers;
    expect(provider?.issuer).toBe("https://accounts.google.com");
    expect(provider?.label).toBe("Google");
  });

  test("an explicit issuer on a preset is validated as any other", () => {
    expect(() =>
      readSsoSettings({ ...google, SSO_GOOGLE_ISSUER: "http://accounts.google.com" }),
    ).toThrow(/SSO_GOOGLE_ISSUER must be an https:\/\/ URL/);
  });

  test("a non-preset id without an issuer still refuses to boot", () => {
    for (const id of ["microsoft", "okta", "keycloak"]) {
      const prefix = `SSO_${id.toUpperCase()}_`;
      expect(() =>
        readSsoSettings({
          APP_BASE_URL: "https://mail.example.com",
          SSO_PROVIDERS: id,
          [`${prefix}CLIENT_ID`]: "client",
          [`${prefix}CLIENT_SECRET`]: "secret",
        }),
      ).toThrow(new RegExp(`${prefix}ISSUER must be set`));
    }
  });

  test("the default Google issuer still feeds the duplicate-issuer refusal", () => {
    expect(() =>
      readSsoSettings({
        ...google,
        SSO_PROVIDERS: "google,google-ws",
        SSO_GOOGLE_WS_ISSUER: "https://accounts.google.com",
        SSO_GOOGLE_WS_CLIENT_ID: "456.apps.googleusercontent.com",
        SSO_GOOGLE_WS_CLIENT_SECRET: "GOCSPX-def",
      }),
    ).toThrow(/SSO_GOOGLE_WS_ISSUER is also the issuer of "google"/);
  });
});

describe("readSsoSettings: the client credentials are the switch", () => {
  test("google is enabled by its credentials alone, without SSO_PROVIDERS", () => {
    const settings = readSsoSettings({
      APP_BASE_URL: "https://mail.example.com",
      SSO_GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
      SSO_GOOGLE_CLIENT_SECRET: "GOCSPX-abc",
    });
    expect(settings.providers.map((provider) => provider.id)).toEqual(["google"]);
    expect(settings.providers[0]?.issuer).toBe("https://accounts.google.com");
    expect(settings.skipped).toEqual([]);
  });

  test("unlisted presets follow the listed providers, in preset order", () => {
    const settings = readSsoSettings({
      ...base,
      SSO_GITLAB_CLIENT_ID: "app-id",
      SSO_GITLAB_CLIENT_SECRET: "gloas-secret",
      SSO_GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
      SSO_GOOGLE_CLIENT_SECRET: "GOCSPX-abc",
    });
    expect(settings.providers.map((provider) => provider.id)).toEqual([
      "corp",
      "google",
      "gitlab",
    ]);
  });

  test("google without credentials: no provider and nothing skipped (no warning)", () => {
    const settings = readSsoSettings({
      APP_BASE_URL: "https://mail.example.com",
      SSO_GOOGLE_CLIENT_ID: " ",
      SSO_GOOGLE_LABEL: "Google",
    });
    expect(settings).toEqual({
      providers: [],
      skipped: [],
      baseUrl: "https://mail.example.com",
    });
  });

  test("a listed provider without credentials is skipped, named with its missing variables", () => {
    const settings = readSsoSettings({
      ...base,
      SSO_CORP_CLIENT_ID: undefined,
      SSO_CORP_CLIENT_SECRET: "   ",
    });
    expect(settings.providers).toEqual([]);
    expect(settings.skipped).toEqual([
      { id: "corp", missing: ["SSO_CORP_CLIENT_ID", "SSO_CORP_CLIENT_SECRET"] },
    ]);
  });

  test("a listed google without credentials is skipped, not given the preset", () => {
    const settings = readSsoSettings({ ...base, SSO_PROVIDERS: "google" });
    expect(settings.providers).toEqual([]);
    expect(settings.skipped.map((skipped) => skipped.id)).toEqual(["google"]);
  });

  test("a configured provider and an unconfigured one: only the configured one", () => {
    const settings = readSsoSettings({
      ...base,
      SSO_PROVIDERS: "corp,okta",
      SSO_OKTA_ISSUER: "https://example.okta.com",
    });
    expect(settings.providers.map((provider) => provider.id)).toEqual(["corp"]);
    expect(settings.skipped.map((skipped) => skipped.id)).toEqual(["okta"]);
  });

  test("a half-configured provider refuses to boot, naming the missing variable", () => {
    expect(() =>
      readSsoSettings({
        APP_BASE_URL: "https://mail.example.com",
        SSO_GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
      }),
    ).toThrow(/SSO_GOOGLE_CLIENT_SECRET must be set/);
    expect(() =>
      readSsoSettings({
        APP_BASE_URL: "https://mail.example.com",
        SSO_PROVIDERS: "google",
        SSO_GOOGLE_CLIENT_SECRET: "GOCSPX-abc",
      }),
    ).toThrow(/SSO_GOOGLE_CLIENT_ID must be set/);
    expect(() => readSsoSettings({ ...base, SSO_CORP_CLIENT_SECRET: "" })).toThrow(
      /SSO_CORP_CLIENT_SECRET must be set/,
    );
  });

  test("a skipped provider's id and duplicates are still checked", () => {
    expect(() => readSsoSettings({ SSO_PROVIDERS: "google,google" })).toThrow(
      /lists "google" twice/,
    );
    expect(() => readSsoSettings({ SSO_PROVIDERS: "Bad_Id" })).toThrow(
      /SSO_PROVIDERS entries/,
    );
  });
});

describe("ssoBaseUrlFrom", () => {
  test("https, or http on a loopback host, without a trailing slash", () => {
    expect(ssoBaseUrlFrom("https://mail.example.com/")).toBe("https://mail.example.com");
    expect(ssoBaseUrlFrom(" https://example.com/bunmail ")).toBe(
      "https://example.com/bunmail",
    );
    expect(ssoBaseUrlFrom("http://localhost:3000")).toBe("http://localhost:3000");
    expect(ssoBaseUrlFrom("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
  });

  test("null (SSO off) for anything else", () => {
    for (const raw of [
      "",
      "   ",
      "mail.example.com",
      "http://mail.example.com",
      "ftp://mail.example.com",
      "https://mail.example.com/?x=1",
      "https://mail.example.com/#top",
      "https://user:pw@mail.example.com",
    ]) {
      expect(ssoBaseUrlFrom(raw)).toBeNull();
    }
  });

  test("providers with an http base URL: configured, but SSO is off", () => {
    const settings = readSsoSettings({
      ...base,
      APP_BASE_URL: "http://mail.example.com",
    });
    expect(settings.providers).toHaveLength(1);
    expect(settings.baseUrl).toBeNull();
  });
});
