import { describe, test, expect } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { verifyDkimSignatures } from "../../src/modules/inbound/services/dkim-verifier.service.ts";
import {
  BASE_MESSAGE,
  buildDkimCases,
  DOMAIN,
  keyName,
  keyRecord,
  publicKeyValue,
  signDkim,
  signWithNodemailer,
  type DnsAnswer,
  type ExpectedResult,
} from "../dkim-vectors.ts";

/** A `resolveTxt` over a fixed set of answers; unknown names are NXDOMAIN. Counts the lookups. */
function fakeDns(dns: Record<string, DnsAnswer>): {
  resolveTxt: (name: string) => Promise<string[][]>;
  lookups: string[];
} {
  const lookups: string[] = [];
  return {
    lookups,
    resolveTxt: (name) => {
      lookups.push(name);
      const answer = dns[name];
      if (answer !== undefined && "txt" in answer) return Promise.resolve(answer.txt);
      const code = answer === undefined ? "ENOTFOUND" : answer.error;
      return Promise.reject(Object.assign(new Error(`${code} ${name}`), { code }));
    },
  };
}

/** Verifies a message over a fake DNS. */
function check(message: string, dns: Record<string, DnsAnswer>, now?: () => number) {
  return verifyDkimSignatures(Buffer.from(message, "latin1"), {
    resolveTxt: fakeDns(dns).resolveTxt,
    ...(now === undefined ? {} : { now }),
  });
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaTxt = `v=DKIM1; k=rsa; p=${publicKeyValue(rsa.publicKey)}`;
const rsaDns = { [keyName("rsa")]: keyRecord(rsaTxt) };
const nodemailerSigned = await signWithNodemailer(BASE_MESSAGE, {
  privateKey: rsa.privateKey,
  selector: "rsa",
});

/** The vectors mailauth checked for test/fixtures/dkim-differential.json, with fresh keys. */
const cases = await buildDkimCases();

describe("verifyDkimSignatures: vectors (#373)", () => {
  for (const { name, message, dns, expected } of cases) {
    test(name, async () => {
      const results = await check(message, dns);
      expect(
        results.map(({ result, signingDomain }): ExpectedResult => ({
          result,
          signingDomain,
        })),
      ).toEqual(expected);
    });
  }
});

describe("verifyDkimSignatures: details (#373)", () => {
  test("a pass has no reason and names the domain and selector as written", async () => {
    const [result] = await check(nodemailerSigned, rsaDns);
    expect(result).toEqual({
      result: "pass",
      signingDomain: DOMAIN,
      selector: "rsa",
      reason: null,
      testing: false,
    });
  });

  test("the failures say why", async () => {
    const body = await check(
      nodemailerSigned.replace("last line", "edited line"),
      rsaDns,
    );
    expect(body[0]?.reason).toBe("body hash did not verify");
    const header = await check(nodemailerSigned.replace("Monthly", "Weekly"), rsaDns);
    expect(header[0]?.reason).toBe("signature did not verify");
    const revoked = await check(nodemailerSigned, {
      [keyName("rsa")]: keyRecord("v=DKIM1; p="),
    });
    expect(revoked[0]?.reason).toBe("key revoked");
    const missing = await check(nodemailerSigned, {});
    expect(missing[0]?.reason).toBe("no key record");
  });

  test("the key is looked up at <s>._domainkey.<d>, once per message", async () => {
    const dns = fakeDns(rsaDns);
    const signature = nodemailerSigned.slice(
      0,
      nodemailerSigned.indexOf("\r\nFrom:") + 2,
    );
    const results = await verifyDkimSignatures(
      Buffer.from(`${signature}${nodemailerSigned}`, "latin1"),
      { resolveTxt: dns.resolveTxt },
    );
    expect(results.map((r) => r.result)).toEqual(["pass", "pass"]);
    expect(dns.lookups).toEqual(["rsa._domainkey.example.com"]);
  });

  test("no lookup for a signature that fails before it", async () => {
    const dns = fakeDns(rsaDns);
    await verifyDkimSignatures(
      Buffer.from(nodemailerSigned.replace("last line", "edited"), "latin1"),
      { resolveTxt: dns.resolveTxt },
    );
    await verifyDkimSignatures(Buffer.from(BASE_MESSAGE, "latin1"), {
      resolveTxt: dns.resolveTxt,
    });
    expect(dns.lookups).toEqual([]);
  });

  test("ENODATA is a missing key (permerror); a timeout is a temperror", async () => {
    const nodata = await check(nodemailerSigned, {
      [keyName("rsa")]: { error: "ENODATA" },
    });
    expect(nodata[0]?.result).toBe("permerror");
    const timeout = await check(nodemailerSigned, {
      [keyName("rsa")]: { error: "ETIMEOUT" },
    });
    expect(timeout[0]).toMatchObject({
      result: "temperror",
      reason: "DNS failure: ETIMEOUT",
    });
  });

  test("a resolver that rejects without a code is a temperror", async () => {
    const results = await verifyDkimSignatures(Buffer.from(nodemailerSigned, "latin1"), {
      resolveTxt: () => Promise.reject(new Error("socket closed")),
    });
    expect(results[0]).toMatchObject({
      result: "temperror",
      reason: "DNS failure: unknown",
    });
  });

  test("an empty TXT answer is a missing key", async () => {
    const results = await check(nodemailerSigned, { [keyName("rsa")]: { txt: [] } });
    expect(results[0]?.result).toBe("permerror");
  });

  test("x= is read against the injected clock", async () => {
    const message = signDkim(BASE_MESSAGE, {
      privateKey: rsa.privateKey,
      algorithm: "rsa-sha256",
      canonicalization: "relaxed/relaxed",
      selector: "rsa",
      timestamp: 1_000,
      expiration: 2_000,
    });
    expect((await check(message, rsaDns, () => 1_999_000))[0]?.result).toBe("pass");
    expect((await check(message, rsaDns, () => 2_000_000))[0]?.result).toBe("pass");
    expect((await check(message, rsaDns, () => 2_000_001))[0]).toMatchObject({
      result: "neutral",
      reason: "signature expired",
    });
  });

  test("x= not after t= is a syntax error", async () => {
    const message = signDkim(BASE_MESSAGE, {
      privateKey: rsa.privateKey,
      algorithm: "rsa-sha256",
      canonicalization: "relaxed/relaxed",
      selector: "rsa",
      timestamp: 2_000,
      expiration: 2_000,
    });
    expect((await check(message, rsaDns))[0]).toMatchObject({
      result: "neutral",
      reason: "invalid expiration",
    });
  });

  test("t=y marks the result as testing without changing it", async () => {
    const results = await check(nodemailerSigned, {
      [keyName("rsa")]: keyRecord(
        `v=DKIM1; k=rsa; t=y:s; p=${publicKeyValue(rsa.publicKey)}`,
      ),
    });
    expect(results[0]).toMatchObject({ result: "pass", testing: true });
  });

  test("a bare RSAPublicKey in p= verifies too", async () => {
    const pkcs1 = rsa.publicKey
      .export({ type: "pkcs1", format: "der" })
      .toString("base64");
    const results = await check(nodemailerSigned, {
      [keyName("rsa")]: keyRecord(`v=DKIM1; p=${pkcs1}`),
    });
    expect(results[0]?.result).toBe("pass");
  });

  test("a key record without v= and with FWS inside p= verifies", async () => {
    const p = publicKeyValue(rsa.publicKey).replace(/.{64}/g, "$& ");
    const results = await check(nodemailerSigned, {
      [keyName("rsa")]: keyRecord(`k=rsa; p=${p}`),
    });
    expect(results[0]?.result).toBe("pass");
  });

  test.each([
    [
      "v= not DKIM1",
      `v=DKIM2; p=${publicKeyValue(rsa.publicKey)}`,
      "unknown key version",
    ],
    [
      "v= not first",
      `k=rsa; v=DKIM1; p=${publicKeyValue(rsa.publicKey)}`,
      "unknown key version",
    ],
    ["no p=", "v=DKIM1; k=rsa", "key record syntax error"],
    [
      "unknown k=",
      `v=DKIM1; k=dsa; p=${publicKeyValue(rsa.publicKey)}`,
      "unknown key type",
    ],
    [
      "s= without email",
      `v=DKIM1; s=other; p=${publicKeyValue(rsa.publicKey)}`,
      "key not for email",
    ],
    ["p= not a key", "v=DKIM1; p=AAAA", "invalid public key"],
  ])("key record %s is a permerror", async (_label, record, reason) => {
    const results = await check(nodemailerSigned, {
      [keyName("rsa")]: keyRecord(record),
    });
    expect(results[0]).toMatchObject({ result: "permerror", reason });
  });

  test("empty bodies verify in both canonicalizations", async () => {
    const empty = `${BASE_MESSAGE.slice(0, BASE_MESSAGE.indexOf("\r\n\r\n"))}\r\n\r\n`;
    for (const canonicalization of ["simple/simple", "relaxed/relaxed"]) {
      const message = signDkim(empty, {
        privateKey: rsa.privateKey,
        algorithm: "rsa-sha256",
        canonicalization,
        selector: "rsa",
      });
      expect((await check(message, rsaDns))[0]?.result).toBe("pass");
    }
  });

  test("simple canonicalization fails on whitespace changes that relaxed allows", async () => {
    const sign = (canonicalization: string): string =>
      signDkim(BASE_MESSAGE, {
        privateKey: rsa.privateKey,
        algorithm: "rsa-sha256",
        canonicalization,
        selector: "rsa",
      });
    const respace = (message: string): string =>
      message
        .replace("To: rcpt@example.org", "To:   rcpt@example.org ")
        .replace("last line", "last  line ");
    expect((await check(respace(sign("relaxed/relaxed")), rsaDns))[0]?.result).toBe(
      "pass",
    );
    expect((await check(respace(sign("simple/simple")), rsaDns))[0]?.result).toBe("fail");
  });

  test("header field names in h= and the message match without regard to case", async () => {
    const message = signDkim(BASE_MESSAGE, {
      privateKey: rsa.privateKey,
      algorithm: "rsa-sha256",
      canonicalization: "relaxed/relaxed",
      selector: "rsa",
      headers: ["FROM", "subject", "To"],
    }).replace("From: Sender", "FROM: Sender");
    expect((await check(message, rsaDns))[0]?.result).toBe("pass");
  });

  test.each([
    ["a repeated tag", (m: string) => m.replace("v=1;", "v=1; v=1;")],
    ["an empty tag-spec", (m: string) => m.replace("v=1;", "v=1;;")],
    ["a tag without =", (m: string) => m.replace("v=1;", "v=1; junk;")],
    ["no d=", (m: string) => m.replace("d=example.com;", "")],
    [
      "an upper case tag name (D=)",
      (m: string) => m.replace("d=example.com", "D=example.com"),
    ],
    [
      "an unknown canonicalization",
      (m: string) => m.replace("c=relaxed/relaxed", "c=fancy/relaxed"),
    ],
    ["a q= without dns/txt", (m: string) => m.replace("q=dns/txt", "q=http")],
    ["an invalid d=", (m: string) => m.replace("d=example.com", "d=-bad-.com")],
    ["a non-numeric l=", (m: string) => m.replace("v=1;", "v=1; l=12a;")],
  ])("%s is neutral", async (_label, mutate) => {
    const results = await check(mutate(nodemailerSigned), rsaDns);
    expect(results[0]?.result).toBe("neutral");
  });

  test("ARC header fields alone are not DKIM signatures", async () => {
    const message = `ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=${DOMAIN}; s=rsa; h=from; bh=AAAA; b=AAAA\r\n${BASE_MESSAGE}`;
    expect(await check(message, rsaDns)).toEqual([]);
  });

  test("a message without a header/body separator has an empty body", async () => {
    const headersOnly = `${BASE_MESSAGE.slice(0, BASE_MESSAGE.indexOf("\r\n\r\n"))}\r\n`;
    const message = signDkim(`${headersOnly}\r\n`, {
      privateKey: rsa.privateKey,
      algorithm: "rsa-sha256",
      canonicalization: "relaxed/relaxed",
      selector: "rsa",
    });
    const withoutSeparator = message.slice(0, -2);
    expect((await check(withoutSeparator, rsaDns))[0]?.result).toBe("pass");
  });
});
