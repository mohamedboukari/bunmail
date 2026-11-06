import type { KeyObject } from "crypto";

/**
 * Types of the DKIM verifier (#373, `services/dkim-verifier.service.ts`):
 * its public results and seams, and the parsed signature and key record
 * the verifier's files pass to each other.
 */

/** The verdict on one signature (RFC 8601 section 2.7.1, without `none`). */
export type DkimResult =
  "pass" | "fail" | "neutral" | "temperror" | "permerror" | "policy";

/** What the verifier found for one DKIM-Signature header field. */
export interface DkimSignatureResult {
  result: DkimResult;
  /** `d=` as written in the signature, or null when it has none. */
  signingDomain: string | null;
  /** `s=` as written in the signature, or null when it has none. */
  selector: string | null;
  /** Why the result is not `pass`, for logs; null on `pass`. */
  reason: string | null;
  /** The key record has `t=y`: the domain is testing DKIM (RFC 6376 section 3.6.1). */
  testing: boolean;
}

/** Injectable for tests: the TXT lookup and the clock. */
export interface DkimVerifyDeps {
  /** A TXT lookup shaped like `dns/promises.resolveTxt`: one entry per record, each a list of strings. */
  resolveTxt?: (name: string) => Promise<string[][]>;
  now?: () => number;
}

/** The signing algorithms a DKIM-Signature can name and this verifier knows. */
type Algorithm = "rsa-sha256" | "ed25519-sha256" | "rsa-sha1";

/** A canonicalization algorithm (RFC 6376 section 3.4). */
export type Canonicalization = "simple" | "relaxed";

/** One header field: its lowercased name and the raw field, folds included, without the final CRLF. */
export interface HeaderField {
  name: string;
  raw: string;
}

/** A DKIM-Signature that passed the syntax checks. */
export interface ParsedSignature {
  algorithm: Algorithm;
  signature: Buffer;
  bodyHash: string;
  headerCanon: Canonicalization;
  bodyCanon: Canonicalization;
  /** `d=` as an A-label in lower case, for the key lookup. */
  domain: string;
  /** `s=` as an A-label in lower case, for the key lookup. */
  selector: string;
  /** `h=`, lowercased, in order. */
  signedHeaders: string[];
  /** The domain of `i=` as an A-label in lower case, or null without `i=`. */
  identityDomain: string | null;
  bodyLength: number | null;
  expiration: number | null;
}

/** A public key record that passed the syntax checks. */
export interface DkimKey {
  type: "rsa" | "ed25519";
  key: KeyObject;
  /** The hash algorithms the key allows (`h=`), or null for all. */
  hashes: string[] | null;
  /** `t=` flags, lowercased. */
  flags: string[];
}

/** A failed step: the result and why. */
export interface Failure {
  result: DkimResult;
  reason: string;
}
