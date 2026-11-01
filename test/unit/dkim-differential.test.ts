/**
 * The built-in DKIM verifier against mailauth (#373), on the vectors of
 * `test/fixtures/dkim-differential.json`: messages signed once, with the
 * verdicts mailauth 7.1.1 gave them in its default mode (what BunMail used
 * before #373) and in its strict mode. The verifier must agree with both,
 * except for the differences listed below, each one intended.
 */

import { describe, test, expect } from "bun:test";
import { verifyDkimSignatures } from "../../src/modules/inbound/services/dkim-verifier.service.ts";
import type { DnsAnswer, ExpectedResult } from "../dkim-vectors.ts";

/** One fixture case, as `generate-dkim-differential.ts` wrote it. */
interface FixtureCase {
  name: string;
  message: string;
  dns: Record<string, DnsAnswer>;
  mailauth: { default: ExpectedResult[]; strict: ExpectedResult[] };
}

/** Narrows the parsed fixture, checking the fields this test reads. */
function isFixtureCase(value: unknown): value is FixtureCase {
  if (typeof value !== "object" || value === null) return false;
  const mailauth: unknown = Reflect.get(value, "mailauth");
  return (
    typeof Reflect.get(value, "name") === "string" &&
    typeof Reflect.get(value, "message") === "string" &&
    typeof Reflect.get(value, "dns") === "object" &&
    typeof mailauth === "object" &&
    mailauth !== null &&
    Array.isArray(Reflect.get(mailauth, "default")) &&
    Array.isArray(Reflect.get(mailauth, "strict"))
  );
}

const parsed: unknown = await Bun.file(
  new URL("../fixtures/dkim-differential.json", import.meta.url),
).json();
const rawCases: unknown =
  typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "cases") : [];
const cases = Array.isArray(rawCases) ? rawCases.filter(isFixtureCase) : [];

/** mailauth reports an unsigned message as one `none` result; the verifier returns no result. */
const UNSIGNED: ExpectedResult[] = [{ result: "none", signingDomain: null }];

/** A missing, revoked or unusable key: mailauth says `neutral`, RFC 8601 `permerror`. */
const KEY_ERROR =
  "a key record error is permerror (RFC 8601 section 2.7.1), mailauth says neutral";

/** Intended differences from mailauth's strict mode: case name, our verdicts, why. */
const STRICT_DIFFERENCES: Record<string, { ours: string[]; why: string }> = {
  "two signatures, one broken": { ours: ["permerror", "pass"], why: KEY_ERROR },
  "revoked key (empty p=)": { ours: ["permerror"], why: KEY_ERROR },
  "no key record": { ours: ["permerror"], why: KEY_ERROR },
  "key record syntax error": { ours: ["permerror"], why: KEY_ERROR },
  "key record for ed25519, rsa-sha256 signature": { ours: ["permerror"], why: KEY_ERROR },
  "key record allows only sha1": { ours: ["permerror"], why: KEY_ERROR },
  "key record t=s, i= a subdomain of d=": { ours: ["permerror"], why: KEY_ERROR },
  "b= not base64": {
    ours: ["neutral"],
    why: "a b= that is not base64 is a syntax error (neutral); mailauth decodes what it can and fails the signature",
  },
};

/**
 * Intended differences from mailauth's default mode, the one BunMail used:
 * its lax acceptances, and a body hash mismatch it calls `neutral`.
 */
const DEFAULT_DIFFERENCES: Record<string, { ours: string[]; why: string }> = {
  ...STRICT_DIFFERENCES,
  "body changed after signing": {
    ours: ["fail"],
    why: "a body hash mismatch is fail (RFC 6376 section 6.1.3); mailauth's default mode says neutral",
  },
  "key record syntax error": {
    ours: ["permerror"],
    why: "mailauth's default mode ignores the stray ;",
  },
  "key record t=s, i= a subdomain of d=": {
    ours: ["permerror"],
    why: "mailauth's default mode only warns when t=s meets an i= subdomain",
  },
  "i= outside d=": { ours: ["neutral"], why: "mailauth's default mode only warns" },
  "rsa-sha1": {
    ours: ["policy"],
    why: "rsa-sha1 is refused (RFC 8301); mailauth's default mode verifies it",
  },
  "unknown algorithm": {
    ours: ["neutral"],
    why: "an unknown a= is reported (RFC 8601 neutral); mailauth's default mode leaves the signature out",
  },
  "v= other than 1": {
    ours: ["neutral"],
    why: "v= other than 1 is an incompatible version; mailauth's default mode verifies the edited header and fails",
  },
};

describe("DKIM verifier vs mailauth (#373)", () => {
  test("the fixture has every case", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  for (const fixtureCase of cases) {
    test(fixtureCase.name, async () => {
      const results = await verifyDkimSignatures(
        Buffer.from(fixtureCase.message, "latin1"),
        {
          resolveTxt: (name) => {
            const answer = fixtureCase.dns[name];
            if (answer !== undefined && "txt" in answer)
              return Promise.resolve(answer.txt);
            const code = answer === undefined ? "ENOTFOUND" : answer.error;
            return Promise.reject(Object.assign(new Error(code), { code }));
          },
        },
      );
      const ours =
        results.length === 0
          ? UNSIGNED
          : results.map(({ result, signingDomain }) => ({ result, signingDomain }));

      for (const [mode, differences] of [
        ["strict", STRICT_DIFFERENCES],
        ["default", DEFAULT_DIFFERENCES],
      ] as const) {
        const theirs = fixtureCase.mailauth[mode];
        const difference = differences[fixtureCase.name];
        if (difference === undefined) {
          expect(ours).toEqual(theirs);
        } else {
          expect(ours.map((r) => r.result)).toEqual(difference.ours);
          expect(ours.map((r) => r.result)).not.toEqual(theirs.map((r) => r.result));
        }
      }
    });
  }
});
