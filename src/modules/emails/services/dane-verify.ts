import { X509Certificate, createHash, createPublicKey, type KeyObject } from "crypto";
import type { TlsaRecord } from "../../../utils/dns-rdata.ts";
import { logger } from "../../../utils/logger.ts";
import type { DaneHost } from "../types/dane.types.ts";
import {
  isSubjectPublicKeyInfo,
  pathLengthConstraint,
  subjectPublicKeyInfo,
} from "./dane-der.ts";

/**
 * DANE authentication of an SMTP server (RFC 7672 section 3, #345): which
 * TLSA records are usable, and whether the certificate chain the server
 * presented matches one of them. Pure (the clock is a parameter), so every
 * case is unit-tested with fixed certificates.
 *
 * **Usable records** ({@link usableTlsa}): certificate usage DANE-TA(2) or
 * DANE-EE(3) (PKIX-TA(0) and PKIX-EE(1) are unusable for SMTP, RFC 7672
 * section 3.1.3), selector Cert(0) or SPKI(1), matching type Full(0),
 * SHA2-256(1) or SHA2-512(2), and data of the right length (a digest of
 * the wrong size, or Full(0) data that is not a certificate or a public
 * key, is malformed and unusable, RFC 6698 section 4.1). Then digest
 * algorithm agility (RFC 7671 section 9, required by RFC 7672 section 5):
 * for each usage and selector, the Full(0) records and only the strongest
 * digest present (SHA2-512 over SHA2-256) are kept.
 *
 * **DANE-EE(3)** (RFC 7672 section 3.1.1, RFC 7671 section 5.1): the leaf
 * certificate (selector 0) or its public key (selector 1) must match.
 * Names and validity dates are ignored (RFC 7672 section 3.2.1, RFC 7671
 * section 5.1): the TLSA record's DNSSEC signature is what dates the
 * binding.
 *
 * **DANE-TA(2)** (RFC 7672 sections 3.1.2 and 3.2, RFC 7671 section 5.2,
 * #455): a certification path from the leaf up to a trust anchor the
 * records name, built from the certificates the server presented:
 *
 * 1. **The anchor.** A presented certificate above the leaf that a record
 *    matches, or, above the top of a path, an anchor a record carries in
 *    full: a "2 0 0" certificate or a "2 1 0" public key (RFC 7671
 *    sections 5.2.2 and 5.2.3; at most {@link MAX_DNS_ANCHORS} of them).
 *    A DANE-TA record never makes the leaf its own anchor, neither by
 *    matching it (or a certificate with its key) nor by carrying its key: as in OpenSSL (which Postfix
 *    uses), DANE-TA matches only issuers, and a server that wants its
 *    leaf trusted as is publishes DANE-EE.
 * 2. **The links.** Each certificate of the path is issued by the next one
 *    up (`checkIssued`: the issuer's subject is its issuer name, the key
 *    identifiers agree, and the issuer's keyUsage, when present, allows
 *    certificate signing) and carries its signature (`verify` with the
 *    issuer's key); every issuer certificate is a CA (basicConstraints cA,
 *    RFC 5280 section 6.1.4 (k)). For the anchor certificate this binds
 *    only as far as the record does: with selector Cert(0) the record
 *    fixes the whole certificate, its CA flag and constraints included;
 *    with SPKI(1) it fixes only the key, the anchor's own signature is
 *    never checked, so whoever holds that key can mint a certificate
 *    around it with any flags (RFC 7671 sections 5.2.1 and 5.2.3: key-based
 *    anchors carry no constraints). The path is searched over the
 *    presented certificates in any order, since TLS 1.3 lets a server
 *    send them out of order or with extra ones (RFC 8446 section 4.4.2),
 *    at most {@link MAX_CHAIN_LENGTH} certificates and
 *    {@link MAX_SIGNATURE_CHECKS} signature verifications: the check runs
 *    synchronously in the TLS callback, and a hostile domain chooses both
 *    the records and the chain, so past the budget the chain fails closed
 *    as not verifying.
 * 3. **Path length.** A pathLenConstraint on an intermediate or on the
 *    anchor certificate (see step 2 for what binds the latter) bounds the non-self-issued intermediates below it
 *    (RFC 5280 section 6.1.4 (l) and (m); for the anchor, RFC 7672 section
 *    3.1.2 and RFC 7671 section 5.2.1: apply the trust anchor
 *    certificate's constraints). Name constraints are not applied.
 * 4. **Dates.** Every certificate below the anchor, the leaf included,
 *    must be within its validity period (RFC 5280 section 6.1.3 (a)(2);
 *    RFC 7671 section 5.2.3 asks for it of the top certificate under a
 *    bare-key anchor, and section 5.1 reminds DANE-TA operators that
 *    their certificates expire). The anchor's own dates are not checked:
 *    a trust anchor is an input to path validation, not part of the path
 *    (RFC 5280 section 6.1.1), and here DNSSEC vouches for it.
 * 5. **The name.** The leaf must name one of the host's reference
 *    identifiers (RFC 7672 section 3.2.2: the TLSA base domain, the
 *    original next-hop domain and its CNAME expansion, see `dane.ts`):
 *    only its DNS-IDs when it has any, else its CN; a wildcard only as the
 *    whole first label, matching exactly one label (section 3.2.3).
 *
 * The chain is what Bun's `getPeerCertificate(true)` links (see
 * {@link peerChain}): the certificates the server sent, in the order it
 * sent them, and, when the last one is not self-signed, the root that
 * issued it if Bun's bundled trust store has it. A record matching that
 * root still authenticates (RFC 7671 section 5.2.2 lets a client ignore
 * local trust anchors, it does not require it): the record, not the
 * store, makes it the anchor.
 */

/** Certificate usages (RFC 7218). */
const DANE_TA = 2;
const DANE_EE = 3;
/** Selectors. */
const SELECTOR_CERT = 0;
const SELECTOR_SPKI = 1;
/** Matching types and the digest length each must have. */
const MATCH_FULL = 0;
const DIGEST_LENGTHS: ReadonlyMap<number, { algorithm: string; length: number }> =
  new Map([
    [1, { algorithm: "sha256", length: 32 }],
    [2, { algorithm: "sha512", length: 64 }],
  ]);

/** Longest peer chain read from a TLS session, and longest certification path built from it. */
const MAX_CHAIN_LENGTH = 10;
/** The most partial paths one DANE-TA check explores, so no presented set can make it costly. */
const MAX_PATH_STEPS = 256;
/** The most signature verifications one DANE-TA check runs; past it the chain is "chain-invalid". */
export const MAX_SIGNATURE_CHECKS = 64;
/** The most DNS-carried anchors ("2 0 0", "2 1 0") one check uses, in RRset order. */
const MAX_DNS_ANCHORS = 16;

/** How a certificate name is matched (RFC 7672 section 3.2.3, RFC 6125). */
const NAME_CHECK = {
  /** DNS-IDs only when the certificate has any, else the CN. */
  subject: "default",
  wildcards: true,
  /** `smtp*.example.com` and `*smtp.example.com` are not wildcards. */
  partialWildcards: false,
  /** `*.example.com` matches one label, never `a.b.example.com`. */
  multiLabelWildcards: false,
  singleLabelSubdomains: false,
} as const;

/**
 * Whether `record`'s Full(0) data is what its selector says: a certificate
 * whose SPKI can be read (selector 0), or one DER SubjectPublicKeyInfo
 * (selector 1). Structure only: the key itself need not be a type the
 * runtime can parse (an RSA-PSS key still matches byte for byte).
 */
function fullDataParses(record: TlsaRecord): boolean {
  if (record.selector === SELECTOR_SPKI) return isSubjectPublicKeyInfo(record.data);
  try {
    return subjectPublicKeyInfo(new X509Certificate(record.data).raw) !== null;
  } catch {
    return false;
  }
}

/** Whether one record is usable for SMTP, before agility (see the module comment). */
function isUsable(record: TlsaRecord): boolean {
  if (record.usage !== DANE_TA && record.usage !== DANE_EE) return false;
  if (record.selector !== SELECTOR_CERT && record.selector !== SELECTOR_SPKI)
    return false;
  if (record.matchingType === MATCH_FULL) {
    return record.data.length > 0 && fullDataParses(record);
  }
  const digest = DIGEST_LENGTHS.get(record.matchingType);
  return digest !== undefined && record.data.length === digest.length;
}

/**
 * The usable records of a TLSA RRset after digest algorithm agility (RFC
 * 7671 section 9): for each usage and selector, the Full(0) records and
 * the records of the strongest digest present. Empty when none is usable.
 */
export function usableTlsa(records: readonly TlsaRecord[]): TlsaRecord[] {
  const usable = records.filter(isUsable);
  const strongest = new Map<string, number>();
  for (const record of usable) {
    if (record.matchingType === MATCH_FULL) continue;
    const key = `${record.usage} ${record.selector}`;
    strongest.set(key, Math.max(strongest.get(key) ?? 0, record.matchingType));
  }
  return usable.filter(
    (record) =>
      record.matchingType === MATCH_FULL ||
      strongest.get(`${record.usage} ${record.selector}`) === record.matchingType,
  );
}

/** The bytes a record of `selector` is compared with: the certificate's DER or its SPKI's DER. */
function selected(cert: X509Certificate, selector: number): Buffer | null {
  if (selector === SELECTOR_CERT) return Buffer.from(cert.raw);
  /** The certificate's own SPKI bytes (RFC 6698 2.1.1), never a re-encoding of the key. */
  const spki = subjectPublicKeyInfo(cert.raw);
  return spki === null ? null : Buffer.from(spki);
}

/** Whether `cert` matches `record` (its selector, then its matching type); unreadable DER never does. */
function matches(record: TlsaRecord, cert: X509Certificate): boolean {
  const bytes = selected(cert, record.selector);
  if (bytes === null) return false;
  const digest = DIGEST_LENGTHS.get(record.matchingType);
  const compared =
    digest === undefined ? bytes : createHash(digest.algorithm).update(bytes).digest();
  return compared.equals(Buffer.from(record.data));
}

/** Why a chain did not authenticate, most specific last in {@link FAILURE_RANK}. */
export type DaneFailure =
  | "no-certificate"
  | "no-match"
  | "chain-invalid"
  | "not-yet-valid"
  | "expired"
  | "name-mismatch";

/** What {@link verifyDaneChain} found. */
export type DaneVerdict =
  | { ok: true; usage: "DANE-EE" }
  | {
      ok: true;
      usage: "DANE-TA";
      /** Where the trust anchor came from: the presented chain, or a full record in DNS. */
      anchor: "presented" | "dns";
      /** The certificates on the path below the anchor, the leaf included (at least 1). */
      depth: number;
    }
  | { ok: false; failure: DaneFailure };

/**
 * How specific a failure is: when several DANE-TA paths fail, the one that
 * got furthest is reported (a matched anchor with a name mismatch says
 * more than no match at all).
 */
const FAILURE_RANK: Record<DaneFailure, number> = {
  "no-certificate": 0,
  "no-match": 1,
  "chain-invalid": 2,
  "not-yet-valid": 3,
  expired: 4,
  "name-mismatch": 5,
};

/** The trust anchor of a DANE-TA path: a certificate (presented or from DNS) or a bare key from DNS. */
interface Anchor {
  key: KeyObject;
  cert: X509Certificate | null;
}

/** The signature verifications a DANE-TA check may still run (see {@link MAX_SIGNATURE_CHECKS}). */
interface SignatureBudget {
  left: number;
  /** Set once a verification was refused for want of budget. */
  spent: boolean;
}

/**
 * Whether `issuer` issued and signed `cert` (step 2 of the module
 * comment): when it is a certificate, a CA that `checkIssued` accepts;
 * then its key verifies `cert`'s signature, which takes one unit of
 * `budget` (none left: `false`, and the budget marked spent). A key the
 * runtime cannot parse (RSA-PSS under Bun) verifies nothing.
 */
function issuedBy(
  cert: X509Certificate,
  issuer: Anchor,
  budget: SignatureBudget,
): boolean {
  try {
    if (issuer.cert !== null && (!issuer.cert.ca || !cert.checkIssued(issuer.cert))) {
      return false;
    }
    if (budget.left <= 0) {
      budget.spent = true;
      return false;
    }
    budget.left -= 1;
    return cert.verify(issuer.key);
  } catch {
    return false;
  }
}

/** A presented certificate as an anchor or issuer; `null` when its key cannot be read. */
function asAnchor(cert: X509Certificate): Anchor | null {
  try {
    return { key: cert.publicKey, cert };
  } catch {
    return null;
  }
}

/**
 * Checks a DANE-TA path whose links already hold (steps 3 to 5 of the
 * module comment): `below` are the certificates under the anchor, leaf
 * first (empty when the anchor is the leaf itself), `anchor` the anchor
 * certificate (`null` for a bare key). `null` when the path holds.
 */
function checkTaPath(
  below: readonly X509Certificate[],
  anchor: X509Certificate | null,
  leaf: X509Certificate,
  referenceIds: readonly string[],
  now: Date,
): DaneFailure | null {
  const issuers = anchor === null ? below.slice(1) : [...below.slice(1), anchor];
  for (const [i, issuer] of issuers.entries()) {
    const limit = pathLengthConstraint(issuer.raw);
    if (limit === "malformed") return "chain-invalid";
    /** The non-self-issued intermediates between this issuer and the leaf. */
    const between = below.slice(1, i + 1).filter((c) => c.subject !== c.issuer).length;
    if (limit !== null && between > limit) return "chain-invalid";
  }
  for (const cert of below) {
    if (now.getTime() < Date.parse(cert.validFrom)) return "not-yet-valid";
    if (now.getTime() > Date.parse(cert.validTo)) return "expired";
  }
  const named = referenceIds.some((id) => leaf.checkHost(id, NAME_CHECK) !== undefined);
  return named ? null : "name-mismatch";
}

/**
 * The anchors DNS itself carries ("2 0 0" and "2 1 0"), for a path whose
 * top is not one: at most {@link MAX_DNS_ANCHORS}, and never one with the
 * leaf's own key (`leafSpki`), which would make the leaf its own anchor.
 */
function dnsAnchors(
  records: readonly TlsaRecord[],
  leafSpki: Uint8Array | null,
): Anchor[] {
  const anchors: Anchor[] = [];
  for (const record of records) {
    if (record.usage !== DANE_TA || record.matchingType !== MATCH_FULL) continue;
    if (anchors.length >= MAX_DNS_ANCHORS) break;
    try {
      if (record.selector === SELECTOR_CERT) {
        const cert = new X509Certificate(record.data);
        if (sameKey(subjectPublicKeyInfo(cert.raw), leafSpki)) continue;
        anchors.push({ key: cert.publicKey, cert });
      } else {
        if (sameKey(record.data, leafSpki)) continue;
        const key = createPublicKey({
          key: Buffer.from(record.data),
          format: "der",
          type: "spki",
        });
        anchors.push({ key, cert: null });
      }
    } catch {
      /** Checked usable already; skipped if it still does not parse. */
    }
  }
  return anchors;
}

/** Whether two DER SubjectPublicKeyInfos are the same bytes (an unreadable one matches nothing). */
function sameKey(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return a !== null && b !== null && Buffer.from(a).equals(Buffer.from(b));
}

/**
 * DANE-TA(2): searches the paths from the leaf (`chain[0]`) up through
 * the presented certificates, depth first, for one that ends at an anchor
 * `taRecords` name and passes {@link checkTaPath}. The issuer links are
 * computed once per pair (presented issuer or DNS anchor), at most
 * {@link MAX_PATH_STEPS} partial paths are explored and
 * {@link MAX_SIGNATURE_CHECKS} signatures verified. When none holds, the
 * failure of the path that got furthest; "chain-invalid" at least when a
 * presented certificate matched but no path reached it, or when the
 * signature budget ran out.
 */
function verifyTaPaths(
  chain: readonly X509Certificate[],
  taRecords: readonly TlsaRecord[],
  referenceIds: readonly string[],
  now: Date,
): DaneVerdict {
  const leaf = chain[0];
  if (leaf === undefined) return { ok: false, failure: "no-certificate" };
  /**
   * Issuers only: a DANE-TA record never matches the leaf, a copy of it,
   * or a certificate with its key (see the module comment).
   */
  const leafSpki = subjectPublicKeyInfo(leaf.raw);
  const matched = chain.map(
    (cert, i) =>
      i > 0 &&
      !sameKey(subjectPublicKeyInfo(cert.raw), leafSpki) &&
      taRecords.some((record) => matches(record, cert)),
  );
  const fromDns = dnsAnchors(taRecords, leafSpki);
  const budget: SignatureBudget = { left: MAX_SIGNATURE_CHECKS, spent: false };
  let failure: DaneFailure = matched.some(Boolean) ? "chain-invalid" : "no-match";
  const worse = (next: DaneFailure): void => {
    if (FAILURE_RANK[next] > FAILURE_RANK[failure]) failure = next;
  };
  const links = new Map<string, boolean>();
  /** Whether `chain[above]` issued `chain[below]`, computed once. */
  const linked = (below: number, above: number): boolean => {
    const key = `${below}>${above}`;
    let known = links.get(key);
    if (known === undefined) {
      const cert = chain[below];
      const issuer = chain[above];
      const anchor = issuer === undefined ? null : asAnchor(issuer);
      known = cert !== undefined && anchor !== null && issuedBy(cert, anchor, budget);
      links.set(key, known);
    }
    return known;
  };
  const dnsLinks = new Map<string, boolean>();
  /** Whether DNS anchor `a` issued `chain[below]`, computed once. */
  const dnsLinked = (below: number, a: number): boolean => {
    const key = `${below}>${a}`;
    let known = dnsLinks.get(key);
    if (known === undefined) {
      const cert = chain[below];
      const anchor = fromDns[a];
      known =
        cert !== undefined && anchor !== undefined && issuedBy(cert, anchor, budget);
      dnsLinks.set(key, known);
    }
    return known;
  };
  let steps = 0;

  /** Tries the path `path` (indexes into `chain`, leaf first), then each one issuer longer. */
  const visit = (path: readonly number[]): DaneVerdict | null => {
    steps += 1;
    const topIndex = path[path.length - 1];
    if (steps > MAX_PATH_STEPS || topIndex === undefined) return null;
    const certs = path.flatMap((i) => chain[i] ?? []);
    const top = certs[certs.length - 1];
    if (top === undefined) return null;
    if (matched[topIndex] === true) {
      const pathFailure = checkTaPath(certs.slice(0, -1), top, leaf, referenceIds, now);
      if (pathFailure === null) {
        return {
          ok: true,
          usage: "DANE-TA",
          anchor: "presented",
          depth: certs.length - 1,
        };
      }
      worse(pathFailure);
    }
    if (path.length < MAX_CHAIN_LENGTH) {
      for (let next = 1; next < chain.length; next++) {
        if (path.includes(next) || !linked(topIndex, next)) continue;
        const verdict = visit([...path, next]);
        if (verdict !== null) return verdict;
      }
    }
    /** Presented anchors first: a DNS anchor above this path only once every longer one failed. */
    for (const [a, anchor] of fromDns.entries()) {
      if (!dnsLinked(topIndex, a)) continue;
      const pathFailure = checkTaPath(certs, anchor.cert, leaf, referenceIds, now);
      if (pathFailure === null) {
        return { ok: true, usage: "DANE-TA", anchor: "dns", depth: certs.length };
      }
      worse(pathFailure);
    }
    return null;
  };

  const verdict = visit([0]);
  if (verdict !== null) return verdict;
  if (budget.spent) worse("chain-invalid");
  return { ok: false, failure };
}

/**
 * Whether the presented `chain` (leaf first, as the server sent it)
 * authenticates under `host`'s usable TLSA records at `now`; see the
 * module comment. With no usable record there is nothing to check: the
 * caller requires TLS without authentication instead.
 */
export function verifyDaneChain(
  chain: readonly X509Certificate[],
  host: Pick<DaneHost, "usable" | "referenceIds">,
  now: Date,
): DaneVerdict {
  const leaf = chain[0];
  if (leaf === undefined) return { ok: false, failure: "no-certificate" };

  /** DANE-EE(3): the leaf alone, no name or date checks (RFC 7672 3.1.1, 3.2.1). */
  if (host.usable.some((record) => record.usage === DANE_EE && matches(record, leaf))) {
    return { ok: true, usage: "DANE-EE" };
  }

  /** DANE-TA(2): a path up to an anchor (RFC 7672 3.1.2, 3.2.2, 3.2.3). */
  const taRecords = host.usable.filter((record) => record.usage === DANE_TA);
  if (taRecords.length === 0) return { ok: false, failure: "no-match" };
  return verifyTaPaths(chain, taRecords, host.referenceIds, now);
}

/**
 * The part of a peer certificate {@link peerChain} reads: its DER, its
 * fingerprint and its issuer, as `getPeerCertificate(true)` links them.
 */
export interface PeerCertificateLink {
  raw?: Uint8Array;
  fingerprint256?: string;
  issuerCertificate?: PeerCertificateLink;
}

/** What {@link peerChain} needs of a TLS socket (a `TLSSocket` has it). */
export interface PeerCertificateSource {
  getPeerCertificate(detailed: true): PeerCertificateLink;
  /** The negotiated cipher; no name when the handshake did not really complete. */
  getCipher(): { name?: string } | null | undefined;
}

/**
 * The certificate chain a TLS session's server presented, leaf first,
 * from `getPeerCertificate(true)` (its `issuerCertificate` links), at most
 * {@link MAX_CHAIN_LENGTH} certificates; a certificate linked twice (a
 * self-signed root links to itself) ends it.
 *
 * Bun 1.4.4 links the certificates in the order the server sent them, not
 * reordered as Node does, and appends the root that issued the last one
 * when its bundled trust store has it (#455); `verifyDaneChain` takes
 * them in any order. Bun 1.3.14 linked no `issuerCertificate`, so DANE-TA
 * was unusable until #455. `test/unit/mx-transport-dane.test.ts` pins
 * this.
 */
export function peerChain(socket: PeerCertificateSource): X509Certificate[] {
  const chain: X509Certificate[] = [];
  const seen = new Set<string>();
  let current: PeerCertificateLink | undefined = socket.getPeerCertificate(true);
  while (current !== undefined && chain.length < MAX_CHAIN_LENGTH) {
    const { raw, fingerprint256 } = current;
    if (raw === undefined || fingerprint256 === undefined || seen.has(fingerprint256))
      break;
    seen.add(fingerprint256);
    chain.push(new X509Certificate(raw));
    current = current.issuerCertificate;
  }
  return chain;
}

/**
 * The error text of each failure. Fixed strings: TLS-RPT classifies them
 * (`tls-rpt-classify.ts`) after nodemailer wraps them ("Error initiating
 * TLS - ...").
 */
export const DANE_FAILURE_MESSAGES: Record<DaneFailure, string> = {
  "no-certificate": "DANE: no TLSA record matches (no certificate presented)",
  "no-match": "DANE: no TLSA record matches the certificate chain",
  "chain-invalid":
    "DANE: certificate chain does not verify up to the DANE-TA trust anchor",
  "not-yet-valid": "DANE: certificate is not yet valid (below the DANE-TA trust anchor)",
  expired: "DANE: certificate has expired (below the DANE-TA trust anchor)",
  "name-mismatch": "DANE: certificate name mismatch (no reference identifier matches)",
};

/** The error of a STARTTLS handshake that did not really complete (no cipher, no certificate). */
export const DANE_HANDSHAKE_INCOMPLETE =
  "DANE: TLS handshake did not complete (no cipher or no server certificate)";

/**
 * The check nodemailer runs on the TLS socket right after the STARTTLS
 * handshake, before it sends anything over it (the `verifyTlsSocket`
 * option of BunMail's nodemailer patch, `patches/`): `null` lets the
 * session go on, an error ends it before EHLO, so no MAIL FROM is ever
 * sent to a server that failed DANE. First, a handshake that did not
 * really complete (no cipher negotiated, or no server certificate: Bun
 * 1.3.14 could call back for a handshake the peer refused; 1.4.4 fails
 * such a handshake itself, #447) fails at once, so it never
 * waits out the STARTTLS stall limit. Then, with no usable record, any
 * TLS session passes (RFC 7672 section 2.2: TLS required, authentication
 * not).
 *
 * Logs the verdict at `debug` (the MX host, the usage that matched or the
 * failure, the chain length, and for DANE-TA where the anchor came from
 * and its depth); a failure is logged at `warn` by the caller once the
 * session ends.
 */
export function daneSocketCheck(
  host: DaneHost,
  now: () => Date = () => new Date(),
): (socket: PeerCertificateSource) => Error | null {
  return (socket) => {
    const chain = peerChain(socket);
    if (!socket.getCipher()?.name || chain.length === 0) {
      return new Error(DANE_HANDSHAKE_INCOMPLETE);
    }
    if (host.usable.length === 0) return null;
    const verdict = verifyDaneChain(chain, host, now());
    const context = {
      mxHost: host.mxHost,
      baseDomain: host.baseDomain,
      chainLength: chain.length,
    };
    if (!verdict.ok) {
      logger.debug("DANE: certificate chain not authenticated", {
        ...context,
        failure: verdict.failure,
      });
      return new Error(DANE_FAILURE_MESSAGES[verdict.failure]);
    }
    logger.debug("DANE: certificate chain authenticated", {
      ...context,
      usage: verdict.usage,
      ...(verdict.usage === "DANE-TA"
        ? { anchor: verdict.anchor, depth: verdict.depth }
        : {}),
    });
    return null;
  };
}
