import { describe, test, expect } from "bun:test";
import {
  deriveTrackingKeys,
  mintClickToken,
  mintOpenToken,
  trackableUrl,
  verifyClickToken,
  verifyOpenToken,
} from "../../src/modules/tracking/services/tracking-token.ts";
import {
  deriveUnsubscribeKey,
  mintUnsubscribeToken,
  parseUnsubscribeToken,
  unsubscribeMacMatches,
} from "../../src/modules/suppressions/services/unsubscribe-token.ts";

/**
 * Open and click tracking tokens (#187): deterministic, MAC-bound to the
 * email (and, for a click, the link and its URL), strict parsing, and no
 * token of one kind ever passes as another.
 */

const keys = deriveTrackingKeys(Buffer.alloc(32, 7));
const otherKeys = deriveTrackingKeys(Buffer.alloc(32, 8));
const EMAIL = "msg_0123456789abcdef01234567";
const OTHER_EMAIL = "msg_fedcba9876543210fedcba98";
const RECIPIENT = "user@example.org";
const URL_ = "https://example.com/pricing?utm_source=mail#plans";

/** A click token for the defaults, which must exist. */
function click(
  overrides: Partial<{ emailId: string; position: number; url: string }> = {},
): string {
  const token = mintClickToken(
    { emailId: EMAIL, position: 2, url: URL_, ...overrides },
    keys,
  );
  if (token === null) throw new Error("expected a token");
  return token;
}

/** Flips one hex character of `token` at `index`. */
function flip(token: string, index: number): string {
  const c = token[index] === "0" ? "1" : "0";
  return token.slice(0, index) + c + token.slice(index + 1);
}

describe("deriveTrackingKeys", () => {
  test("open and click keys differ from each other and from the unsubscribe key", () => {
    const master = Buffer.alloc(32, 7);
    expect(keys.open.equals(keys.click)).toBe(false);
    expect(keys.open.equals(deriveUnsubscribeKey(master))).toBe(false);
    expect(keys.click.equals(deriveUnsubscribeKey(master))).toBe(false);
  });
});

describe("open tokens", () => {
  test("round trip: deterministic, 57 characters, verifies without a database", () => {
    const token = mintOpenToken(EMAIL, keys);
    expect(token).toBe(mintOpenToken(EMAIL, keys));
    expect(token).toHaveLength(57);
    expect(verifyOpenToken(token ?? "", keys)).toBe(EMAIL);
    expect(verifyOpenToken((token ?? "").toUpperCase(), keys)).toBe(EMAIL);
    expect(verifyOpenToken(token ?? "", otherKeys)).toBeNull();
  });

  test("an id that is not msg_<24 hex> gets no token", () => {
    expect(mintOpenToken("msg_xyz", keys)).toBeNull();
  });

  test("malformed, truncated or extended tokens do not verify", () => {
    const token = mintOpenToken(EMAIL, keys)!;
    expect(verifyOpenToken(token.slice(0, -1), keys)).toBeNull();
    expect(verifyOpenToken(`${token}0`, keys)).toBeNull();
    expect(verifyOpenToken(token.replace(".", "-"), keys)).toBeNull();
    expect(verifyOpenToken("", keys)).toBeNull();
    expect(verifyOpenToken("x".repeat(10_000), keys)).toBeNull();
  });

  test("a tampered MAC or another email's id does not verify", () => {
    const token = mintOpenToken(EMAIL, keys)!;
    expect(verifyOpenToken(flip(token, token.length - 1), keys)).toBeNull();
    const other = mintOpenToken(OTHER_EMAIL, keys)!;
    expect(verifyOpenToken(`${EMAIL.slice(4)}.${other.split(".")[1]}`, keys)).toBeNull();
  });
});

describe("click tokens", () => {
  test("round trip: deterministic, names the email, position and exact URL", () => {
    const token = click();
    expect(token).toBe(click());
    expect(verifyClickToken(token, keys)).toEqual({
      emailId: EMAIL,
      position: 2,
      url: URL_,
    });
    expect(verifyClickToken(token, otherKeys)).toBeNull();
  });

  test("tampering with any part fails", () => {
    const token = click();
    const [hex, position, encoded, mac] = token.split(".");
    expect(verifyClickToken(flip(token, 0), keys)).toBeNull();
    expect(verifyClickToken(`${hex}.3.${encoded}.${mac}`, keys)).toBeNull();
    const evil = Buffer.from("https://evil.example/").toString("base64url");
    expect(verifyClickToken(`${hex}.${position}.${evil}.${mac}`, keys)).toBeNull();
    expect(verifyClickToken(flip(token, token.length - 1), keys)).toBeNull();
    /** Another email's id with this MAC. */
    expect(
      verifyClickToken(`${OTHER_EMAIL.slice(4)}.${position}.${encoded}.${mac}`, keys),
    ).toBeNull();
  });

  test("truncated, padded or oversized tokens fail", () => {
    const token = click();
    expect(verifyClickToken(token.slice(0, -1), keys)).toBeNull();
    expect(verifyClickToken(`${token}0`, keys)).toBeNull();
    const [hex, position, encoded, mac] = token.split(".");
    expect(verifyClickToken(`${hex}.${position}.${encoded}=.${mac}`, keys)).toBeNull();
    expect(verifyClickToken(`${hex}.02.${encoded}.${mac}`, keys)).toBeNull();
    expect(verifyClickToken("a".repeat(5000), keys)).toBeNull();
  });

  test("only canonical http(s) URLs of at most 2048 characters are ever signed", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "mailto:user@example.org",
      "ftp://example.com/",
      "/relative",
      "https://Example.COM/",
      "https://example.com",
      `https://example.com/${"a".repeat(2048)}`,
    ]) {
      expect(mintClickToken({ emailId: EMAIL, position: 0, url }, keys)).toBeNull();
    }
    expect(trackableUrl("https://example.com/")).toBe("https://example.com/");
    expect(trackableUrl("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
  });

  test("a token whose payload decodes to a non-http URL never verifies, even with a valid-looking MAC", () => {
    const [hex, position, , mac] = click().split(".");
    const js = Buffer.from("javascript:alert(1)").toString("base64url");
    expect(verifyClickToken(`${hex}.${position}.${js}.${mac}`, keys)).toBeNull();
  });

  test("positions are 0 to 99", () => {
    expect(mintClickToken({ emailId: EMAIL, position: -1, url: URL_ }, keys)).toBeNull();
    expect(mintClickToken({ emailId: EMAIL, position: 100, url: URL_ }, keys)).toBeNull();
    expect(mintClickToken({ emailId: EMAIL, position: 1.5, url: URL_ }, keys)).toBeNull();
    expect(verifyClickToken(click({ position: 99 }), keys)?.position).toBe(99);
  });
});

describe("no token passes as another kind", () => {
  test("an open token is not a click token and the reverse", () => {
    const open = mintOpenToken(EMAIL, keys)!;
    expect(verifyClickToken(open, keys)).toBeNull();
    expect(verifyOpenToken(click(), keys)).toBeNull();
  });

  test("an unsubscribe token is not an open token, and an open token not an unsubscribe one", () => {
    const master = Buffer.alloc(32, 7);
    const unsubscribeKey = deriveUnsubscribeKey(master);
    const unsubscribe = mintUnsubscribeToken(
      { emailId: EMAIL, recipient: RECIPIENT },
      unsubscribeKey,
    )!;
    expect(verifyOpenToken(unsubscribe, keys)).toBeNull();
    const open = mintOpenToken(EMAIL, keys)!;
    const asUnsubscribe = parseUnsubscribeToken(open)!;
    expect(
      unsubscribeMacMatches(
        { emailId: EMAIL, recipient: RECIPIENT },
        asUnsubscribe.mac,
        unsubscribeKey,
      ),
    ).toBe(false);
  });
});
