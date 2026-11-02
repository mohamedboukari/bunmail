/**
 * Records mailauth's SPF results for the SPF test files (#373), so the
 * built-in evaluator can be compared with the library it replaced after
 * mailauth is gone. Output: `mailauth-results.json` next to this file.
 *
 * Run with mailauth 7.1.1 installed (it was removed afterwards, so this
 * script no longer runs; it stays as the record of how the JSON was made):
 *
 *   bun test/fixtures/spf/record-mailauth-results.mjs
 *
 * Same fake DNS as the unit tests (`test/spf-zone.ts`), strict mode, the
 * MAIL FROM identity or, for an empty MAIL FROM, the HELO identity.
 */
/* oxlint-disable no-console -- standalone script: console is its output */
import { spf } from "mailauth/lib/spf";
import { loadSpfTests, zoneResolver } from "../../spf-zone.ts";

const FILES = ["rfc7208-tests.yml", "bunmail-spf-tests.yml"];

const results = {};
for (const file of FILES) {
  results[file] = {};
  for (const test of await loadSpfTests(new URL(file, import.meta.url).pathname)) {
    const dns = zoneResolver(test.zone);
    const byType = {
      TXT: dns.resolveTxt,
      A: dns.resolve4,
      AAAA: dns.resolve6,
      MX: dns.resolveMx,
      PTR: dns.resolvePtr,
    };
    const resolver = async (name, type) => {
      const lookup = byType[type];
      if (!lookup)
        throw Object.assign(new Error(`ENOTFOUND ${name}`), { code: "ENOTFOUND" });
      return lookup(name);
    };
    const outcome = await spf({
      sender: test.mailfrom,
      ip: test.host,
      helo: test.helo,
      mta: "mx.example.test",
      strict: true,
      resolver,
    });
    results[file][test.id] = outcome.status.result;
  }
}

const output = {
  generatedBy: "mailauth 7.1.1 spf(), strict: true",
  results,
};
await Bun.write(
  new URL("mailauth-results.json", import.meta.url).pathname,
  `${JSON.stringify(output, null, 2)}\n`,
);
console.info("wrote mailauth-results.json");
