/**
 * DKIM signature verification (RFC 6376) for inbound mail (#373), on
 * `node:crypto` and our TXT lookup (`utils/dns-txt.ts`, which keeps a
 * multi-string key record whole where Bun's `resolveTxt` splits it): rsa-sha256 with keys of 1024 bits or
 * more and ed25519-sha256 (RFC 8463). rsa-sha1 is not accepted (RFC 8301).
 * Used for the DKIM verdict on feedback-loop reports, which is logged only.
 *
 * Strict on the signature: a tag-list that breaks RFC 6376 section 3.2, a
 * missing required tag, `h=` without From or `i=` outside `d=` is not
 * verified at all. One result per DKIM-Signature header field, in header
 * order; a message without one gets an empty list. ARC header fields are
 * not DKIM signatures and are not looked at.
 *
 * Results follow RFC 8601 section 2.7.1:
 * - `pass` / `fail`: the signature verified, or did not (body hash or
 *   header signature);
 * - `neutral`: the signature has syntax errors or cannot be processed
 *   (unknown algorithm or canonicalization), or it expired (`x=`);
 * - `policy`: rsa-sha1, or an RSA key shorter than 1024 bits;
 * - `permerror`: no key record (NXDOMAIN or no data), a revoked key (empty
 *   `p=`), a key record with syntax errors, or a key that does not fit the
 *   signature (`k=`, `h=`, `s=`, `t=s`);
 * - `temperror`: any other DNS failure.
 *
 * Messages are read as latin1, one character per byte, so every offset is
 * a byte offset and the bytes hashed are the bytes received. Bare LF line
 * ends are read as CRLF. Every regex here is linear in its input.
 */

import { createHash } from "crypto";
import { resolveTxtRecords } from "../../../utils/dns-txt.ts";
import { logger } from "../../../utils/logger.ts";
import type {
  Canonicalization,
  DkimKey,
  DkimSignatureResult,
  DkimVerifyDeps,
  Failure,
  HeaderField,
  ParsedSignature,
} from "../types/dkim.types.ts";
import {
  fieldValue,
  parseSignature,
  parseTagList,
  splitMessage,
} from "./dkim-verifier-parse.service.ts";
import { canonicalBody, signedHeaderData } from "./dkim-verifier-canonical.service.ts";
import { lookupKey, signatureVerifies } from "./dkim-verifier-key.service.ts";

export type { DkimSignatureResult, DkimVerifyDeps } from "../types/dkim.types.ts";
/** @public Kept from before the split (#387), when only this file used it. */
export type { DkimResult } from "../types/dkim.types.ts";

/*
 * The verifier is split by concern (#387): the types in
 * `types/dkim.types.ts`, reading the message and the signature in
 * `dkim-verifier-parse.service.ts`, canonicalization in
 * `dkim-verifier-canonical.service.ts`, the key record and the signature
 * check in `dkim-verifier-key.service.ts`.
 */

/** Narrows a parse or lookup outcome to its failure. */
function isFailure(value: ParsedSignature | DkimKey | Failure): value is Failure {
  return "result" in value;
}

/**
 * Verifies every DKIM-Signature of a message. Resolves one result per
 * signature, in header order, and never rejects: a DNS failure is a
 * `temperror` result. Callers bound the number of signatures and the size
 * of the header section, and the time the lookups may take.
 *
 * @param message - The raw message as received
 * @param deps    - The TXT lookup (`resolveTxt`) and clock; injectable for tests
 * @returns One result per DKIM-Signature header field (empty when there is none)
 */
export async function verifyDkimSignatures(
  message: Uint8Array,
  deps: DkimVerifyDeps = {},
): Promise<DkimSignatureResult[]> {
  const resolve = deps.resolveTxt ?? resolveTxtRecords;
  const now = deps.now ?? Date.now;
  const { fields, body } = splitMessage(message);

  /** Per message: canonical bodies by canonicalization, body hashes by canonicalization and l=, key lookups by name. */
  const canonicalBodies = new Map<Canonicalization, string>();
  const bodyHashes = new Map<string, string>();
  const keys = new Map<string, Promise<DkimKey | Failure>>();

  const verifyOne = async (
    field: HeaderField,
  ): Promise<Omit<DkimSignatureResult, "signingDomain" | "selector">> => {
    const signature = parseSignature(field.raw);
    if (isFailure(signature)) return { ...signature, testing: false };

    if (signature.expiration !== null && signature.expiration * 1000 < now()) {
      return { result: "neutral", reason: "signature expired", testing: false };
    }

    const hashKey = `${signature.bodyCanon}:${signature.bodyLength ?? ""}`;
    let bodyHash = bodyHashes.get(hashKey);
    if (bodyHash === undefined) {
      let canonical = canonicalBodies.get(signature.bodyCanon);
      if (canonical === undefined) {
        canonical = canonicalBody(body, signature.bodyCanon);
        canonicalBodies.set(signature.bodyCanon, canonical);
      }
      const covered =
        signature.bodyLength === null
          ? canonical
          : canonical.slice(0, signature.bodyLength);
      bodyHash = createHash("sha256").update(covered, "latin1").digest("base64");
      bodyHashes.set(hashKey, bodyHash);
    }
    if (bodyHash !== signature.bodyHash) {
      return { result: "fail", reason: "body hash did not verify", testing: false };
    }

    const name = `${signature.selector}._domainkey.${signature.domain}`;
    let lookup = keys.get(name);
    if (lookup === undefined) {
      lookup = lookupKey(name, resolve);
      keys.set(name, lookup);
    }
    const key = await lookup;
    if (isFailure(key)) return { ...key, testing: false };
    const testing = key.flags.includes("y");

    const keyMismatch = (
      reason: string,
    ): Omit<DkimSignatureResult, "signingDomain" | "selector"> => ({
      result: "permerror",
      reason,
      testing,
    });
    if (!signature.algorithm.startsWith(`${key.type}-`)) {
      return keyMismatch("key type does not match the signature algorithm");
    }
    if (key.hashes !== null && !key.hashes.includes("sha256")) {
      return keyMismatch("key does not allow sha256");
    }
    if (
      key.flags.includes("s") &&
      signature.identityDomain !== null &&
      signature.identityDomain !== signature.domain
    ) {
      return keyMismatch("key t=s forbids an i= subdomain");
    }

    const data = signedHeaderData(fields, field, signature);
    return signatureVerifies(data, signature, key.key)
      ? { result: "pass", reason: null, testing }
      : { result: "fail", reason: "signature did not verify", testing };
  };

  const results: DkimSignatureResult[] = [];
  for (const field of fields) {
    if (field.name !== "dkim-signature") continue;
    const tags = parseTagList(fieldValue(field.raw));
    const outcome = await verifyOne(field);
    const result: DkimSignatureResult = {
      ...outcome,
      signingDomain: tags?.get("d") ?? null,
      selector: tags?.get("s") ?? null,
    };
    if (result.result !== "pass") {
      logger.debug("DKIM signature did not pass", {
        result: result.result,
        reason: result.reason,
        signingDomain: result.signingDomain,
        selector: result.selector,
      });
    }
    results.push(result);
  }
  return results;
}
