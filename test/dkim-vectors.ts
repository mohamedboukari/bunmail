/**
 * DKIM test vectors for the verifier (#373): signed messages, the DNS
 * answers their keys need, and the result the verifier should give.
 *
 * Relaxed/relaxed RSA messages are signed by nodemailer's own DKIM signer
 * (`nodemailer/lib/dkim`, the one BunMail's outgoing mail goes through;
 * the subpath, because a unit test's `mock.module("nodemailer")` leaks to
 * later files). Simple/simple, `l=`, `i=`, `x=` and ed25519-sha256 vectors
 * come from `signDkim` below, a plain RFC 6376 signer written apart from
 * the verifier. `test/fixtures/dkim-differential.json` holds one run of
 * these vectors with mailauth's verdicts, so the verifier is also checked
 * against an implementation it shares no code with.
 */

import { createHash, generateKeyPairSync, sign, type KeyObject } from "crypto";
import DKIM from "nodemailer/lib/dkim";

/** What a fake resolver answers for one name: TXT records, or a DNS error code. */
export type DnsAnswer = { txt: string[][] } | { error: string };

/** One expected per-signature result: the verdict and the `d=` it is about. */
export interface ExpectedResult {
  result: string;
  signingDomain: string | null;
}

/** A message, the DNS it needs, and what the verifier should say. */
export interface DkimCase {
  name: string;
  message: string;
  dns: Record<string, DnsAnswer>;
  expected: ExpectedResult[];
}

/** The signing domain of every vector. */
export const DOMAIN = "example.com";

/** A message with folded and padded headers and a body with trailing whitespace and empty lines. */
export const BASE_MESSAGE = [
  "From: Sender <sender@example.com>",
  "To: rcpt@example.org",
  "Subject: Monthly   report",
  "\tcontinued on a folded line ",
  "Date: Mon, 02 Nov 2026 10:00:00 +0000",
  "Message-ID: <vector@example.com>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello there,  ",
  "",
  "a line with   inner\t spaces\t ",
  "last line",
  "",
  "",
  "",
].join("\r\n");

/** Header fields the vectors sign. */
const SIGNED = [
  "From",
  "To",
  "Subject",
  "Date",
  "Message-ID",
  "MIME-Version",
  "Content-Type",
];

/** Options for `signDkim`. */
export interface SignOptions {
  privateKey: KeyObject;
  algorithm: "rsa-sha256" | "ed25519-sha256";
  canonicalization: string;
  selector: string;
  domain?: string;
  /** Field names for `h=`, in order; a repeated name over-signs. */
  headers?: string[];
  /** Sign only this many bytes of the canonical body (`l=`). */
  bodyLength?: number;
  identity?: string;
  timestamp?: number;
  expiration?: number;
}

/** Splits a CRLF message into header fields (folds kept) and body. */
function split(message: string): { fields: string[]; body: string } {
  const end = message.indexOf("\r\n\r\n");
  const fields: string[] = [];
  for (const line of message.slice(0, end).split("\r\n")) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && fields.length > 0) {
      fields[fields.length - 1] += `\r\n${line}`;
    } else {
      fields.push(line);
    }
  }
  return { fields, body: message.slice(end + 4) };
}

/** RFC 6376 section 3.4.2 for one field. */
function relaxedField(field: string): string {
  const colon = field.indexOf(":");
  const value = field
    .slice(colon + 1)
    .replaceAll("\r\n", "")
    .replace(/[ \t]+/g, " ")
    .trim();
  return `${field.slice(0, colon).trim().toLowerCase()}:${value}`;
}

/** RFC 6376 sections 3.4.3 and 3.4.4. */
function canonicalizeBody(body: string, canon: string): string {
  if (canon === "simple") {
    let out = body;
    while (out.endsWith("\r\n")) out = out.slice(0, -2);
    return `${out}\r\n`;
  }
  const lines = body.split("\r\n").map((line) => line.replace(/[ \t]+/g, " ").trimEnd());
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  return lines.length === 0 ? "" : `${lines.join("\r\n")}\r\n`;
}

/**
 * Signs `message` (CRLF line ends) and returns it with the DKIM-Signature
 * on top. The tags are folded over several lines.
 */
export function signDkim(message: string, options: SignOptions): string {
  const [headerCanon = "simple", bodyCanon = "simple"] =
    options.canonicalization.split("/");
  const { fields, body } = split(message);
  const canonicalBody = canonicalizeBody(body, bodyCanon);
  const covered =
    options.bodyLength === undefined
      ? canonicalBody
      : canonicalBody.slice(0, options.bodyLength);
  const bodyHash = createHash("sha256").update(covered, "latin1").digest("base64");
  const names = options.headers ?? SIGNED;

  const tags = [
    "v=1",
    `a=${options.algorithm}`,
    `c=${options.canonicalization}`,
    `d=${options.domain ?? DOMAIN}`,
    `s=${options.selector}`,
    ...(options.timestamp === undefined ? [] : [`t=${options.timestamp}`]),
    ...(options.expiration === undefined ? [] : [`x=${options.expiration}`]),
    ...(options.identity === undefined ? [] : [`i=${options.identity}`]),
    ...(options.bodyLength === undefined ? [] : [`l=${options.bodyLength}`]),
    `h=${names.join(":")}`,
    `bh=${bodyHash}`,
    "b=",
  ];
  const unsigned = `DKIM-Signature: ${tags.join(";\r\n\t")}`;

  const remaining = [...fields];
  const selected: string[] = [];
  for (const name of names) {
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      const field = remaining[i] ?? "";
      if (
        field.slice(0, field.indexOf(":")).trim().toLowerCase() === name.toLowerCase()
      ) {
        selected.push(field);
        remaining.splice(i, 1);
        break;
      }
    }
  }
  const canon =
    headerCanon === "relaxed" ? relaxedField : (field: string): string => field;
  const data = Buffer.from(
    selected.map((field) => `${canon(field)}\r\n`).join("") + canon(unsigned),
    "latin1",
  );
  const signature =
    options.algorithm === "ed25519-sha256"
      ? sign(null, createHash("sha256").update(data).digest(), options.privateKey)
      : sign("sha256", data, options.privateKey);
  const b = signature.toString("base64").replace(/.{60}(?=.)/g, "$&\r\n\t ");
  return `${unsigned}${b}\r\n${message}`;
}

/** Signs `message` with nodemailer's DKIM signer (relaxed/relaxed). */
export async function signWithNodemailer(
  message: string,
  options: { privateKey: KeyObject; selector: string; hashAlgo?: "sha256" | "sha1" },
): Promise<string> {
  const signer = new DKIM({
    domainName: DOMAIN,
    keySelector: options.selector,
    privateKey: options.privateKey.export({ type: "pkcs8", format: "pem" }),
    headerFieldNames: SIGNED.join(":"),
    hashAlgo: options.hashAlgo ?? "sha256",
  });
  const chunks: Buffer[] = [];
  for await (const chunk of signer.sign(message)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("latin1");
}

/** The `p=` value of a public key: SubjectPublicKeyInfo for RSA, the raw 32 bytes for ed25519. */
export function publicKeyValue(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return (publicKey.asymmetricKeyType === "ed25519" ? der.subarray(-32) : der).toString(
    "base64",
  );
}

/** The DNS name of a selector's key record. */
export function keyName(selector: string, domain = DOMAIN): string {
  return `${selector}._domainkey.${domain}`;
}

/** A key record answer, split into 200-character strings like a real TXT record. */
export function keyRecord(value: string): DnsAnswer {
  return { txt: [value.match(/.{1,200}/g) ?? [value]] };
}

/** Replaces the first occurrence of `search`, failing loudly when it is missing. */
function replaceOnce(text: string, search: string, replacement: string): string {
  if (!text.includes(search)) throw new Error(`vector text not found: ${search}`);
  return text.replace(search, replacement);
}

/** A passing verdict for the vectors' domain. */
const PASS: ExpectedResult = { result: "pass", signingDomain: DOMAIN };

/** A verdict other than pass for the vectors' domain. */
function verdict(result: string): ExpectedResult {
  return { result, signingDomain: DOMAIN };
}

/**
 * Builds every vector with fresh keys. Each case's DNS holds only the key
 * records it needs; any other name is NXDOMAIN.
 */
export async function buildDkimCases(): Promise<DkimCase[]> {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rsaShort = generateKeyPairSync("rsa", { modulusLength: 512 });
  const ed = generateKeyPairSync("ed25519");
  const rsaTxt = `v=DKIM1; k=rsa; p=${publicKeyValue(rsa.publicKey)}`;
  const rsaDns = { [keyName("rsa")]: keyRecord(rsaTxt) };

  const nodemailerSigned = await signWithNodemailer(BASE_MESSAGE, {
    privateKey: rsa.privateKey,
    selector: "rsa",
  });
  const rsaSigned = (options: Partial<SignOptions> = {}): string =>
    signDkim(BASE_MESSAGE, {
      privateKey: rsa.privateKey,
      algorithm: "rsa-sha256",
      canonicalization: "simple/simple",
      selector: "rsa",
      ...options,
    });
  const nodemailerCase = (
    name: string,
    message: string,
    expected: ExpectedResult[],
    dns: Record<string, DnsAnswer> = rsaDns,
  ): DkimCase => ({ name, message, dns, expected });

  const ARC_HEADERS = [
    "ARC-Seal: i=1; a=rsa-sha256; t=1780000000; cv=none; d=example.net; s=arc;",
    "\tb=AAAA",
    "ARC-Message-Signature: i=1; a=rsa-sha256; c=relaxed/relaxed; d=example.net;",
    "\ts=arc; h=from:to:subject; bh=AAAA; b=AAAA",
    "ARC-Authentication-Results: i=1; mx.example.net; dkim=pass header.d=example.com",
    "",
  ].join("\r\n");

  return [
    nodemailerCase("nodemailer relaxed/relaxed rsa-sha256", nodemailerSigned, [PASS]),
    {
      name: "simple/simple rsa-sha256",
      message: rsaSigned(),
      dns: rsaDns,
      expected: [PASS],
    },
    {
      name: "relaxed/simple rsa-sha256",
      message: rsaSigned({ canonicalization: "relaxed/simple" }),
      dns: rsaDns,
      expected: [PASS],
    },
    {
      name: "simple/relaxed rsa-sha256",
      message: rsaSigned({ canonicalization: "simple/relaxed" }),
      dns: rsaDns,
      expected: [PASS],
    },
    {
      name: "relaxed/relaxed ed25519-sha256",
      message: signDkim(BASE_MESSAGE, {
        privateKey: ed.privateKey,
        algorithm: "ed25519-sha256",
        canonicalization: "relaxed/relaxed",
        selector: "ed",
      }),
      dns: {
        [keyName("ed")]: keyRecord(
          `v=DKIM1; k=ed25519; p=${publicKeyValue(ed.publicKey)}`,
        ),
      },
      expected: [PASS],
    },
    {
      name: "l= covers the body, text appended after signing",
      message: `${rsaSigned({ canonicalization: "relaxed/relaxed", bodyLength: 45 })}appended after signing\r\n`,
      dns: rsaDns,
      expected: [PASS],
    },
    {
      name: "i= a subdomain of d=, t= and a future x=",
      message: rsaSigned({
        identity: "user@mail.example.com",
        timestamp: 1_780_000_000,
        expiration: 4_102_444_800,
      }),
      dns: rsaDns,
      expected: [PASS],
    },
    nodemailerCase("bare LF line ends", nodemailerSigned.replaceAll("\r\n", "\n"), [
      PASS,
    ]),
    nodemailerCase(
      "unsigned header fields added after signing",
      `Received: from mx.example.org by mx.example.net; Mon, 02 Nov 2026 10:00:01 +0000\r\nX-Extra: 1\r\n${nodemailerSigned}`,
      [PASS],
    ),
    nodemailerCase(
      "ARC header fields next to the DKIM-Signature",
      `${ARC_HEADERS}${nodemailerSigned}`,
      [PASS],
    ),
    nodemailerCase(
      "two signatures, one broken",
      `${replaceOnce(nodemailerSigned.slice(0, nodemailerSigned.indexOf("\r\nFrom:")), "s=rsa", "s=gone")}\r\n${nodemailerSigned}`,
      [verdict("permerror"), PASS],
    ),
    nodemailerCase("unsigned message", BASE_MESSAGE, []),
    nodemailerCase(
      "body changed after signing",
      replaceOnce(nodemailerSigned, "last line", "last line, edited"),
      [verdict("fail")],
    ),
    nodemailerCase(
      "signed header changed after signing",
      replaceOnce(nodemailerSigned, "Monthly   report", "Weekly report"),
      [verdict("fail")],
    ),
    {
      name: "over-signed Subject added after signing",
      message: `Subject: Injected\r\n${rsaSigned({ headers: [...SIGNED, "Subject"] })}`,
      dns: rsaDns,
      expected: [verdict("fail")],
    },
    {
      name: "over-signed Subject, nothing added",
      message: rsaSigned({ headers: [...SIGNED, "Subject"] }),
      dns: rsaDns,
      expected: [PASS],
    },
    nodemailerCase("revoked key (empty p=)", nodemailerSigned, [verdict("permerror")], {
      [keyName("rsa")]: keyRecord("v=DKIM1; k=rsa; p="),
    }),
    nodemailerCase("no key record", nodemailerSigned, [verdict("permerror")], {}),
    nodemailerCase(
      "DNS failure on the key lookup",
      nodemailerSigned,
      [verdict("temperror")],
      {
        [keyName("rsa")]: { error: "ESERVFAIL" },
      },
    ),
    nodemailerCase("key record syntax error", nodemailerSigned, [verdict("permerror")], {
      [keyName("rsa")]: keyRecord(
        `v=DKIM1; k=rsa; p=${publicKeyValue(rsa.publicKey)}; ;`,
      ),
    }),
    nodemailerCase(
      "key record for ed25519, rsa-sha256 signature",
      nodemailerSigned,
      [verdict("permerror")],
      {
        [keyName("rsa")]: keyRecord(
          `v=DKIM1; k=ed25519; p=${publicKeyValue(rsa.publicKey)}`,
        ),
      },
    ),
    nodemailerCase(
      "key record allows only sha1",
      nodemailerSigned,
      [verdict("permerror")],
      {
        [keyName("rsa")]: keyRecord(
          `v=DKIM1; k=rsa; h=sha1; p=${publicKeyValue(rsa.publicKey)}`,
        ),
      },
    ),
    nodemailerCase("key record t=y (testing)", nodemailerSigned, [PASS], {
      [keyName("rsa")]: keyRecord(
        `v=DKIM1; k=rsa; t=y; p=${publicKeyValue(rsa.publicKey)}`,
      ),
    }),
    {
      name: "key record t=s, i= a subdomain of d=",
      message: rsaSigned({ identity: "@mail.example.com" }),
      dns: {
        [keyName("rsa")]: keyRecord(
          `v=DKIM1; k=rsa; t=s; p=${publicKeyValue(rsa.publicKey)}`,
        ),
      },
      expected: [verdict("permerror")],
    },
    {
      name: "expired x=",
      message: rsaSigned({ timestamp: 1_600_000_000, expiration: 1_600_086_400 }),
      dns: rsaDns,
      expected: [verdict("neutral")],
    },
    {
      name: "h= without From",
      message: rsaSigned({ headers: ["To", "Subject", "Date"] }),
      dns: rsaDns,
      expected: [verdict("neutral")],
    },
    {
      name: "i= outside d=",
      message: rsaSigned({ identity: "user@example.net" }),
      dns: rsaDns,
      expected: [verdict("neutral")],
    },
    nodemailerCase(
      "rsa-sha1",
      await signWithNodemailer(BASE_MESSAGE, {
        privateKey: rsa.privateKey,
        selector: "rsa",
        hashAlgo: "sha1",
      }),
      [verdict("policy")],
    ),
    nodemailerCase(
      "512-bit RSA key",
      await signWithNodemailer(BASE_MESSAGE, {
        privateKey: rsaShort.privateKey,
        selector: "short",
      }),
      [verdict("policy")],
      {
        [keyName("short")]: keyRecord(
          `v=DKIM1; k=rsa; p=${publicKeyValue(rsaShort.publicKey)}`,
        ),
      },
    ),
    nodemailerCase(
      "b= not base64",
      replaceOnce(nodemailerSigned, " b=", " b=!!notbase64!!"),
      [verdict("neutral")],
    ),
    nodemailerCase(
      "unknown algorithm",
      replaceOnce(nodemailerSigned, "a=rsa-sha256", "a=rsa-sha512"),
      [verdict("neutral")],
    ),
    nodemailerCase("v= other than 1", replaceOnce(nodemailerSigned, "v=1;", "v=2;"), [
      verdict("neutral"),
    ]),
  ];
}
