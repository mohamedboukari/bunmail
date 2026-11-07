import { X509Certificate, createHash, createPublicKey, type KeyObject } from "crypto";
import type { TlsaRecord } from "../../../utils/dns-rdata.ts";
import type { DaneHost } from "../types/dane.types.ts";
import { isSubjectPublicKeyInfo, subjectPublicKeyInfo } from "./dane-der.ts";

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
 * **DANE-TA(2) is unusable under Bun 1.3.14** ({@link PEER_CHAIN_AVAILABLE}):
 * its TLS client exposes only the server's leaf certificate, so the
 * anchor a DANE-TA record names cannot be found in the presented chain.
 * Such records are treated as unsupported by the implementation, hence
 * unusable (RFC 7672 sections 2.2.3 and 3.1.3): a host whose records are
 * all DANE-TA gets mandatory TLS without authentication, and a host with
 * DANE-EE records beside them is authenticated by the DANE-EE ones only.
 * The DANE-TA matching below is kept and tested on explicit chains, to be
 * switched back on when the runtime exposes the chain.
 *
 * **DANE-EE(3)** (RFC 7672 section 3.1.1, RFC 7671 section 5.1): the leaf
 * certificate (selector 0) or its public key (selector 1) must match.
 * Names and validity dates are ignored: the TLSA record's DNSSEC signature
 * is what dates the binding.
 *
 * **DANE-TA(2)** (RFC 7672 section 3.1.2, RFC 7671 section 5.2): a
 * certificate of the presented chain must match the record; that is the
 * trust anchor. Every certificate below it must be issued and signed by
 * the next one up (`checkIssued` and the signature), each intermediate
 * must be a CA, and each must be within its validity period. The trust
 * anchor's own dates are not checked: a trust anchor is an input to path
 * validation, not part of the path (RFC 5280 section 6.1.1), and here it
 * is vouched for by DNSSEC. When no presented certificate matches, a
 * "2 0 0" record carries the anchor certificate itself and a "2 1 0"
 * record its public key, and the top of the chain may be signed by it
 * (RFC 7671 sections 5.2.2 and 5.2.3). Finally the leaf must name one of
 * the reference identifiers (RFC 7672 sections 3.2.2 and 3.2.3): only its
 * DNS-IDs when it has any, else its CN; a wildcard only as the whole
 * first label, matching exactly one label.
 */

/**
 * Whether the TLS client exposes the server's certificate chain, which
 * DANE-TA(2) matching needs. `false` under Bun 1.3.14 (no
 * `issuerCertificate` from `getPeerCertificate(true)`), so DANE-TA records
 * are unusable ({@link usableTlsa}). `test/unit/mx-transport-dane.test.ts`
 * fails once Bun exposes the chain: then set this to `true`.
 */
export const PEER_CHAIN_AVAILABLE = false;

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

/** Longest peer chain read from a TLS session. */
const MAX_CHAIN_LENGTH = 10;

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

/**
 * Whether one record is usable for SMTP, before agility (see the module
 * comment); DANE-TA only when the peer chain can be seen.
 */
function isUsable(record: TlsaRecord, peerChainAvailable: boolean): boolean {
  if (record.usage === DANE_TA && !peerChainAvailable) return false;
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
 * `peerChainAvailable` decides whether DANE-TA records count; production
 * uses {@link PEER_CHAIN_AVAILABLE}, the matcher's tests pass `true`.
 */
export function usableTlsa(
  records: readonly TlsaRecord[],
  peerChainAvailable: boolean = PEER_CHAIN_AVAILABLE,
): TlsaRecord[] {
  const usable = records.filter((record) => isUsable(record, peerChainAvailable));
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
  { ok: true; usage: "DANE-EE" | "DANE-TA" } | { ok: false; failure: DaneFailure };

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

/** The trust anchor of a DANE-TA path: a certificate (in the chain or from DNS) or a bare key. */
interface Anchor {
  key: KeyObject;
  cert: X509Certificate | null;
}

/**
 * Checks a DANE-TA path (see the module comment): `below` are the
 * certificates under the anchor, leaf first; empty when the anchor is the
 * leaf itself (`leaf`). `null` when the path holds.
 */
function checkTaPath(
  below: readonly X509Certificate[],
  anchor: Anchor,
  leaf: X509Certificate,
  referenceIds: readonly string[],
  now: Date,
): DaneFailure | null {
  try {
    if (!signaturesHold(below, anchor)) return "chain-invalid";
  } catch {
    /** A key the runtime cannot parse (RSA-PSS under Bun) cannot verify anything. */
    return "chain-invalid";
  }
  for (const cert of below) {
    if (now.getTime() < Date.parse(cert.validFrom)) return "not-yet-valid";
    if (now.getTime() > Date.parse(cert.validTo)) return "expired";
  }
  const named = referenceIds.some((id) => leaf.checkHost(id, NAME_CHECK) !== undefined);
  return named ? null : "name-mismatch";
}

/** Whether every certificate of `below` was issued and signed by the next one up, the last by `anchor`. */
function signaturesHold(below: readonly X509Certificate[], anchor: Anchor): boolean {
  for (let j = 0; j < below.length; j++) {
    const cert = below[j];
    if (cert === undefined) return false;
    const issuer = below[j + 1];
    if (issuer !== undefined) {
      /** An intermediate below the anchor must be a CA that issued and signed `cert`. */
      if (!issuer.ca || !cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) {
        return false;
      }
    } else {
      if (anchor.cert !== null && !cert.checkIssued(anchor.cert)) return false;
      if (!cert.verify(anchor.key)) return false;
    }
  }
  return true;
}

/** The anchors DNS itself carries ("2 0 0" and "2 1 0"), for a chain without the anchor in it. */
function dnsAnchors(records: readonly TlsaRecord[]): Anchor[] {
  const anchors: Anchor[] = [];
  for (const record of records) {
    if (record.usage !== DANE_TA || record.matchingType !== MATCH_FULL) continue;
    try {
      if (record.selector === SELECTOR_CERT) {
        const cert = new X509Certificate(record.data);
        anchors.push({ key: cert.publicKey, cert });
      } else {
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

  /** DANE-TA(2): an anchor in the chain, then one from DNS above its top. */
  const taRecords = host.usable.filter((record) => record.usage === DANE_TA);
  let failure: DaneFailure = "no-match";
  const worse = (next: DaneFailure): void => {
    if (FAILURE_RANK[next] > FAILURE_RANK[failure]) failure = next;
  };
  for (let depth = 0; depth < chain.length; depth++) {
    const cert = chain[depth];
    if (cert === undefined || !taRecords.some((record) => matches(record, cert)))
      continue;
    let anchor: Anchor;
    try {
      anchor = { key: cert.publicKey, cert };
    } catch {
      worse("chain-invalid");
      continue;
    }
    const pathFailure = checkTaPath(
      chain.slice(0, depth),
      anchor,
      leaf,
      host.referenceIds,
      now,
    );
    if (pathFailure === null) return { ok: true, usage: "DANE-TA" };
    worse(pathFailure);
  }
  for (const anchor of dnsAnchors(taRecords)) {
    const pathFailure = checkTaPath(chain, anchor, leaf, host.referenceIds, now);
    if (pathFailure === null) return { ok: true, usage: "DANE-TA" };
    /** An anchor that signed nothing here is not a match, only a non-match. */
    if (pathFailure !== "chain-invalid") worse(pathFailure);
  }
  return { ok: false, failure };
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
 * {@link MAX_CHAIN_LENGTH} certificates; a self-signed certificate ends it.
 *
 * Bun 1.3.14 links no `issuerCertificate` (Node does), so under Bun this is
 * the leaf alone, which is why DANE-TA records are unusable there
 * ({@link PEER_CHAIN_AVAILABLE}). `test/unit/mx-transport-dane.test.ts`
 * pins this.
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
 * really complete (no cipher negotiated, or no server certificate: Bun can
 * call back for a handshake the peer refused) fails at once, so it never
 * waits out the STARTTLS stall limit. Then, with no usable record, any
 * TLS session passes (RFC 7672 section 2.2: TLS required, authentication
 * not).
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
    return verdict.ok ? null : new Error(DANE_FAILURE_MESSAGES[verdict.failure]);
  };
}
