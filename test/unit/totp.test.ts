import { describe, test, expect } from "bun:test";
import {
  TOTP_ISSUER,
  base32Decode,
  base32Encode,
  codesEqual,
  formatSecretForDisplay,
  generateTotpSecret,
  hotp,
  looksLikeTotpCode,
  matchTotpStep,
  otpauthUri,
  totpCode,
  totpStep,
} from "../../src/modules/users/services/totp.service.ts";
import {
  RECOVERY_CODE_COUNT,
  generateRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from "../../src/modules/users/services/recovery-code.service.ts";

/**
 * TOTP (#220): HOTP and TOTP against the RFC test vectors, base32, the
 * code comparison, the verification window and replay rule, the
 * `otpauth://` URI, and the recovery codes.
 */

/** The RFC 4226 / RFC 6238 SHA-1 test secret: ASCII "12345678901234567890". */
const RFC_KEY = Buffer.from("12345678901234567890", "ascii");

describe("HOTP (RFC 4226, Appendix D)", () => {
  const expected = [
    "755224",
    "287082",
    "359152",
    "969429",
    "338314",
    "254676",
    "287922",
    "162583",
    "399871",
    "520489",
  ];
  const table: Array<[number, string]> = expected.map((code, counter) => [counter, code]);
  test.each(table)("counter %p gives %p", (counter, code) => {
    expect(hotp(RFC_KEY, counter)).toBe(code);
  });
});

describe("TOTP (RFC 6238, Appendix B, SHA-1)", () => {
  /** [Unix time in seconds, 8-digit value from the RFC table]. */
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  test.each(vectors)("T=%p: 8 digits %p", (seconds, code) => {
    expect(totpCode(RFC_KEY, totpStep(seconds * 1000), 8)).toBe(code);
  });

  test.each(vectors)("T=%p: 6 digits are the last six of %p", (seconds, code) => {
    expect(totpCode(RFC_KEY, totpStep(seconds * 1000))).toBe(code.slice(-6));
  });

  test("steps are 30 seconds from the Unix epoch", () => {
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
    expect(totpStep(59_000)).toBe(1);
  });
});

describe("base32 (RFC 4648)", () => {
  test.each([
    ["", ""],
    ["f", "MY"],
    ["fo", "MZXQ"],
    ["foo", "MZXW6"],
    ["foob", "MZXW6YQ"],
    ["fooba", "MZXW6YTB"],
    ["foobar", "MZXW6YTBOI"],
  ])("%p encodes to %p (RFC 4648 section 10, no padding) and back", (text, encoded) => {
    expect(base32Encode(Buffer.from(text))).toBe(encoded);
    expect(base32Decode(encoded)?.toString()).toBe(text);
  });

  test("round-trips random bytes of every length, upper or lower case", () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = Buffer.from(
        Array.from({ length }, (_, i) => (i * 37 + length) & 255),
      );
      const encoded = base32Encode(bytes);
      expect(encoded).toMatch(/^[A-Z2-7]*$/);
      expect(base32Decode(encoded)?.equals(bytes)).toBe(true);
      expect(base32Decode(encoded.toLowerCase())?.equals(bytes)).toBe(true);
    }
  });

  test.each(["MZXW6YTBO1", "MZXW6=", "M", "MZX", "MZXW6Y", "MZ XW", "MZ"])(
    "rejects %p (bad character, impossible length or leftover bits)",
    (input) => {
      /** "MZ" has non-zero leftover bits ("MY" is the canonical "f"). */
      expect(base32Decode(input)).toBeNull();
    },
  );

  test("a generated secret is 20 random bytes: 32 base32 characters", () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)?.length).toBe(20);
    expect(a).not.toBe(b);
  });
});

describe("codesEqual", () => {
  test("equal and unequal codes, and different lengths", () => {
    expect(codesEqual("123456", "123456")).toBe(true);
    expect(codesEqual("123456", "123457")).toBe(false);
    expect(codesEqual("123456", "1234567")).toBe(false);
    expect(codesEqual("", "")).toBe(true);
  });
});

describe("matchTotpStep: window and replay", () => {
  /** 15 seconds into step 59958720 (2027-01-01T00:00:15Z). */
  const now = Date.UTC(2027, 0, 1, 0, 0, 15);
  const step = totpStep(now);
  const code = (delta: number): string => totpCode(RFC_KEY, step + delta);

  test("the current step and one either side match; two steps away do not", () => {
    expect(matchTotpStep(RFC_KEY, code(0), now, null)).toBe(step);
    expect(matchTotpStep(RFC_KEY, code(-1), now, null)).toBe(step - 1);
    expect(matchTotpStep(RFC_KEY, code(1), now, null)).toBe(step + 1);
    expect(matchTotpStep(RFC_KEY, code(-2), now, null)).toBeNull();
    expect(matchTotpStep(RFC_KEY, code(2), now, null)).toBeNull();
  });

  test("a step at or before the last accepted one is refused (replay)", () => {
    expect(matchTotpStep(RFC_KEY, code(0), now, step)).toBeNull();
    expect(matchTotpStep(RFC_KEY, code(-1), now, step)).toBeNull();
    expect(matchTotpStep(RFC_KEY, code(0), now, step - 1)).toBe(step);
    expect(matchTotpStep(RFC_KEY, code(1), now, step)).toBe(step + 1);
  });

  test("spaces are ignored; anything but six digits never matches", () => {
    const c = code(0);
    expect(matchTotpStep(RFC_KEY, ` ${c.slice(0, 3)} ${c.slice(3)} `, now, null)).toBe(
      step,
    );
    for (const bad of ["", "12345", "1234567", "abcdef", `${c}0`, "12345a"]) {
      expect(matchTotpStep(RFC_KEY, bad, now, null)).toBeNull();
    }
    expect(looksLikeTotpCode(" 123 456 ")).toBe(true);
    expect(looksLikeTotpCode("abcd-efgh-ijkl-mnop")).toBe(false);
  });

  test("another key's code does not match", () => {
    const other = Buffer.from("another secret, 20 b", "ascii");
    expect(matchTotpStep(other, code(0), now, null)).toBeNull();
  });
});

describe("otpauth URI and display", () => {
  test("the URI carries the label, issuer, secret and the parameters", () => {
    const uri = otpauthUri("JBSWY3DPEHPK3PXP", "owner+2fa@example.com");
    expect(
      uri.startsWith(`otpauth://totp/${TOTP_ISSUER}:owner%2B2fa%40example.com?`),
    ).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("JBSWY3DPEHPK3PXP");
    expect(params.get("issuer")).toBe(TOTP_ISSUER);
    expect(params.get("algorithm")).toBe("SHA1");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
  });

  test("the secret is grouped by four for typing", () => {
    expect(formatSecretForDisplay("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP")).toBe(
      "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP",
    );
  });
});

describe("recovery codes", () => {
  test("ten distinct codes of 16 base32 characters in four groups", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of codes) expect(code).toMatch(/^([a-z2-7]{4}-){3}[a-z2-7]{4}$/);
  });

  test("normalization ignores case, spaces and dashes; anything else is not a code", () => {
    const code = generateRecoveryCode();
    const normalized = code.replaceAll("-", "").toUpperCase();
    expect(normalizeRecoveryCode(code)).toBe(normalized);
    expect(normalizeRecoveryCode(` ${code.toUpperCase().replaceAll("-", " ")} `)).toBe(
      normalized,
    );
    for (const bad of [
      "",
      "123456",
      "abcd-efgh-ijkl",
      "abcd-efgh-ijkl-mno1",
      `${code}a`,
    ]) {
      expect(normalizeRecoveryCode(bad)).toBeNull();
    }
  });

  test("the stored hash is SHA-256 hex of the normalized code", () => {
    const hash = hashRecoveryCode("ABCDEFGHIJKLMNOP");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(
      new Bun.CryptoHasher("sha256").update("ABCDEFGHIJKLMNOP").digest("hex"),
    );
    expect(hashRecoveryCode("ABCDEFGHIJKLMNOQ")).not.toBe(hash);
  });
});
