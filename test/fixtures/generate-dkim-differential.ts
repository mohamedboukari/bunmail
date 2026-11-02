/**
 * Writes `dkim-differential.json` (#373): builds the vectors of
 * `test/dkim-vectors.ts` once, runs mailauth's `dkimVerify` over each one
 * with the same fake DNS, in its default mode (what BunMail used before
 * #373) and in its strict mode, and saves the messages, the DNS answers and
 * both verdicts. `test/unit/dkim-differential.test.ts` then checks the
 * built-in verifier against them, without mailauth.
 *
 * Needs mailauth installed: run `bun test/fixtures/generate-dkim-differential.ts`
 * before it is removed (#373 step 4), and delete this script with it.
 */

import { dkimVerify } from "mailauth/lib/dkim/verify";
import { buildDkimCases, type DnsAnswer, type ExpectedResult } from "../dkim-vectors.ts";

/** A mailauth resolver over one case's DNS: unknown names are NXDOMAIN. */
function resolverFor(
  dns: Record<string, DnsAnswer>,
): (name: string, type: string) => Promise<string[][]> {
  return (name, type) => {
    const answer = type === "TXT" ? dns[name] : undefined;
    if (answer !== undefined && "txt" in answer) return Promise.resolve(answer.txt);
    const code = answer === undefined ? "ENOTFOUND" : answer.error;
    return Promise.reject(Object.assign(new Error(`${code} ${name}`), { code }));
  };
}

/** mailauth's per-signature verdicts, reduced to what BunMail reads. */
async function mailauthResults(
  message: string,
  dns: Record<string, DnsAnswer>,
  strict: boolean,
): Promise<ExpectedResult[]> {
  const verified = await dkimVerify(Buffer.from(message, "latin1"), {
    resolver: resolverFor(dns),
    strict,
  });
  return verified.results.map((result) => ({
    result: result.status.result,
    signingDomain: result.signingDomain ?? null,
  }));
}

const cases = await buildDkimCases();
const fixture = {
  generatedWith: "mailauth 7.1.1 dkimVerify, test/fixtures/generate-dkim-differential.ts",
  cases: await Promise.all(
    cases.map(async ({ name, message, dns }) => ({
      name,
      message,
      dns,
      mailauth: {
        default: await mailauthResults(message, dns, false),
        strict: await mailauthResults(message, dns, true),
      },
    })),
  ),
};

await Bun.write(
  new URL("dkim-differential.json", import.meta.url),
  `${JSON.stringify(fixture, null, 2)}\n`,
);
