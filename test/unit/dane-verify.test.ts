import { describe, test, expect } from "bun:test";
import { X509Certificate, createHash } from "crypto";
import { readFileSync } from "fs";
import {
  DANE_FAILURE_MESSAGES,
  DANE_HANDSHAKE_INCOMPLETE,
  daneSocketCheck,
  PEER_CHAIN_AVAILABLE,
  peerChain,
  usableTlsa,
  verifyDaneChain,
  type PeerCertificateLink,
  type PeerCertificateSource,
} from "../../src/modules/emails/services/dane-verify.ts";
import type { DaneHost } from "../../src/modules/emails/types/dane.types.ts";
import type { TlsaRecord } from "../../src/utils/dns-rdata.ts";
import { subjectPublicKeyInfo } from "../../src/modules/emails/services/dane-der.ts";

/**
 * DANE authentication of the server's certificate chain (#345, RFC 7672
 * section 3, `dane-verify.ts`), with the fixture certificates of
 * `test/fixtures/tls/dane/` (see its README): which TLSA records are
 * usable, DANE-EE matching (no names, no dates), DANE-TA chains (the
 * anchor in the chain or from DNS, signatures, dates below the anchor,
 * name checks with wildcards).
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
  /** The matcher on an explicit chain: DANE-TA counts as if the runtime exposed it. */
  return { usable: usableTlsa(records, true), referenceIds };
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
    expect(usableTlsa([sha256, sha512, full, taSha256], true)).toEqual([
      sha512,
      full,
      taSha256,
    ]);
  });

  test("under Bun 1.3.14 DANE-TA is unusable: only DANE-EE records remain", () => {
    expect(PEER_CHAIN_AVAILABLE).toBe(false);
    const ee311 = record(3, 1, 1, ee);
    const ta201 = record(2, 0, 1, ca);
    const ta200 = record(2, 0, 0, ca);
    /** Only DANE-TA: nothing usable, so TLS is required without authentication. */
    expect(usableTlsa([ta201, ta200])).toEqual([]);
    /** DANE-EE beside DANE-TA: authenticated by the DANE-EE records only. */
    expect(usableTlsa([ee311, ta201])).toEqual([ee311]);
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

describe("DANE-TA(2) (RFC 7672 3.1.2, 3.2)", () => {
  test("the anchor in the chain: signatures, dates and names hold", () => {
    for (const r of [record(2, 0, 1, ca), record(2, 1, 1, ca), record(2, 0, 2, ca)]) {
      expect(verifyDaneChain([taLeaf, ca], host([r]), NOW)).toEqual({
        ok: true,
        usage: "DANE-TA",
      });
    }
  });

  test("the next-hop domain is a reference identifier too", () => {
    expect(
      verifyDaneChain(
        [taLeaf, ca],
        host([record(2, 0, 1, ca)], ["other.example", "mx.dane.example"]),
        NOW,
      ),
    ).toEqual({ ok: true, usage: "DANE-TA" });
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

  test("the anchor's own dates are not checked, and the leaf may be the anchor", () => {
    expect(verifyDaneChain([taLeaf], host([record(2, 0, 1, taLeaf)]), NOW)).toEqual({
      ok: true,
      usage: "DANE-TA",
    });
    expect(verifyDaneChain([taExpired], host([record(2, 0, 1, taExpired)]), NOW)).toEqual(
      { ok: true, usage: "DANE-TA" },
    );
  });

  test("an anchor digest absent from the chain: no match", () => {
    expect(verifyDaneChain([taLeaf], host([record(2, 0, 1, ca)]), NOW)).toEqual({
      ok: false,
      failure: "no-match",
    });
  });

  test("an anchor carried in DNS (2 0 0, 2 1 0) above a chain without it", () => {
    expect(verifyDaneChain([taLeaf], host([record(2, 0, 0, ca)]), NOW)).toEqual({
      ok: true,
      usage: "DANE-TA",
    });
    expect(verifyDaneChain([taLeaf], host([record(2, 1, 0, ca)]), NOW)).toEqual({
      ok: true,
      usage: "DANE-TA",
    });
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
      usable: usableTlsa(records, true),
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
