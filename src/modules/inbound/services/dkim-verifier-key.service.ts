import { createHash, createPublicKey, verify, type KeyObject } from "crypto";
import type { DkimKey, Failure, ParsedSignature } from "../types/dkim.types.ts";
import {
  BASE64,
  lowerAscii,
  parseTagList,
  splitList,
  stripFws,
} from "./dkim-verifier-parse.service.ts";

/**
 * The DKIM public key (#373): the key record lookup and its checks
 * (RFC 6376 sections 3.6.1 and 6.1.2, RFC 8301, RFC 8463), and the
 * header signature checked with the key.
 */

/** RSA keys shorter than this are refused (RFC 8301 section 3.2). */
const MIN_RSA_BITS = 1024;

/** SubjectPublicKeyInfo prefix of a raw 32-byte ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** The DNS error codes that mean the name or its TXT data does not exist. */
const NO_RECORD_CODES = new Set(["ENOTFOUND", "ENODATA"]);

/** The public key in a `p=` value, or null when it is not a key of that type. */
function importKey(type: "rsa" | "ed25519", data: Buffer): KeyObject | null {
  const candidates =
    type === "ed25519"
      ? data.length === 32
        ? [Buffer.concat([ED25519_SPKI_PREFIX, data])]
        : []
      : [data];
  for (const der of candidates) {
    for (const format of type === "rsa"
      ? (["spki", "pkcs1"] as const)
      : (["spki"] as const)) {
      try {
        const key = createPublicKey({ key: der, format: "der", type: format });
        if (key.asymmetricKeyType === type) return key;
      } catch {
        /** Not this encoding; try the next one. */
      }
    }
  }
  return null;
}

/**
 * Looks up and reads the key record at `<s>._domainkey.<d>` (RFC 6376
 * sections 3.6.1 and 6.1.2). The strings of a record are joined; with
 * several records the first is used.
 */
export async function lookupKey(
  name: string,
  resolve: (name: string) => Promise<string[][]>,
): Promise<DkimKey | Failure> {
  let records: string[][];
  try {
    records = await resolve(name);
  } catch (error: unknown) {
    const code: unknown =
      typeof error === "object" && error !== null
        ? Reflect.get(error, "code")
        : undefined;
    if (typeof code === "string" && NO_RECORD_CODES.has(code)) {
      return { result: "permerror", reason: "no key record" };
    }
    return {
      result: "temperror",
      reason: `DNS failure: ${typeof code === "string" ? code : "unknown"}`,
    };
  }
  const [first] = records;
  if (first === undefined) return { result: "permerror", reason: "no key record" };

  const keyError = (reason: string): Failure => ({ result: "permerror", reason });
  const tags = parseTagList(first.join(""));
  if (tags === null) return keyError("key record syntax error");
  const version = tags.get("v");
  if (
    version !== undefined &&
    (version !== "DKIM1" || tags.keys().next().value !== "v")
  ) {
    return keyError("unknown key version");
  }
  const encoded = tags.get("p");
  if (encoded === undefined) return keyError("key record syntax error");
  const publicKey = stripFws(encoded);
  if (publicKey === "") return keyError("key revoked");
  if (!BASE64.test(publicKey) || publicKey.length % 4 !== 0) {
    return keyError("key record syntax error");
  }

  const keyType = lowerAscii(tags.get("k") ?? "rsa");
  if (keyType !== "rsa" && keyType !== "ed25519") return keyError("unknown key type");
  const services = tags.get("s");
  if (services !== undefined) {
    const list = splitList(services);
    if (!list.includes("email") && !list.includes("*"))
      return keyError("key not for email");
  }

  const key = importKey(keyType, Buffer.from(publicKey, "base64"));
  if (key === null) return keyError("invalid public key");
  if (
    keyType === "rsa" &&
    (key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS
  ) {
    return { result: "policy", reason: `RSA key shorter than ${MIN_RSA_BITS} bits` };
  }

  const hashes = tags.get("h");
  return {
    type: keyType,
    key,
    hashes: hashes === undefined ? null : splitList(hashes),
    flags: splitList(tags.get("t") ?? ""),
  };
}

/** Checks the header signature with the key: rsa-sha256 signs the data, ed25519-sha256 its SHA-256. */
export function signatureVerifies(
  data: Buffer,
  signature: ParsedSignature,
  key: KeyObject,
): boolean {
  try {
    return signature.algorithm === "ed25519-sha256"
      ? verify(null, createHash("sha256").update(data).digest(), key, signature.signature)
      : verify("sha256", data, key, signature.signature);
  } catch {
    return false;
  }
}
