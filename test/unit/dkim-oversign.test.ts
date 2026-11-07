import { describe, test, expect } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "crypto";
import DKIM from "nodemailer/lib/dkim";
import MailComposer from "nodemailer/lib/mail-composer";
import { DKIM_SIGNED_HEADERS } from "../../src/modules/emails/services/dkim-signer.service.ts";
import {
  buildTransactionMails,
  signMessage,
  type MessageParts,
} from "../../src/modules/emails/services/mailer-message.service.ts";
import { verifyDkimSignatures } from "../../src/modules/inbound/services/dkim-verifier.service.ts";
import { independentVerify } from "../dkim-independent.ts";

/**
 * Over-signing (#345): a header field added, removed or changed after
 * signing, or a changed body, makes the signature fail, both in the
 * built-in verifier and in the independent one (`test/dkim-independent.ts`).
 * The contrast: Nodemailer's signer, which BunMail used before, still
 * verified with a second `From:` added above the original.
 *
 * Nodemailer only through its `lib/*` subpaths: other unit files mock
 * `nodemailer` itself, and `mock.module` leaks across files.
 */

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" });
const RECORD = `v=DKIM1; k=rsa; p=${keys.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64")}`;

/** The built-in verifier's verdict on a message signed with the test key. */
async function ownVerdict(message: Buffer): Promise<string | undefined> {
  const [result] = await verifyDkimSignatures(message, {
    resolveTxt: async (name) =>
      name === "bunmail._domainkey.example.com" ? [[RECORD]] : [],
  });
  return result?.result;
}

/** Both verifiers' verdicts, `pass` or `fail`. */
async function verdicts(
  message: Buffer,
  publicKey: KeyObject = keys.publicKey,
): Promise<string[]> {
  const independent = independentVerify(message, publicKey)[0] ?? "none";
  return [
    (await ownVerdict(message)) ?? "none",
    independent.startsWith("fail") ? "fail" : independent,
  ];
}

/** A transactional message: no `List-Unsubscribe`, so adding one is a tampering case too. */
const MESSAGE: MessageParts = {
  from: "billing@example.com",
  fromName: "Billing",
  headerTo: "customer@example.org, other@example.org",
  headerCc: "accounts@example.org",
  replyTo: null,
  subject: "Your invoice",
  html: "<p>Pay to the usual account.</p>",
  text: "Pay to the usual account.",
  messageId: "<invoice@example.com>",
  headers: {},
  attachments: [
    {
      filename: "invoice.pdf",
      contentType: "application/pdf",
      contentId: null,
      content: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    },
  ],
  category: "transactional",
  /** A `Feedback-ID` is present, so a second one is a tampering case. */
  feedback: { source: "api", apiKeyId: "key-1" },
};

const ENVELOPE = [
  { recipients: ["customer@example.org"], envelopeFrom: "billing@example.com" },
];

/** The message as BunMail now sends it, signed by its own signer. */
async function bunmailSigned(): Promise<string> {
  const signed = await signMessage({
    ...MESSAGE,
    dkim: { domainName: "example.com", keySelector: "bunmail", privateKey: PEM },
  });
  if (signed.kind !== "signed") throw new Error("expected a signed message");
  return signed.raw.toString("latin1");
}

/** The same message signed the way BunMail did before: Nodemailer's signer, BunMail's header list. */
async function nodemailerSigned(): Promise<string> {
  const [transaction] = buildTransactionMails(MESSAGE, null, ENVELOPE);
  if (!transaction) throw new Error("expected one transaction");
  const composed = await new MailComposer(transaction.mail).compile().build();
  const signer = new DKIM({
    domainName: "example.com",
    keySelector: "bunmail",
    privateKey: PEM,
    headerFieldNames: DKIM_SIGNED_HEADERS.join(":"),
  });
  const chunks: Buffer[] = [];
  for await (const chunk of signer.sign(composed)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("latin1");
}

/** Inserts `line` (a header field) right before the first field named `before`. */
function insertBefore(message: string, before: string, line: string): Buffer {
  const at = message.search(new RegExp(`^${before}:`, "m"));
  if (at < 0) throw new Error(`no ${before} field`);
  return Buffer.from(`${message.slice(0, at)}${line}\r\n${message.slice(at)}`, "latin1");
}

/** The header fields of a message, folding included, without the DKIM-Signature. */
function fieldsOf(message: string): string[] {
  const header = message.slice(0, message.indexOf("\r\n\r\n") + 2);
  const fields: string[] = [];
  for (const line of header.split(/(?<=\r\n)/)) {
    const last = fields.length - 1;
    if ((line.startsWith(" ") || line.startsWith("\t")) && last >= 0)
      fields[last] += line;
    else if (line !== "") fields.push(line);
  }
  return fields.filter((field) => !/^dkim-signature:/i.test(field));
}

const ADDED: Array<[string, string, string]> = [
  ["a second From above the original", "From", "From: CEO <ceo@attacker.example>"],
  ["a second From below the original", "To", "From: CEO <ceo@attacker.example>"],
  ["a second Subject above the original", "From", "Subject: URGENT: new bank details"],
  [
    "a second Subject below the original",
    "Message-ID",
    "Subject: URGENT: new bank details",
  ],
  ["a Reply-To where there was none", "From", "Reply-To: thief@attacker.example"],
  ["a Sender where there was none", "From", "Sender: thief@attacker.example"],
  ["a second Cc", "From", "Cc: thief@attacker.example"],
  ["a second Date", "From", "Date: Thu, 01 Jan 2026 00:00:00 +0000"],
  ["a second Content-Type", "From", "Content-Type: text/plain"],
  [
    "a List-Unsubscribe where there was none",
    "From",
    "List-Unsubscribe: <https://attacker.example/u>",
  ],
  ["a second Feedback-ID", "From", "Feedback-ID: api:other:example.com:bunmail"],
  [
    "a Content-Disposition where there was none",
    "From",
    "Content-Disposition: attachment",
  ],
  ["an Auto-Submitted where there was none", "From", "Auto-Submitted: auto-generated"],
];

describe("over-signing: what an added field does (#345)", () => {
  test("the signed message verifies untouched", async () => {
    expect(await verdicts(Buffer.from(await bunmailSigned(), "latin1"))).toEqual([
      "pass",
      "pass",
    ]);
  });

  for (const [label, before, line] of ADDED) {
    test(`${label} breaks the signature`, async () => {
      const tampered = insertBefore(await bunmailSigned(), before, line);
      expect(await verdicts(tampered)).toEqual(["fail", "fail"]);
    });
  }
});

describe("over-signing: removed or changed fields and body (#345)", () => {
  test("removing or changing any signed field present breaks the signature", async () => {
    const message = await bunmailSigned();
    const signed = new Set(DKIM_SIGNED_HEADERS.map((name) => name.toLowerCase()));
    const present = fieldsOf(message).filter((field) =>
      signed.has(field.slice(0, field.indexOf(":")).toLowerCase()),
    );
    /** From, To, Cc, Subject, Message-ID, Date, MIME-Version, Content-Type at least. */
    expect(present.length).toBeGreaterThanOrEqual(8);
    for (const field of present) {
      const colon = field.indexOf(":");
      const changed = `${field.slice(0, colon + 1)} X${field.slice(colon + 1)}`;
      expect(
        await verdicts(Buffer.from(message.replace(field, changed), "latin1")),
      ).toEqual(["fail", "fail"]);
      expect(await verdicts(Buffer.from(message.replace(field, ""), "latin1"))).toEqual([
        "fail",
        "fail",
      ]);
    }
  });

  test("changing the body (its text, or a part's header) breaks the signature", async () => {
    const message = await bunmailSigned();
    for (const [search, replacement] of [
      ["the usual account", "the other account"],
      ["Content-Type: application/pdf", "Content-Type: text/x-pdf"],
    ] as const) {
      const changed = message.replace(search, replacement);
      expect(changed).not.toBe(message);
      expect(await verdicts(Buffer.from(changed, "latin1"))).toEqual(["fail", "fail"]);
    }
  });
});

describe("contrast: Nodemailer's signer, as BunMail used it before (#345)", () => {
  test("verified with a second From above the original (the hole over-signing closes)", async () => {
    const message = await nodemailerSigned();
    expect(await verdicts(Buffer.from(message, "latin1"))).toEqual(["pass", "pass"]);
    const tampered = insertBefore(message, "From", "From: CEO <ceo@attacker.example>");
    expect(await verdicts(tampered)).toEqual(["pass", "pass"]);
    /** An added Reply-To or second Subject went unnoticed too. */
    expect(
      await verdicts(insertBefore(message, "From", "Reply-To: thief@attacker.example")),
    ).toEqual(["pass", "pass"]);
    expect(await verdicts(insertBefore(message, "From", "Subject: URGENT"))).toEqual([
      "pass",
      "pass",
    ]);
  });
});
