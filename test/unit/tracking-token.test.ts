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
import { legacyClickToken } from "../legacy-click-token.ts";

/**
 * Open and click tracking tokens (#187): deterministic, MAC-bound to the
 * email (and, for a click, the link, its URL, and since #424 the sender
 * domain and its tracking epoch), strict parsing, links minted before
 * #424 (v1) still verifying, and no token of one kind ever passes as
 * another.
 */

const keys = deriveTrackingKeys(Buffer.alloc(32, 7));
const otherKeys = deriveTrackingKeys(Buffer.alloc(32, 8));
const EMAIL = "msg_0123456789abcdef01234567";
const OTHER_EMAIL = "msg_fedcba9876543210fedcba98";
const RECIPIENT = "user@example.org";
const URL_ = "https://example.com/pricing?utm_source=mail#plans";
const DOMAIN = { domainId: "dom_00112233445566778899aabb", epoch: 0 };
const OTHER_DOMAIN_ID = "dom_ffeeddccbbaa998877665544";

/** A click token for the defaults, which must exist. */
function click(
  overrides: Partial<{ emailId: string; position: number; url: string }> = {},
  domain: { domainId: string; epoch: number } = DOMAIN,
): string {
  const token = mintClickToken(
    { emailId: EMAIL, position: 2, url: URL_, ...overrides },
    domain,
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
  test("round trip: deterministic, names the email, position, exact URL, domain and epoch", () => {
    const token = click();
    expect(token).toBe(click());
    expect(verifyClickToken(token, keys)).toEqual({
      emailId: EMAIL,
      position: 2,
      url: URL_,
      domainId: DOMAIN.domainId,
      epoch: 0,
      version: 2,
    });
    expect(verifyClickToken(token, otherKeys)).toBeNull();
  });

  test("the domain and epoch are part of the token and of its MAC (#424)", () => {
    const token = click({}, { domainId: DOMAIN.domainId, epoch: 7 });
    const [hex, position, encoded, domainHex, epoch, mac] = token.split(".");
    expect(domainHex).toBe(DOMAIN.domainId.slice(4));
    expect(epoch).toBe("7");
    expect(verifyClickToken(token, keys)).toMatchObject({ epoch: 7, version: 2 });
    /** Another epoch, or another domain, with this MAC. */
    for (const forged of [
      `${hex}.${position}.${encoded}.${domainHex}.0.${mac}`,
      `${hex}.${position}.${encoded}.${domainHex}.8.${mac}`,
      `${hex}.${position}.${encoded}.${OTHER_DOMAIN_ID.slice(4)}.${epoch}.${mac}`,
    ]) {
      expect(verifyClickToken(forged, keys)).toBeNull();
    }
    /** Epochs written another way, or out of range. */
    expect(
      verifyClickToken(`${hex}.${position}.${encoded}.${domainHex}.07.${mac}`, keys),
    ).toBeNull();
    expect(
      verifyClickToken(
        `${hex}.${position}.${encoded}.${domainHex}.99999999999.${mac}`,
        keys,
      ),
    ).toBeNull();
  });

  test("only dom_<24 hex> domain ids and epochs 0 to 2^31 - 1 get a token", () => {
    const subject = { emailId: EMAIL, position: 0, url: URL_ };
    for (const domain of [
      { domainId: "dom_xyz", epoch: 0 },
      { domainId: "msg_00112233445566778899aabb", epoch: 0 },
      { ...DOMAIN, epoch: -1 },
      { ...DOMAIN, epoch: 1.5 },
      { ...DOMAIN, epoch: 2_147_483_648 },
    ]) {
      expect(mintClickToken(subject, domain, keys)).toBeNull();
    }
    const max = mintClickToken(subject, { ...DOMAIN, epoch: 2_147_483_647 }, keys);
    expect(verifyClickToken(max ?? "", keys)).toMatchObject({ epoch: 2_147_483_647 });
  });

  test("a v1 token (minted before #424) still verifies, as version 1 without a domain", () => {
    const legacy = legacyClickToken({ emailId: EMAIL, position: 2, url: URL_ }, keys);
    expect(verifyClickToken(legacy, keys)).toEqual({
      emailId: EMAIL,
      position: 2,
      url: URL_,
      version: 1,
    });
    expect(verifyClickToken(legacy, otherKeys)).toBeNull();
    const [hex, position, encoded, mac] = legacy.split(".");
    expect(verifyClickToken(`${hex}.3.${encoded}.${mac}`, keys)).toBeNull();
    /** A v1 MAC with a domain and epoch added never passes as v2. */
    expect(
      verifyClickToken(
        `${hex}.${position}.${encoded}.${DOMAIN.domainId.slice(4)}.0.${mac}`,
        keys,
      ),
    ).toBeNull();
    /** A v2 MAC with the domain and epoch removed never passes as v1. */
    const [, , , , , v2Mac] = click().split(".");
    expect(verifyClickToken(`${hex}.${position}.${encoded}.${v2Mac}`, keys)).toBeNull();
  });

  test("tampering with any part fails", () => {
    const token = click();
    const [hex, position, encoded, domainHex, epoch, mac] = token.split(".");
    const tail = `${domainHex}.${epoch}.${mac}`;
    expect(verifyClickToken(flip(token, 0), keys)).toBeNull();
    expect(verifyClickToken(`${hex}.3.${encoded}.${tail}`, keys)).toBeNull();
    const evil = Buffer.from("https://evil.example/").toString("base64url");
    expect(verifyClickToken(`${hex}.${position}.${evil}.${tail}`, keys)).toBeNull();
    expect(verifyClickToken(flip(token, token.length - 1), keys)).toBeNull();
    /** Another email's id with this MAC. */
    expect(
      verifyClickToken(`${OTHER_EMAIL.slice(4)}.${position}.${encoded}.${tail}`, keys),
    ).toBeNull();
  });

  test("truncated, padded or oversized tokens fail", () => {
    const token = click();
    expect(verifyClickToken(token.slice(0, -1), keys)).toBeNull();
    expect(verifyClickToken(`${token}0`, keys)).toBeNull();
    const [hex, position, encoded, domainHex, epoch, mac] = token.split(".");
    const tail = `${domainHex}.${epoch}.${mac}`;
    expect(verifyClickToken(`${hex}.${position}.${encoded}=.${tail}`, keys)).toBeNull();
    expect(verifyClickToken(`${hex}.02.${encoded}.${tail}`, keys)).toBeNull();
    expect(verifyClickToken("a".repeat(5000), keys)).toBeNull();
  });

  test("the longest URL still makes a token that verifies", () => {
    const url = `https://example.com/${"a".repeat(2048 - "https://example.com/".length)}`;
    const token = click({ url }, { ...DOMAIN, epoch: 2_147_483_647 });
    expect(verifyClickToken(token, keys)?.url).toBe(url);
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
      expect(
        mintClickToken({ emailId: EMAIL, position: 0, url }, DOMAIN, keys),
      ).toBeNull();
    }
    expect(trackableUrl("https://example.com/")).toBe("https://example.com/");
    expect(trackableUrl("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
  });

  test("a token whose payload decodes to a non-http URL never verifies, even with a valid-looking MAC", () => {
    const [hex, position, , domainHex, epoch, mac] = click().split(".");
    const js = Buffer.from("javascript:alert(1)").toString("base64url");
    expect(
      verifyClickToken(`${hex}.${position}.${js}.${domainHex}.${epoch}.${mac}`, keys),
    ).toBeNull();
  });

  test("positions are 0 to 99", () => {
    expect(
      mintClickToken({ emailId: EMAIL, position: -1, url: URL_ }, DOMAIN, keys),
    ).toBeNull();
    expect(
      mintClickToken({ emailId: EMAIL, position: 100, url: URL_ }, DOMAIN, keys),
    ).toBeNull();
    expect(
      mintClickToken({ emailId: EMAIL, position: 1.5, url: URL_ }, DOMAIN, keys),
    ).toBeNull();
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
