import { generateKeyPair } from "crypto";

/**
 * DKIM key material and selectors (#250): key generation, the TXT record
 * value, the selector rules, the dated selector of a key rotation and the
 * comparison of a published record with a key. No database and no DNS:
 * `domain.service.ts` (create), `dkim-rotation.service.ts` (rotation) and
 * `dns-verification.service.ts` (Verify) share these.
 */

/** The selector a domain gets when none is chosen on create. */
export const DEFAULT_DKIM_SELECTOR = "bunmail";

/**
 * A DKIM selector is one DNS label (RFC 6376 3.1, RFC 1035 2.3.1), kept
 * lowercase: 1 to 63 characters, letters, digits and inner hyphens.
 * Also the `pattern` of the create DTO.
 */
export const DKIM_SELECTOR_PATTERN = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$";

const DKIM_SELECTOR_REGEX = new RegExp(DKIM_SELECTOR_PATTERN);

/** Whether `value` is a valid DKIM selector (see {@link DKIM_SELECTOR_PATTERN}). */
export function isValidDkimSelector(value: string): boolean {
  return DKIM_SELECTOR_REGEX.test(value);
}

/**
 * What the operator should do with the previous selector after a
 * rotation: receivers still verify mail signed before the switch (queued,
 * delayed, forwarded) against it for a while.
 */
export const PREVIOUS_DKIM_SELECTOR_ADVICE =
  "Keep its DNS record published for at least 7 days after the switch, then remove it.";

/**
 * The selector of a new rotation: `bm<YYYYMMDD>` (UTC date of `now`), with
 * `-2`, `-3`, ... appended when that name is already one of `taken` (the
 * domain's current and previous selectors), so it never reuses a selector
 * whose TXT record is still in use.
 */
export function datedDkimSelector(now: Date, taken: readonly (string | null)[]): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  const base = `bm${day}`;
  const used = new Set(taken.filter((s): s is string => s !== null));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

/** Generates a 2048-bit RSA key pair for DKIM signing, PEM-encoded. */
export function generateDkimKeyPair(): Promise<{
  privateKey: string;
  publicKey: string;
}> {
  return new Promise((resolve, reject) => {
    generateKeyPair(
      "rsa",
      {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      },
      (err, publicKey, privateKey) => {
        if (err) return reject(err);
        resolve({ privateKey, publicKey });
      },
    );
  });
}

/**
 * The raw base64 key material of a PEM public key: what goes after `p=`
 * in the TXT record.
 */
export function publicKeyBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s/g, "");
}

/** The TXT record value of a public key: `v=DKIM1; k=rsa; p=<base64>`. */
export function dkimRecordValue(publicKeyPem: string): string {
  return `v=DKIM1; k=rsa; p=${publicKeyBase64(publicKeyPem)}`;
}

/** The host of a selector's TXT record. */
export function dkimRecordHost(selector: string, domainName: string): string {
  return `${selector}._domainkey.${domainName}`;
}

/**
 * Whether the TXT records found at a selector's host publish `publicKeyPem`:
 * one record (its strings already joined), or all of them joined (some DNS
 * providers split a long value across records), carries `v=DKIM1` and
 * `p=<the key>`, whitespace ignored. Verify and completing a rotation use
 * this same comparison.
 */
export function dkimRecordsMatchKey(
  records: readonly string[],
  publicKeyPem: string,
): boolean {
  const expectedKey = publicKeyBase64(publicKeyPem);
  const candidates = [...records, records.join("")];
  return candidates.some((record) => {
    const cleaned = record.replace(/\s/g, "");
    return cleaned.includes("v=DKIM1") && cleaned.includes(`p=${expectedKey}`);
  });
}
