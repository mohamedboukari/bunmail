/**
 * Feedback-loop report fixtures for the verified-complaint tests: an ARF
 * report (RFC 5965) about a given Message-ID, DKIM-signed with a test key
 * by BunMail's own signer, and a TXT lookup that knows only the test keys.
 * Shared by the unit test of the report's DKIM check and the integration
 * test of the shared suppression gate.
 */
import { createHash, generateKeyPairSync, sign } from "crypto";
import {
  dkimSignMessage,
  signedHeaderNames,
} from "../src/modules/emails/services/dkim-signer.service.ts";
import {
  canonicalBody,
  signedHeaderData,
} from "../src/modules/inbound/services/dkim-verifier-canonical.service.ts";
import { splitMessage } from "../src/modules/inbound/services/dkim-verifier-parse.service.ts";

/** One RSA key for every signed fixture; 2048 bits, as the verifier requires 1024+. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "der" },
});

/** The selector every fixture signs with. */
export const ARF_SELECTOR = "fbl";

/** The DKIM key record of the test key; `testing` adds `t=y` (RFC 6376 section 3.6.1). */
export function arfKeyRecord(testing = false): string {
  return `v=DKIM1; k=rsa;${testing ? " t=y;" : ""} p=${publicKey.toString("base64")}`;
}

/**
 * A TXT lookup shaped like `dns/promises.resolveTxt` that answers only for
 * `<ARF_SELECTOR>._domainkey.<domain>` of the given domains (with the test
 * key, `t=y` for the ones in `testing`), and has no record for any other name.
 */
export function arfResolveTxt(
  domains: readonly string[],
  testing: readonly string[] = [],
): (name: string) => Promise<string[][]> {
  return async (name) => {
    for (const domain of domains) {
      if (name === `${ARF_SELECTOR}._domainkey.${domain}`) {
        return [[arfKeyRecord(testing.includes(domain))]];
      }
    }
    return [];
  };
}

/** An abuse report about `originalMessageId`, naming `rcptTo` as the recipient. */
export function arfReport(opts: {
  originalMessageId: string;
  rcptTo: string;
  subject?: string;
}): string {
  return [
    `From: "Feedback Loop" <feedback@isp.example.net>`,
    "To: fbl@example.com",
    `Subject: ${opts.subject ?? "Abuse report"}`,
    "Date: Mon, 19 Oct 2026 10:05:00 +0000",
    `Message-ID: <${crypto.randomUUID()}@isp.example.net>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=feedback-report; boundary="arf_bnd"',
    "",
    "--arf_bnd",
    "Content-Type: text/plain",
    "",
    "This is an abuse report.",
    "",
    "--arf_bnd",
    "Content-Type: message/feedback-report",
    "",
    "Feedback-Type: abuse",
    "User-Agent: Example-Feedback/1.0",
    "Version: 1",
    `Original-Rcpt-To: ${opts.rcptTo}`,
    "Arrival-Date: Mon, 19 Oct 2026 10:00:00 +0000",
    "",
    "--arf_bnd",
    "Content-Type: text/rfc822-headers",
    "",
    "From: hello@example.com",
    `To: ${opts.rcptTo}`,
    "Subject: Your digest",
    `Message-ID: <${opts.originalMessageId}>`,
    "",
    "--arf_bnd--",
    "",
  ].join("\r\n");
}

/** `raw` with a DKIM-Signature of `domain` (selector {@link ARF_SELECTOR}) on top. */
export function signArf(raw: string | Buffer, domain: string): Buffer {
  return dkimSignMessage(typeof raw === "string" ? Buffer.from(raw, "latin1") : raw, {
    domainName: domain,
    keySelector: ARF_SELECTOR,
    privateKey,
  });
}

/**
 * Like {@link signArf}, but with the coverage under the test's control, to
 * build signatures that verify yet cover too little: `bodyLength` adds an
 * `l=` tag over that many octets of the canonical body (`"all"`: its whole
 * length), and `headers` replaces the `h=` list BunMail's signer would
 * choose. rsa-sha256, relaxed/relaxed, unfolded.
 */
export function signArfWith(
  raw: string,
  domain: string,
  opts: { bodyLength?: number | "all"; headers?: string[] },
): Buffer {
  const text = raw.replace(/\r?\n/g, "\r\n");
  const { fields, body } = splitMessage(Buffer.from(text, "latin1"));
  const canonical = canonicalBody(body, "relaxed");
  const length = opts.bodyLength === "all" ? canonical.length : opts.bodyLength;
  const covered = length === undefined ? canonical : canonical.slice(0, length);
  const bodyHash = createHash("sha256").update(covered, "latin1").digest("base64");
  const names = opts.headers ?? signedHeaderNames(fields);
  const tags = [
    "v=1",
    "a=rsa-sha256",
    "c=relaxed/relaxed",
    `d=${domain}`,
    `s=${ARF_SELECTOR}`,
    ...(length === undefined ? [] : [`l=${length}`]),
    `bh=${bodyHash}`,
    `h=${names.join(":")}`,
  ];
  const unsigned = `DKIM-Signature: ${tags.join("; ")}; b=`;
  const data = signedHeaderData(
    fields,
    { name: "dkim-signature", raw: unsigned },
    { headerCanon: "relaxed", signedHeaders: names.map((name) => name.toLowerCase()) },
  );
  const signature = sign("sha256", data, privateKey).toString("base64");
  return Buffer.from(`${unsigned}${signature}\r\n${text}`, "latin1");
}
