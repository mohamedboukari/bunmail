import { describe, test, expect } from "bun:test";
import { randomBytes } from "crypto";
import {
  MAX_RECIPIENT_INDEX,
  RETURN_PATH_LOCAL_PREFIX,
  deriveReturnPathKey,
  isReturnPathAddress,
  mintReturnPath,
  parseReturnPath,
  recipientOrder,
  returnPathMacMatches,
  type ReturnPathSubject,
} from "../../src/modules/bounces/services/return-path.ts";
import { deriveUnsubscribeKey } from "../../src/modules/suppressions/services/unsubscribe-token.ts";

/**
 * Signed per-recipient return paths (#236): `b+<id hex>.<index>.<MAC>@<sender
 * domain>`, lowercase hex, inside the 64-character local part limit, bound
 * to one email and one recipient.
 */

const KEY = deriveReturnPathKey(randomBytes(32));
const DOMAIN = "acme.io";

const subject: ReturnPathSubject = {
  emailId: "msg_0123456789abcdef01234567",
  index: 1,
  recipient: "user@example.org",
};

/** Mints an address, failing the test if none comes back. */
function mint(s: ReturnPathSubject = subject, key: Buffer = KEY): string {
  const address = mintReturnPath(s, DOMAIN, key);
  if (address === null) throw new Error("expected a return path");
  return address;
}

/**
 * Verifies a presented address against an email the way the receiver does:
 * parse, take the recipient at the parsed index of `recipients`, recompute,
 * and require the email's sender domain.
 */
function verifies(
  address: string,
  email: { id: string; recipients: string[]; senderDomain: string },
  key: Buffer = KEY,
): boolean {
  const parsed = parseReturnPath(address);
  if (!parsed || parsed.emailId !== email.id) return false;
  const recipient = email.recipients[parsed.index];
  if (recipient === undefined) return false;
  return (
    returnPathMacMatches(
      { emailId: email.id, index: parsed.index, recipient },
      parsed.mac,
      key,
    ) && parsed.domain === email.senderDomain
  );
}

const EMAIL = {
  id: subject.emailId,
  recipients: ["first@example.org", "user@example.org", "third@example.net"],
  senderDomain: DOMAIN,
};

/** `address` with the character at `index` replaced by a different hex digit. */
function flip(address: string, index: number): string {
  const replacement = address[index] === "0" ? "1" : "0";
  return address.slice(0, index) + replacement + address.slice(index + 1);
}

describe("return path address", () => {
  test("round trip: a minted address parses back to its email, index and domain, and verifies", () => {
    const address = mint();
    expect(address).toMatch(/^b\+[0-9a-f]{24}\.1\.[0-9a-f]{24}@acme\.io$/);
    const parsed = parseReturnPath(address);
    expect(parsed?.emailId).toBe(subject.emailId);
    expect(parsed?.index).toBe(1);
    expect(parsed?.domain).toBe(DOMAIN);
    expect(verifies(address, EMAIL)).toBe(true);
  });

  test("deterministic: the same subject always gives the same address (retries match)", () => {
    expect(mint()).toBe(mint());
  });

  test("a case-folded address still verifies (MTAs may fold the local part)", () => {
    const address = mint();
    expect(verifies(address.toUpperCase(), EMAIL)).toBe(true);
  });

  test("the recipient is compared case-insensitively", () => {
    const address = mint({ ...subject, recipient: "User@Example.ORG" });
    expect(verifies(address, EMAIL)).toBe(true);
  });

  test("tampering with any character of the id, index or MAC fails", () => {
    const address = mint();
    const at = address.indexOf("@");
    for (let i = RETURN_PATH_LOCAL_PREFIX.length; i < at; i += 1) {
      if (address[i] === ".") continue;
      expect(verifies(flip(address, i), EMAIL)).toBe(false);
    }
  });

  test("a truncated or extended MAC fails", () => {
    const address = mint();
    const at = address.indexOf("@");
    expect(verifies(address.slice(0, at - 1) + address.slice(at), EMAIL)).toBe(false);
    expect(verifies(address.slice(0, at) + "0" + address.slice(at), EMAIL)).toBe(false);
  });

  test("the address names one recipient: another recipient of the same email fails", () => {
    const forFirst = mint({ ...subject, index: 0, recipient: "first@example.org" });
    expect(verifies(forFirst, EMAIL)).toBe(true);
    /** The MAC of recipient 0 moved to index 1 (another recipient) fails. */
    expect(verifies(forFirst.replace(".0.", ".1."), EMAIL)).toBe(false);
    /** The right index, minted for a different address, fails. */
    const wrongRecipient = mint({ ...subject, recipient: "first@example.org" });
    expect(verifies(wrongRecipient, EMAIL)).toBe(false);
  });

  test("an index past the email's recipients fails", () => {
    const address = mint({ ...subject, index: 3, recipient: "user@example.org" });
    expect(verifies(address, EMAIL)).toBe(false);
  });

  test("another email fails, even with the same recipient at the same index", () => {
    const other = mint({ ...subject, emailId: "msg_fedcba9876543210fedcba98" });
    expect(verifies(other, EMAIL)).toBe(false);
    /** Same MAC, id swapped in. */
    const swapped = mint().replace(
      "0123456789abcdef01234567",
      "fedcba9876543210fedcba98",
    );
    expect(verifies(swapped, { ...EMAIL, id: "msg_fedcba9876543210fedcba98" })).toBe(
      false,
    );
  });

  test("another domain fails", () => {
    const address = mint().replace("@acme.io", "@other.io");
    expect(verifies(address, EMAIL)).toBe(false);
  });

  test("a different master key fails (rotating DKIM_ENCRYPTION_KEY invalidates return paths)", () => {
    const rotated = deriveReturnPathKey(randomBytes(32));
    expect(verifies(mint(), EMAIL, rotated)).toBe(false);
  });

  test("its key is separate from the unsubscribe key derived from the same master", () => {
    const master = randomBytes(32);
    expect(deriveReturnPathKey(master).equals(deriveUnsubscribeKey(master))).toBe(false);
  });

  test("the largest allowed index keeps the local part within 64 characters", () => {
    const address = mint({ ...subject, index: MAX_RECIPIENT_INDEX });
    const localPart = address.slice(0, address.indexOf("@"));
    expect(localPart.length).toBeLessThanOrEqual(64);
    expect(localPart.length).toBe(58);
    expect(parseReturnPath(address)?.index).toBe(MAX_RECIPIENT_INDEX);
  });

  test("an out-of-range index, a non-msg id or no domain gives no address", () => {
    expect(
      mintReturnPath({ ...subject, index: MAX_RECIPIENT_INDEX + 1 }, DOMAIN, KEY),
    ).toBeNull();
    expect(mintReturnPath({ ...subject, index: -1 }, DOMAIN, KEY)).toBeNull();
    expect(mintReturnPath({ ...subject, index: 1.5 }, DOMAIN, KEY)).toBeNull();
    expect(mintReturnPath({ ...subject, emailId: "msg_short" }, DOMAIN, KEY)).toBeNull();
    expect(
      mintReturnPath(
        { ...subject, emailId: "inb_0123456789abcdef01234567" },
        DOMAIN,
        KEY,
      ),
    ).toBeNull();
    expect(mintReturnPath(subject, "  ", KEY)).toBeNull();
  });

  test("malformed addresses do not parse", () => {
    const address = mint();
    for (const bad of [
      "",
      "b+@acme.io",
      "b+0123456789abcdef01234567.1@acme.io",
      address.replace(".1.", ".01."),
      address.replace(".1.", ".-1."),
      address.replace("b+", "bb+"),
      address.replace("@acme.io", ""),
      `${address}@x`,
      `${address.slice(0, address.indexOf("@"))}@${"a".repeat(260)}.io`,
    ]) {
      expect(parseReturnPath(bad)).toBeNull();
    }
  });

  test("isReturnPathAddress matches the b+ local part in any case, and nothing else", () => {
    expect(isReturnPathAddress(mint())).toBe(true);
    expect(isReturnPathAddress("B+anything@acme.io")).toBe(true);
    expect(isReturnPathAddress("bob@acme.io")).toBe(false);
    expect(isReturnPathAddress("unsub+abc@acme.io")).toBe(false);
    expect(isReturnPathAddress("ab+x@acme.io")).toBe(false);
  });
});

describe("recipientOrder", () => {
  test("to, then cc, then bcc, lowercased, first occurrence wins, invalid entries dropped", () => {
    expect(
      recipientOrder(
        "One@Example.org, two@example.org",
        "three@example.net, ONE@example.org, not-an-address",
        "four@example.com, two@EXAMPLE.org",
      ),
    ).toEqual([
      "one@example.org",
      "two@example.org",
      "three@example.net",
      "four@example.com",
    ]);
  });

  test("absent cc and bcc", () => {
    expect(recipientOrder("solo@example.org", null, undefined)).toEqual([
      "solo@example.org",
    ]);
  });
});
