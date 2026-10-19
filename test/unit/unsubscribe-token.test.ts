import { describe, test, expect } from "bun:test";
import { randomBytes } from "crypto";
import {
  UNSUBSCRIBE_TOKEN_LENGTH,
  deriveUnsubscribeKey,
  mintUnsubscribeToken,
  parseUnsubscribeToken,
  soleRecipient,
  tokenFromUnsubscribeAddress,
  unsubscribeLocalPart,
  unsubscribeMacMatches,
  type UnsubscribeTokenSubject,
} from "../../src/modules/suppressions/services/unsubscribe-token.ts";
import { generateId } from "../../src/utils/id.ts";

/**
 * Per-recipient unsubscribe tokens (#249): stateless HMAC over email id,
 * recipient and API key, lowercase hex, short enough for a mailto local
 * part.
 */

const subject: UnsubscribeTokenSubject = {
  emailId: "msg_0123456789abcdef01234567",
  recipient: "user@example.org",
};

/** Mints a token, failing the test if none comes back. */
function mint(s: UnsubscribeTokenSubject = subject, key?: Buffer): string {
  const token = mintUnsubscribeToken(s, key);
  if (token === null) throw new Error("expected a token");
  return token;
}

/** Parses and checks a presented token against `s`, like the service does. */
function verifies(token: string, s: UnsubscribeTokenSubject, key?: Buffer): boolean {
  const parsed = parseUnsubscribeToken(token);
  if (!parsed) return false;
  return (
    unsubscribeMacMatches({ ...s, emailId: parsed.emailId }, parsed.mac, key) &&
    parsed.emailId === s.emailId
  );
}

/** `token` with the character at `index` replaced by a different hex digit. */
function flip(token: string, index: number): string {
  const replacement = token[index] === "0" ? "1" : "0";
  return token.slice(0, index) + replacement + token.slice(index + 1);
}

describe("unsubscribe token", () => {
  test("round trip: a minted token parses back to its email and verifies", () => {
    const token = mint();
    expect(token).toHaveLength(UNSUBSCRIBE_TOKEN_LENGTH);
    expect(token).toMatch(/^[0-9a-f]{24}\.[0-9a-f]{32}$/);
    expect(parseUnsubscribeToken(token)?.emailId).toBe(subject.emailId);
    expect(verifies(token, subject)).toBe(true);
  });

  test("deterministic: the same subject always gives the same token (retries match)", () => {
    expect(mint()).toBe(mint());
  });

  test("a case-folded token still verifies", () => {
    const token = mint();
    expect(verifies(token.toUpperCase(), subject)).toBe(true);
  });

  test("the recipient is compared case-insensitively", () => {
    const token = mint({ ...subject, recipient: "User@Example.ORG" });
    expect(verifies(token, subject)).toBe(true);
  });

  test("tampering with any character of the id or the MAC fails", () => {
    const token = mint();
    for (let i = 0; i < token.length; i += 1) {
      if (token[i] === ".") continue;
      expect(verifies(flip(token, i), subject)).toBe(false);
    }
  });

  test("a different recipient or email fails", () => {
    const token = mint();
    expect(verifies(token, { ...subject, recipient: "other@example.org" })).toBe(false);
    expect(verifies(token, { ...subject, emailId: "msg_ffffffffffffffffffffffff" })).toBe(
      false,
    );
  });

  test("a token minted under another key (DKIM_ENCRYPTION_KEY rotated) fails", () => {
    const oldKey = deriveUnsubscribeKey(randomBytes(32));
    const token = mint(subject, oldKey);
    expect(verifies(token, subject, oldKey)).toBe(true);
    expect(verifies(token, subject)).toBe(false);
  });

  test("the derived key differs from the master key", () => {
    const master = randomBytes(32);
    expect(deriveUnsubscribeKey(master).equals(master)).toBe(false);
  });

  test.each([
    ["empty", ""],
    ["no separator", "0123456789abcdef01234567a0123456789abcdef0123456789abcdef"],
    ["non-hex", "0123456789abcdef0123456z.0123456789abcdef0123456789abcdef"],
    ["short MAC", "0123456789abcdef01234567.0123456789abcdef0123456789abcde"],
    ["long", `0123456789abcdef01234567.${"a".repeat(64)}`],
    ["huge", "a".repeat(100_000)],
  ])("a malformed token (%s) does not parse", (_label, token) => {
    expect(parseUnsubscribeToken(token)).toBeNull();
  });

  test("an email id outside the msg_<24 hex> shape gets no token", () => {
    expect(mintUnsubscribeToken({ ...subject, emailId: "msg_x" })).toBeNull();
    expect(
      mintUnsubscribeToken({ ...subject, emailId: `msg_${"a".repeat(25)}` }),
    ).toBeNull();
    expect(
      mintUnsubscribeToken({ ...subject, emailId: "msg_0123456789ABCDEF01234567" }),
    ).toBeNull();
  });

  test("the mailto local part fits RFC 5321's 64 characters for the longest email id", () => {
    /** `generateId("msg")` always gives 24 hex characters; this is the longest id a token can carry. */
    const longest = mint({ ...subject, emailId: `msg_${"f".repeat(24)}` });
    expect(unsubscribeLocalPart(longest).length).toBeLessThanOrEqual(64);
    const real = mint({ ...subject, emailId: generateId("msg") });
    expect(unsubscribeLocalPart(real).length).toBeLessThanOrEqual(64);
  });
});

describe("tokenFromUnsubscribeAddress", () => {
  test("reads the token from unsub+<token>@domain in any case", () => {
    expect(tokenFromUnsubscribeAddress("unsub+abc.def@acme.io")).toBe("abc.def");
    expect(tokenFromUnsubscribeAddress("UNSUB+ABC@ACME.IO")).toBe("ABC");
  });

  test.each(["unsubscribe@acme.io", "unsub@acme.io", "x+unsub+abc@acme.io", "unsub+"])(
    "%p is not an unsubscribe address",
    (address) => {
      expect(tokenFromUnsubscribeAddress(address)).toBeNull();
    },
  );
});

describe("soleRecipient", () => {
  test("one to address, no cc or bcc: that address, lowercased", () => {
    expect(soleRecipient(" User@Example.org ", null, "")).toBe("user@example.org");
  });

  test("a cc, a bcc or a second to address: no token", () => {
    expect(soleRecipient("a@example.org", "b@example.org", null)).toBeNull();
    expect(soleRecipient("a@example.org", null, "b@example.org")).toBeNull();
    expect(soleRecipient("a@example.org, b@example.org", null, null)).toBeNull();
    expect(soleRecipient("not-an-address", null, null)).toBeNull();
  });
});
