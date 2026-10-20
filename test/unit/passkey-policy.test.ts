import { describe, test, expect } from "bun:test";
import {
  PASSKEY_NAME_MAX_LENGTH,
  PASSKEY_RESPONSE_MAX_LENGTH,
  counterRegressed,
  parseAuthenticationResponse,
  parseRegistrationResponse,
  passkeyNameProblem,
  relyingPartyFrom,
  transportsFromColumn,
  transportsToColumn,
  userHandleOf,
} from "../../src/modules/users/services/passkey-policy.service.ts";
import {
  PASSKEYS_PAGE,
  TWO_FACTOR_PAGE,
  isTwoFactorEnrolmentPath,
} from "../../src/modules/users/services/two-factor-policy.service.ts";

/**
 * The pure passkey rules (#223): the relying party from `APP_BASE_URL`,
 * the name policy, the clone-detection counter rule, the transports
 * allowlist and the parsing of the browser's credential JSON.
 */

describe("relyingPartyFrom", () => {
  test("the RP ID is the hostname and the origin is exact (scheme, host, port)", () => {
    expect(relyingPartyFrom("https://mail.example.com")).toEqual({
      rpID: "mail.example.com",
      origin: "https://mail.example.com",
    });
    expect(relyingPartyFrom("https://mail.example.com:8443/some/path/")).toEqual({
      rpID: "mail.example.com",
      origin: "https://mail.example.com:8443",
    });
    expect(relyingPartyFrom("  https://Mail.Example.com  ")).toEqual({
      rpID: "mail.example.com",
      origin: "https://mail.example.com",
    });
    expect(relyingPartyFrom("http://localhost:3000")).toEqual({
      rpID: "localhost",
      origin: "http://localhost:3000",
    });
  });

  test("unset, malformed, non-http(s) and plain http off localhost disable passkeys", () => {
    for (const value of [
      "",
      "   ",
      "mail.example.com",
      "ftp://mail.example.com",
      "http://mail.example.com",
      "http://127.0.0.1:3000",
      "not a url",
    ]) {
      expect(relyingPartyFrom(value)).toBeNull();
    }
  });
});

describe("passkeyNameProblem", () => {
  test("1 to 64 characters, no control characters", () => {
    expect(passkeyNameProblem("Laptop")).toBeNull();
    expect(passkeyNameProblem("x".repeat(PASSKEY_NAME_MAX_LENGTH))).toBeNull();
    expect(passkeyNameProblem('<b>Key</b> & "quotes"')).toBeNull();
    expect(passkeyNameProblem("")).toBe("Give the passkey a name.");
    expect(passkeyNameProblem("x".repeat(PASSKEY_NAME_MAX_LENGTH + 1))).toBe(
      "The name can be at most 64 characters.",
    );
    expect(passkeyNameProblem("line\nbreak")).toBe(
      "The name cannot contain control characters.",
    );
    expect(passkeyNameProblem("nul\u0000")).toBe(
      "The name cannot contain control characters.",
    );
  });
});

describe("counterRegressed", () => {
  test("a counter that stays 0 is fine; otherwise it must grow", () => {
    expect(counterRegressed(0, 0)).toBe(false);
    expect(counterRegressed(0, 1)).toBe(false);
    expect(counterRegressed(5, 6)).toBe(false);
    expect(counterRegressed(5, 5)).toBe(true);
    expect(counterRegressed(5, 4)).toBe(true);
    /** A counting authenticator that suddenly reports 0: a clone, or a reset key. */
    expect(counterRegressed(5, 0)).toBe(true);
    expect(counterRegressed(4294967294, 4294967295)).toBe(false);
  });
});

describe("transports", () => {
  test("only known values are stored, deduplicated, in a stable order", () => {
    expect(transportsToColumn(["usb", "internal", "usb", "bogus", 7])).toBe(
      "internal,usb",
    );
    expect(transportsToColumn([])).toBeNull();
    expect(transportsToColumn(undefined)).toBeNull();
    expect(transportsFromColumn("internal,usb,<script>")).toEqual(["internal", "usb"]);
    expect(transportsFromColumn(null)).toEqual([]);
  });
});

/** A well-formed registration result, as `dashboard.js` posts it. */
const registration = {
  id: "Y3JlZA",
  rawId: "Y3JlZA",
  type: "public-key",
  response: {
    clientDataJSON: "e30",
    attestationObject: "o2NmbXRkbm9uZQ",
    transports: ["internal", "made-up"],
  },
  clientExtensionResults: { credProps: { rk: true } },
};

/** A well-formed assertion. */
const assertion = {
  id: "Y3JlZA",
  rawId: "Y3JlZA",
  type: "public-key",
  response: {
    clientDataJSON: "e30",
    authenticatorData: "AAAA",
    signature: "MEUC",
    userHandle: "dXNyXzE",
  },
  clientExtensionResults: {},
};

describe("parseRegistrationResponse", () => {
  test("keeps the fields verification reads, drops unknown transports and extensions", () => {
    expect(parseRegistrationResponse(JSON.stringify(registration))).toEqual({
      id: "Y3JlZA",
      rawId: "Y3JlZA",
      type: "public-key",
      response: {
        clientDataJSON: "e30",
        attestationObject: "o2NmbXRkbm9uZQ",
        transports: ["internal"],
      },
      clientExtensionResults: {},
    });
  });

  test("refuses anything else", () => {
    const bad = [
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify({ ...registration, type: "password" }),
      JSON.stringify({ ...registration, rawId: "b3RoZXI" }),
      JSON.stringify({ ...registration, id: "has spaces" }),
      JSON.stringify({ ...registration, response: { clientDataJSON: "e30" } }),
      JSON.stringify({ ...registration, response: "x" }),
      "x".repeat(PASSKEY_RESPONSE_MAX_LENGTH + 1),
    ];
    for (const raw of bad) expect(parseRegistrationResponse(raw)).toBeNull();
  });
});

describe("parseAuthenticationResponse", () => {
  test("parses an assertion, with or without a user handle", () => {
    expect(parseAuthenticationResponse(JSON.stringify(assertion))).toEqual({
      ...assertion,
      type: "public-key",
    });
    const { userHandle: _dropped, ...withoutHandle } = assertion.response;
    for (const handle of [undefined, null, ""]) {
      const parsed = parseAuthenticationResponse(
        JSON.stringify({
          ...assertion,
          response: { ...withoutHandle, userHandle: handle },
        }),
      );
      expect(parsed?.response.userHandle).toBeUndefined();
    }
  });

  test("refuses a missing signature, a non-base64url field or a bad user handle", () => {
    const bad = [
      { ...assertion, response: { ...assertion.response, signature: undefined } },
      { ...assertion, response: { ...assertion.response, authenticatorData: "a+b/" } },
      { ...assertion, response: { ...assertion.response, userHandle: 42 } },
      { ...assertion, response: { ...assertion.response, userHandle: "not base64url!" } },
    ];
    for (const value of bad) {
      expect(parseAuthenticationResponse(JSON.stringify(value))).toBeNull();
    }
  });
});

describe("userHandleOf", () => {
  test("the bytes of the account id", () => {
    expect(new TextDecoder().decode(userHandleOf("usr_abc"))).toBe("usr_abc");
  });
});

describe("REQUIRE_2FA enrolment paths (#223)", () => {
  test("the Passkeys page and its actions stay open, like the Two-factor page", () => {
    for (const path of [
      TWO_FACTOR_PAGE,
      `${TWO_FACTOR_PAGE}/start`,
      PASSKEYS_PAGE,
      `${PASSKEYS_PAGE}/options`,
      `${PASSKEYS_PAGE}/crd_x/delete`,
    ]) {
      expect(isTwoFactorEnrolmentPath(path)).toBe(true);
    }
    for (const path of [
      "/dashboard/emails",
      `${PASSKEYS_PAGE}-evil`,
      "/dashboard/account",
    ]) {
      expect(isTwoFactorEnrolmentPath(path)).toBe(false);
    }
  });
});
