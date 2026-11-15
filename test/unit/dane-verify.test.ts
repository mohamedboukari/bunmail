import { describe, test, expect, spyOn } from "bun:test";
import { X509Certificate, createHash, generateKeyPairSync } from "crypto";
import { readFileSync } from "fs";
import {
  DANE_FAILURE_MESSAGES,
  DANE_HANDSHAKE_INCOMPLETE,
  daneSocketCheck,
  MAX_SIGNATURE_CHECKS,
  peerChain,
  usableTlsa,
  verifyDaneChain,
  type DaneVerdict,
  type PeerCertificateLink,
  type PeerCertificateSource,
} from "../../src/modules/emails/services/dane-verify.ts";
import type { DaneHost } from "../../src/modules/emails/types/dane.types.ts";
import type { TlsaRecord } from "../../src/utils/dns-rdata.ts";
import {
  pathLengthConstraint,
  subjectPublicKeyInfo,
} from "../../src/modules/emails/services/dane-der.ts";

/**
 * DANE authentication of the server's certificate chain (#345, RFC 7672
 * section 3, `dane-verify.ts`), with the fixture certificates of
 * `test/fixtures/tls/dane/` (see its README): which TLSA records are
 * usable, DANE-EE matching (no names, no dates), DANE-TA paths (#455: the
 * anchor in the chain or from DNS, issuer links built over the presented
 * certificates in any order, path length, dates below the anchor, name
 * checks with wildcards), on two- and three-level chains.
 */

const DIR = new URL("../fixtures/tls/dane/", import.meta.url);

/** A fixture certificate. */
function cert(name: string): X509Certificate {
  return new X509Certificate(readFileSync(new URL(`${name}.cert.pem`, DIR)));
}

const ee = cert("ee");
const ca = cert("ca");
const taLeaf = cert("ta-leaf");
const taWildcard = cert("ta-wildcard");
const taCnOnly = cert("ta-cn-only");
const taExpired = cert("ta-expired");
const taForged = cert("ta-forged");

const NOW = new Date("2030-01-01T00:00:00Z");

/** The SPKI DER of a certificate. */
function spki(c: X509Certificate): Uint8Array {
  return Uint8Array.from(c.publicKey.export({ type: "spki", format: "der" }));
}

/** A TLSA record for `c` with the given parameters. */
function record(
  usage: number,
  selector: number,
  matchingType: number,
  c: X509Certificate,
): TlsaRecord {
  const bytes = selector === 0 ? Uint8Array.from(c.raw) : spki(c);
  const data =
    matchingType === 0
      ? bytes
      : Uint8Array.from(
          createHash(matchingType === 1 ? "sha256" : "sha512")
            .update(bytes)
            .digest(),
        );
  return { usage, selector, matchingType, data };
}

/** A host whose records are `records`, with the names given. */
function host(
  records: TlsaRecord[],
  referenceIds: string[] = ["mx.dane.example", "example.org"],
): Pick<DaneHost, "usable" | "referenceIds"> {
  return { usable: usableTlsa(records), referenceIds };
}

describe("usableTlsa (RFC 6698 4.1, RFC 7672 3.1.3, RFC 7671 9)", () => {
  test("PKIX usages, unknown selectors and matching types are unusable", () => {
    const base = record(3, 1, 1, ee);
    expect(usableTlsa([{ ...base, usage: 0 }])).toEqual([]);
    expect(usableTlsa([{ ...base, usage: 1 }])).toEqual([]);
    expect(usableTlsa([{ ...base, usage: 4 }])).toEqual([]);
    expect(usableTlsa([{ ...base, selector: 2 }])).toEqual([]);
    expect(usableTlsa([{ ...base, matchingType: 3 }])).toEqual([]);
    expect(usableTlsa([base])).toEqual([base]);
  });

  test("a digest of the wrong length, or Full data that does not parse, is unusable", () => {
    const sha256 = record(3, 1, 1, ee);
    expect(usableTlsa([{ ...sha256, data: sha256.data.subarray(0, 31) }])).toEqual([]);
    expect(usableTlsa([{ ...sha256, matchingType: 2 }])).toEqual([]);
    expect(
      usableTlsa([
        { usage: 3, selector: 0, matchingType: 0, data: Uint8Array.from([1, 2, 3]) },
      ]),
    ).toEqual([]);
    expect(
      usableTlsa([{ usage: 3, selector: 1, matchingType: 0, data: new Uint8Array(0) }]),
    ).toEqual([]);
    const full = record(3, 0, 0, ee);
    expect(usableTlsa([full])).toEqual([full]);
  });

  test("digest agility: per usage and selector, Full plus the strongest digest only", () => {
    const sha256 = record(3, 1, 1, ee);
    const sha512 = record(3, 1, 2, ee);
    const full = record(3, 1, 0, ee);
    const taSha256 = record(2, 0, 1, ca);
    expect(usableTlsa([sha256, sha512, full, taSha256])).toEqual([
      sha512,
      full,
      taSha256,
    ]);
  });

  test("DANE-TA records are usable (#455), alone or beside DANE-EE ones", () => {
    const ee311 = record(3, 1, 1, ee);
    const ta201 = record(2, 0, 1, ca);
    const ta200 = record(2, 0, 0, ca);
    expect(usableTlsa([ta201, ta200])).toEqual([ta201, ta200]);
    expect(usableTlsa([ee311, ta201])).toEqual([ee311, ta201]);
  });
});

describe("DANE-EE(3) (RFC 7672 3.1.1)", () => {
  for (const [selector, matchingType] of [
    [0, 0],
    [0, 1],
    [1, 1],
    [1, 2],
  ] as const) {
    test(`3 ${selector} ${matchingType} matches the leaf, and only the leaf`, () => {
      expect(
        verifyDaneChain([ee], host([record(3, selector, matchingType, ee)]), NOW),
      ).toEqual({
        ok: true,
        usage: "DANE-EE",
      });
      expect(
        verifyDaneChain([taLeaf, ca], host([record(3, selector, matchingType, ee)]), NOW),
      ).toEqual({
        ok: false,
        failure: "no-match",
      });
    });
  }

  test("names and dates are ignored", () => {
    expect(
      verifyDaneChain(
        [taExpired, ca],
        host([record(3, 1, 1, taExpired)], ["unrelated.example"]),
        NOW,
      ),
    ).toEqual({ ok: true, usage: "DANE-EE" });
  });

  test("an EE record of the issuer does not match the leaf", () => {
    expect(verifyDaneChain([taLeaf, ca], host([record(3, 0, 1, ca)]), NOW)).toEqual({
      ok: false,
      failure: "no-match",
    });
  });

  test("agility: a server matching only the weaker digest fails", () => {
    const weak = record(3, 1, 1, ee);
    const strongOther = record(3, 1, 2, taLeaf);
    expect(verifyDaneChain([ee], host([weak, strongOther]), NOW)).toEqual({
      ok: false,
      failure: "no-match",
    });
  });

  test("no certificate at all", () => {
    expect(verifyDaneChain([], host([record(3, 1, 1, ee)]), NOW)).toEqual({
      ok: false,
      failure: "no-certificate",
    });
  });
});

describe("selector SPKI(1): the certificate's own SubjectPublicKeyInfo bytes (RFC 6698 2.1.1)", () => {
  /**
   * The expected digests come from OpenSSL, not from BunMail's DER walker:
   * `openssl asn1parse` gives the SPKI element's offset and length in the
   * certificate's DER, and those bytes were hashed apart (see the fixtures'
   * README). A re-encoding of the parsed key would not give them: the
   * compressed EC point comes back uncompressed, and Bun cannot parse an
   * RSA-PSS key at all.
   */
  const COMPRESSED_SPKI_SHA256 =
    "4dc86342ec28fb8f816246ad86ed14cbbffb00bb0191cd73f886696d55c5b89e";
  const RSA_PSS_SPKI_SHA256 =
    "c52de28c8b71f7ffd0380d824caa9ffc4e67e96371abecec79d029fa205e55a2";

  /** A "3 1 1" record of `hex`. */
  function spkiRecord(hex: string): TlsaRecord {
    return {
      usage: 3,
      selector: 1,
      matchingType: 1,
      data: Uint8Array.from(Buffer.from(hex, "hex")),
    };
  }

  test("a compressed-point P-256 certificate matches its own SPKI digest", () => {
    const compressed = cert("ec-compressed");
    expect(subjectPublicKeyInfo(Uint8Array.from(compressed.raw))?.length).toBe(59);
    expect(
      verifyDaneChain([compressed], host([spkiRecord(COMPRESSED_SPKI_SHA256)]), NOW),
    ).toEqual({
      ok: true,
      usage: "DANE-EE",
    });
  });

  test("an RSA-PSS certificate matches by SPKI and by full certificate", () => {
    const pss = cert("rsa-pss");
    expect(verifyDaneChain([pss], host([spkiRecord(RSA_PSS_SPKI_SHA256)]), NOW).ok).toBe(
      true,
    );
    expect(verifyDaneChain([pss], host([record(3, 0, 1, pss)]), NOW).ok).toBe(true);
    /** Full(0) data is checked for structure, not for a key type Bun can parse. */
    const full: TlsaRecord = {
      usage: 3,
      selector: 0,
      matchingType: 0,
      data: Uint8Array.from(pss.raw),
    };
    expect(usableTlsa([full])).toEqual([full]);
  });

  test("a Full(0) SPKI record must be exactly one SubjectPublicKeyInfo", () => {
    const own = subjectPublicKeyInfo(Uint8Array.from(ee.raw));
    if (own === null) throw new Error("no SPKI");
    const full: TlsaRecord = { usage: 3, selector: 1, matchingType: 0, data: own };
    expect(usableTlsa([full])).toEqual([full]);
    expect(verifyDaneChain([ee], host([full]), NOW).ok).toBe(true);
    expect(usableTlsa([{ ...full, data: Uint8Array.from([...own, 0]) }])).toEqual([]);
    expect(usableTlsa([{ ...full, data: own.subarray(0, own.length - 1) }])).toEqual([]);
  });

  test("malformed DER fails closed: no SPKI, no match", () => {
    const raw = Uint8Array.from(ee.raw);
    expect(subjectPublicKeyInfo(raw.subarray(0, 40))).toBeNull();
    expect(subjectPublicKeyInfo(Uint8Array.from([0x30, 0x80, 0x00, 0x00]))).toBeNull();
    expect(subjectPublicKeyInfo(Uint8Array.from([0x30, 0x85, 1, 1, 1, 1, 1]))).toBeNull();
    expect(subjectPublicKeyInfo(new Uint8Array(0))).toBeNull();
    /** The TBSCertificate's tag corrupted. */
    const broken = Uint8Array.from(raw);
    broken[4] = 0x31;
    expect(subjectPublicKeyInfo(broken)).toBeNull();
    /** Every truncation of a real certificate: never a throw. */
    for (let length = 0; length < raw.length; length++) {
      expect(() => subjectPublicKeyInfo(raw.subarray(0, length))).not.toThrow();
    }
  });
});

/** A DANE-TA verdict whose anchor is the presented certificate just above the leaf. */
const PRESENTED_DEPTH_1: DaneVerdict = {
  ok: true,
  usage: "DANE-TA",
  anchor: "presented",
  depth: 1,
};

describe("DANE-TA(2) (RFC 7672 3.1.2, 3.2)", () => {
  test("the anchor in the chain: signatures, dates and names hold", () => {
    for (const r of [record(2, 0, 1, ca), record(2, 1, 1, ca), record(2, 0, 2, ca)]) {
      expect(verifyDaneChain([taLeaf, ca], host([r]), NOW)).toEqual(PRESENTED_DEPTH_1);
    }
  });

  test("the next-hop domain is a reference identifier too", () => {
    expect(
      verifyDaneChain(
        [taLeaf, ca],
        host([record(2, 0, 1, ca)], ["other.example", "mx.dane.example"]),
        NOW,
      ),
    ).toEqual(PRESENTED_DEPTH_1);
  });

  test("a leaf naming none of the reference identifiers fails", () => {
    expect(
      verifyDaneChain(
        [taLeaf, ca],
        host([record(2, 0, 1, ca)], ["mx.example.org", "example.org"]),
        NOW,
      ),
    ).toEqual({ ok: false, failure: "name-mismatch" });
  });

  test("wildcards: the whole first label, one label only", () => {
    const anchor = [record(2, 0, 1, ca)];
    expect(
      verifyDaneChain([taWildcard, ca], host(anchor, ["mx.dane.example"]), NOW).ok,
    ).toBe(true);
    expect(
      verifyDaneChain([taWildcard, ca], host(anchor, ["a.b.dane.example"]), NOW),
    ).toEqual({
      ok: false,
      failure: "name-mismatch",
    });
    expect(
      verifyDaneChain([taWildcard, ca], host(anchor, ["dane.example"]), NOW),
    ).toEqual({
      ok: false,
      failure: "name-mismatch",
    });
    /** With a DNS-ID present, the CN ("wildcard") is not a name. */
    expect(verifyDaneChain([taWildcard, ca], host(anchor, ["wildcard"]), NOW).ok).toBe(
      false,
    );
  });

  test("without any DNS-ID, the CN is the name", () => {
    expect(verifyDaneChain([taCnOnly, ca], host([record(2, 0, 1, ca)]), NOW).ok).toBe(
      true,
    );
  });

  test("a certificate below the anchor that has expired fails", () => {
    expect(verifyDaneChain([taExpired, ca], host([record(2, 0, 1, ca)]), NOW)).toEqual({
      ok: false,
      failure: "expired",
    });
  });

  test("a certificate below the anchor that is not yet valid fails", () => {
    expect(
      verifyDaneChain(
        [taLeaf, ca],
        host([record(2, 0, 1, ca)]),
        new Date("2001-01-01T00:00:00Z"),
      ),
    ).toEqual({ ok: false, failure: "not-yet-valid" });
  });

  test("a leaf not signed by the anchor (same issuer name, another key) fails", () => {
    expect(verifyDaneChain([taForged, ca], host([record(2, 0, 1, ca)]), NOW)).toEqual({
      ok: false,
      failure: "chain-invalid",
    });
  });

  test("a DANE-TA record never anchors the leaf itself, as in OpenSSL", () => {
    const refused: DaneVerdict = { ok: false, failure: "no-match" };
    /** Matching the leaf, even an expired one, or a copy of it sent again. */
    expect(verifyDaneChain([taLeaf], host([record(2, 0, 1, taLeaf)]), NOW)).toEqual(
      refused,
    );
    expect(verifyDaneChain([taExpired], host([record(2, 0, 1, taExpired)]), NOW)).toEqual(
      refused,
    );
    expect(
      verifyDaneChain([taLeaf, taLeaf], host([record(2, 1, 1, taLeaf)]), NOW),
    ).toEqual(refused);
    /** Carrying the leaf's own certificate or key in DNS (a self-signed leaf would verify under it). */
    for (const selector of [0, 1]) {
      expect(verifyDaneChain([ee], host([record(2, selector, 0, ee)]), NOW)).toEqual(
        refused,
      );
    }
    /** The same leaf published as DANE-EE is what authenticates it. */
    expect(verifyDaneChain([ee], host([record(3, 0, 1, ee)]), NOW).ok).toBe(true);
  });

  test("an anchor digest absent from the chain: no match", () => {
    expect(verifyDaneChain([taLeaf], host([record(2, 0, 1, ca)]), NOW)).toEqual({
      ok: false,
      failure: "no-match",
    });
  });

  test("an anchor carried in DNS (2 0 0, 2 1 0) above a chain without it", () => {
    const fromDns: DaneVerdict = { ok: true, usage: "DANE-TA", anchor: "dns", depth: 1 };
    expect(verifyDaneChain([taLeaf], host([record(2, 0, 0, ca)]), NOW)).toEqual(fromDns);
    expect(verifyDaneChain([taLeaf], host([record(2, 1, 0, ca)]), NOW)).toEqual(fromDns);
    /** A DNS anchor that signed nothing here is no match. */
    expect(verifyDaneChain([ee], host([record(2, 0, 0, ca)]), NOW)).toEqual({
      ok: false,
      failure: "no-match",
    });
  });

  test("a DANE-TA record matching nothing, beside a matching DANE-EE one", () => {
    expect(
      verifyDaneChain([ee], host([record(2, 0, 1, ca), record(3, 1, 1, ee)]), NOW),
    ).toEqual({ ok: true, usage: "DANE-EE" });
  });
});

describe("DANE-TA(2) paths over a three-level chain (#455, RFC 7671 5.2, RFC 5280 6.1)", () => {
  /** Root, intermediate (pathlen 0, from 2024) and leaf (from 2020): see the fixtures' README. */
  const root = cert("ta3-root");
  const int = cert("ta3-int");
  const leaf = cert("ta3-leaf");
  const chain = [leaf, int, root];

  /** A DANE-TA verdict for a presented anchor `depth` certificates above the leaf. */
  function presented(depth: number): DaneVerdict {
    return { ok: true, usage: "DANE-TA", anchor: "presented", depth };
  }

  const VARIANTS = [
    [0, 0],
    [0, 1],
    [0, 2],
    [1, 0],
    [1, 1],
    [1, 2],
  ] as const;

  for (const [selector, matchingType] of VARIANTS) {
    test(`2 ${selector} ${matchingType}: the root anchors the whole chain, the intermediate in the middle anchors it too`, () => {
      expect(
        verifyDaneChain(chain, host([record(2, selector, matchingType, root)]), NOW),
      ).toEqual(presented(2));
      expect(
        verifyDaneChain(chain, host([record(2, selector, matchingType, int)]), NOW),
      ).toEqual(presented(1));
    });
  }

  test("a two-level path inside a longer presented chain: [leaf, intermediate] alone", () => {
    expect(verifyDaneChain([leaf, int], host([record(2, 0, 1, int)]), NOW)).toEqual(
      presented(1),
    );
  });

  test("an anchor digest the server did not present: no match (RFC 7671 5.2.2)", () => {
    for (const [selector, matchingType] of VARIANTS.filter(([, m]) => m !== 0)) {
      expect(
        verifyDaneChain(
          [leaf, int],
          host([record(2, selector, matchingType, root)]),
          NOW,
        ),
      ).toEqual({ ok: false, failure: "no-match" });
    }
  });

  test("an anchor carried in full by DNS signs the top of a chain without it (2 0 0, 2 1 0)", () => {
    for (const selector of [0, 1]) {
      expect(
        verifyDaneChain([leaf, int], host([record(2, selector, 0, root)]), NOW),
      ).toEqual({
        ok: true,
        usage: "DANE-TA",
        anchor: "dns",
        depth: 2,
      });
    }
  });

  test("the anchor's dates are not checked, those below it are (RFC 5280 6.1.1, 6.1.3)", () => {
    /** In 2022 the intermediate is not yet valid, the root and the leaf are. */
    const in2022 = new Date("2022-06-01T00:00:00Z");
    expect(verifyDaneChain(chain, host([record(2, 0, 1, int)]), in2022)).toEqual(
      presented(1),
    );
    expect(verifyDaneChain(chain, host([record(2, 0, 1, root)]), in2022)).toEqual({
      ok: false,
      failure: "not-yet-valid",
    });
  });

  test("the certificates may come out of order or with extra ones (RFC 8446 4.4.2)", () => {
    const anchor = host([record(2, 0, 1, root)]);
    expect(verifyDaneChain([leaf, root, int], anchor, NOW)).toEqual(presented(2));
    expect(verifyDaneChain([leaf, ca, ee, root, int], anchor, NOW)).toEqual(presented(2));
    /** The first certificate is the leaf, whatever follows: here the intermediate, which names no reference identifier. */
    expect(verifyDaneChain([int, leaf, root], anchor, NOW)).toEqual({
      ok: false,
      failure: "name-mismatch",
    });
  });

  test("a broken link: the intermediate under the anchor's name is signed by another key", () => {
    const forged = cert("ta3-int-forged");
    expect(
      verifyDaneChain([leaf, forged, root], host([record(2, 0, 1, root)]), NOW),
    ).toEqual({
      ok: false,
      failure: "chain-invalid",
    });
    /** The real intermediate's certificate digest does not match the forged one. */
    expect(
      verifyDaneChain([leaf, forged, root], host([record(2, 0, 1, int)]), NOW),
    ).toEqual({
      ok: false,
      failure: "no-match",
    });
    /** Its key does (same key): SPKI(1) binds the key only, which signed the leaf. */
    expect(
      verifyDaneChain([leaf, forged, root], host([record(2, 1, 1, int)]), NOW),
    ).toEqual(presented(1));
  });

  test("a leaf another CA issued does not chain to a matched anchor", () => {
    expect(
      verifyDaneChain([taLeaf, int, root], host([record(2, 0, 1, root)]), NOW),
    ).toEqual({
      ok: false,
      failure: "chain-invalid",
    });
    expect(
      verifyDaneChain([taLeaf, int, root], host([record(2, 0, 0, root)]), NOW),
    ).toEqual({
      ok: false,
      failure: "chain-invalid",
    });
  });

  test("a leaf naming none of the reference identifiers fails after the path holds", () => {
    expect(
      verifyDaneChain(
        chain,
        host([record(2, 0, 1, root)], ["mx.example.org", "example.org"]),
        NOW,
      ),
    ).toEqual({ ok: false, failure: "name-mismatch" });
  });

  test("path length: an intermediate's pathlen 0 refuses a sub-CA below it, as the anchor too", () => {
    const sub = cert("ta3-sub");
    const deep = cert("ta3-deep-leaf");
    const deepChain = [deep, sub, int, root];
    for (const anchor of [root, int]) {
      expect(verifyDaneChain(deepChain, host([record(2, 0, 1, anchor)]), NOW)).toEqual({
        ok: false,
        failure: "chain-invalid",
      });
    }
    /** With the sub-CA as the anchor, the intermediate is not on the path. */
    expect(verifyDaneChain(deepChain, host([record(2, 0, 1, sub)]), NOW)).toEqual(
      presented(1),
    );
  });

  test("pathLengthConstraint reads basicConstraints from the DER", () => {
    expect(pathLengthConstraint(int.raw)).toBe(0);
    expect(pathLengthConstraint(root.raw)).toBeNull();
    expect(pathLengthConstraint(cert("ta3-sub").raw)).toBeNull();
    /** CA:FALSE, no pathLenConstraint. */
    expect(pathLengthConstraint(leaf.raw)).toBeNull();
    expect(pathLengthConstraint(new Uint8Array(0))).toBe("malformed");
    const raw = Uint8Array.from(int.raw);
    for (let length = 0; length < raw.length; length++) {
      expect(() => pathLengthConstraint(raw.subarray(0, length))).not.toThrow();
    }
  });

  test("beside DANE-EE records: either usage authenticates, neither fails", () => {
    expect(
      verifyDaneChain(chain, host([record(3, 1, 1, ee), record(2, 0, 1, root)]), NOW),
    ).toEqual(presented(2));
    expect(
      verifyDaneChain(chain, host([record(3, 1, 1, leaf), record(2, 0, 1, ca)]), NOW),
    ).toEqual({ ok: true, usage: "DANE-EE" });
    expect(
      verifyDaneChain(chain, host([record(3, 1, 1, ee), record(2, 0, 1, ca)]), NOW),
    ).toEqual({ ok: false, failure: "no-match" });
    /** A DANE-EE match skips the DANE-TA name and date checks. */
    expect(
      verifyDaneChain(
        chain,
        host([record(3, 0, 1, leaf), record(2, 0, 1, root)], ["unrelated.example"]),
        new Date("2022-06-01T00:00:00Z"),
      ),
    ).toEqual({ ok: true, usage: "DANE-EE" });
  });
});

/** The certificates of a PEM bundle fixture, in file order. */
function bundle(name: string): X509Certificate[] {
  const text = readFileSync(new URL(`${name}.chain.pem`, DIR), "utf8");
  const blocks =
    text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((pem) => new X509Certificate(pem));
}

describe("DANE-TA(2) issuers that are not CAs (#455 review)", () => {
  /** Each bundle is [leaf, intermediate, root]; the root is the anchor. */
  for (const [name, what] of [
    ["bad-notca", "basicConstraints CA:FALSE (keyUsage keyCertSign)"],
    ["bad-nobc", "no basicConstraints at all (keyUsage keyCertSign)"],
    ["bad-nokcs", "CA:TRUE but keyUsage without keyCertSign"],
    ["bad-negpl", "a negative pathLenConstraint"],
  ] as const) {
    test(`an intermediate with ${what} breaks the path`, () => {
      const chain = bundle(name);
      const [leaf, int, root] = chain;
      if (leaf === undefined || int === undefined || root === undefined) {
        throw new Error("bundle of three expected");
      }
      /** The signature itself holds: only the issuer checks refuse it. */
      expect(leaf.verify(int.publicKey)).toBe(true);
      expect(verifyDaneChain(chain, host([record(2, 0, 1, root)]), NOW)).toEqual({
        ok: false,
        failure: "chain-invalid",
      });
      /** As the anchor itself: not a CA, so it issues nothing either. */
      expect(verifyDaneChain(chain, host([record(2, 0, 1, int)]), NOW)).toEqual({
        ok: false,
        failure: "chain-invalid",
      });
    });
  }

  test("checkIssued alone accepts CA:FALSE and missing basicConstraints: the CA flag refuses them", () => {
    for (const name of ["bad-notca", "bad-nobc"]) {
      const [leaf, int] = bundle(name);
      if (leaf === undefined || int === undefined) throw new Error("bundle expected");
      expect(leaf.checkIssued(int)).toBe(true);
      expect(int.ca).toBe(false);
    }
  });

  test("a negative pathLenConstraint is malformed to the DER reader too", () => {
    const [, int] = bundle("bad-negpl");
    if (int === undefined) throw new Error("bundle expected");
    expect(pathLengthConstraint(int.raw)).toBe("malformed");
  });
});

describe("DANE-TA(2) cost bound (#455 review)", () => {
  /**
   * The hostile shape: ten self-signed CA certificates sharing one subject
   * and one P-521 key (each issues every other, so the paths multiply),
   * and many "2 1 0" P-521 keys that sign nothing here. Unbounded, every
   * partial path times every DNS anchor cost a fresh verification (60
   * anchors took 9 s).
   */
  const loop = bundle("ta-loop");
  const anchors: TlsaRecord[] = Array.from({ length: 60 }, () => ({
    usage: 2,
    selector: 1,
    matchingType: 0,
    data: Uint8Array.from(
      generateKeyPairSync("ec", { namedCurve: "P-521" }).publicKey.export({
        type: "spki",
        format: "der",
      }),
    ),
  }));

  test(`at most ${MAX_SIGNATURE_CHECKS} signature verifications, then chain-invalid`, () => {
    expect(loop).toHaveLength(10);
    const verify = spyOn(X509Certificate.prototype, "verify");
    try {
      const started = performance.now();
      const verdict = verifyDaneChain(
        loop,
        host([...anchors, record(2, 0, 1, ee)], ["mx.dane.example"]),
        NOW,
      );
      const elapsed = performance.now() - started;
      expect(verdict).toEqual({ ok: false, failure: "chain-invalid" });
      expect(verify.mock.calls.length).toBeLessThanOrEqual(MAX_SIGNATURE_CHECKS);
      /** Generous: 64 P-521 verifications take well under a second. */
      expect(elapsed).toBeLessThan(3_000);
    } finally {
      verify.mockRestore();
    }
  });

  test("the budget does not stop a real path", () => {
    const verify = spyOn(X509Certificate.prototype, "verify");
    try {
      const root = cert("ta3-root");
      const chain = [cert("ta3-leaf"), ca, ee, root, cert("ta3-int")];
      expect(
        verifyDaneChain(chain, host([...anchors, record(2, 0, 1, root)]), NOW).ok,
      ).toBe(true);
      expect(verify.mock.calls.length).toBeLessThanOrEqual(MAX_SIGNATURE_CHECKS);
    } finally {
      verify.mockRestore();
    }
  });
});

/** A fake TLS socket presenting `chain` (leaf first), linked like Node's `getPeerCertificate(true)`. */
function fakeSocket(
  chain: X509Certificate[],
  cipher: string | null = "TLS_AES_128_GCM_SHA256",
): PeerCertificateSource {
  const nodes: PeerCertificateLink[] = chain.map((c) => ({
    raw: Uint8Array.from(c.raw),
    fingerprint256: c.fingerprint256,
  }));
  nodes.forEach((node, i) => {
    /** The last one links to itself, as Node does for a self-signed root. */
    node.issuerCertificate = nodes[i + 1] ?? node;
  });
  return {
    getPeerCertificate: () => nodes[0] ?? {},
    getCipher: () => (cipher === null ? {} : { name: cipher }),
  };
}

describe("peerChain and daneSocketCheck", () => {
  test("the chain is read leaf first, stopping at a self-signed certificate", () => {
    expect(peerChain(fakeSocket([taLeaf, ca])).map((c) => c.fingerprint256)).toEqual([
      taLeaf.fingerprint256,
      ca.fingerprint256,
    ]);
    expect(peerChain(fakeSocket([]))).toEqual([]);
  });

  /** A host with `records`. */
  function daneHost(records: TlsaRecord[]): DaneHost {
    return {
      mxHost: "mx.dane.example",
      baseDomain: "mx.dane.example",
      referenceIds: ["mx.dane.example", "example.org"],
      records,
      usable: usableTlsa(records),
    };
  }

  test("a match lets the session go on; a mismatch is a fixed DANE error", () => {
    const socket = fakeSocket([ee]);
    expect(daneSocketCheck(daneHost([record(3, 1, 1, ee)]))(socket)).toBeNull();
    const error = daneSocketCheck(daneHost([record(3, 1, 1, taLeaf)]))(socket);
    expect(error?.message).toBe(DANE_FAILURE_MESSAGES["no-match"]);
  });

  test("a handshake that did not complete fails first, even with no usable record", () => {
    const encryptedOnly = daneHost([{ ...record(3, 1, 1, taLeaf), usage: 1 }]);
    /** No cipher negotiated. */
    expect(daneSocketCheck(encryptedOnly)(fakeSocket([ee], null))?.message).toBe(
      DANE_HANDSHAKE_INCOMPLETE,
    );
    /** No server certificate. */
    expect(daneSocketCheck(encryptedOnly)(fakeSocket([]))?.message).toBe(
      DANE_HANDSHAKE_INCOMPLETE,
    );
    expect(
      daneSocketCheck(daneHost([record(3, 1, 1, ee)]))(fakeSocket([ee], null))?.message,
    ).toBe(DANE_HANDSHAKE_INCOMPLETE);
  });

  test("no usable record: any TLS session passes (TLS required, not authenticated)", () => {
    const socket = fakeSocket([ee]);
    expect(
      daneSocketCheck(daneHost([{ ...record(3, 1, 1, taLeaf), usage: 1 }]))(socket),
    ).toBeNull();
  });

  test("the clock is the caller's", () => {
    const check = daneSocketCheck(
      daneHost([record(2, 0, 1, ca)]),
      () => new Date("2001-01-01"),
    );
    expect(check(fakeSocket([taLeaf, ca]))?.message).toBe(
      DANE_FAILURE_MESSAGES["not-yet-valid"],
    );
  });
});
