import { describe, test, expect, beforeAll, afterAll, spyOn } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "crypto";
import Mailer from "nodemailer/lib/mailer";
import type Mail from "nodemailer/lib/mailer";
import MailComposer from "nodemailer/lib/mail-composer";
import SMTPPool from "nodemailer/lib/smtp-pool";
import { SMTPServer } from "smtp-server";
import {
  DKIM_OVERSIGNED_HEADERS,
  DKIM_SIGNED_HEADERS,
  DkimSignError,
  dkimSignMessage,
  signedHeaderNames,
} from "../../src/modules/emails/services/dkim-signer.service.ts";
import {
  DkimSigningFailedError,
  buildTransactionMails,
  signMessage,
  type DkimOptions,
  type MessageParts,
} from "../../src/modules/emails/services/mailer-message.service.ts";
import { verifyDkimSignatures } from "../../src/modules/inbound/services/dkim-verifier.service.ts";
import { logger } from "../../src/utils/logger.ts";
import { independentVerify } from "../dkim-independent.ts";

/**
 * BunMail's own DKIM signer (#345): `h=` with over-signed fields, the tag
 * set, both algorithms, and the mailer composing and signing each message.
 * Every signed message is checked twice: by the built-in verifier and by
 * `test/dkim-independent.ts`, which shares no code with either. The
 * tampering cases are in `dkim-oversign.test.ts`.
 *
 * Nodemailer is reached through its `lib/*` subpaths only (in the mailer
 * code under test, `lib/mail-composer`): other unit files mock `nodemailer`
 * itself, and `mock.module` leaks across files.
 */

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ed25519 = generateKeyPairSync("ed25519");

/** DKIM options for a key pair, on `example.com` under the `bunmail` selector. */
function dkimFor(privateKey: KeyObject, domainName = "example.com"): DkimOptions {
  return {
    domainName,
    keySelector: "bunmail",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

/** The `p=` value of a public key: SPKI for RSA, the raw 32 bytes for ed25519. */
function pValue(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  return (publicKey.asymmetricKeyType === "ed25519" ? der.subarray(-32) : der).toString(
    "base64",
  );
}

/** The built-in verifier's results, over a lookup that knows only `publicKey`. */
async function ownVerify(message: Buffer, publicKey: KeyObject): Promise<string[]> {
  const type = publicKey.asymmetricKeyType === "ed25519" ? "ed25519" : "rsa";
  const record = `v=DKIM1; k=${type}; p=${pValue(publicKey)}`;
  const results = await verifyDkimSignatures(message, {
    resolveTxt: async (name) =>
      name === "bunmail._domainkey.example.com" ? [[record]] : [],
  });
  return results.map((r) => r.result);
}

/** The DKIM-Signature field of a signed message, folding included. */
function signatureField(message: Buffer): string {
  const match = /^DKIM-Signature:[\s\S]*?\r\n(?![ \t])/.exec(message.toString("latin1"));
  if (!match) throw new Error("no DKIM-Signature on top");
  return match[0];
}

/** The tags of the DKIM-Signature, FWS removed from the values, in order. */
function tagsOf(message: Buffer): Array<[string, string]> {
  const field = signatureField(message);
  return field
    .slice(field.indexOf(":") + 1)
    .split(";")
    .map((part): [string, string] => {
      const eq = part.indexOf("=");
      return [part.slice(0, eq).trim(), part.slice(eq + 1).replace(/\s+/g, "")];
    });
}

/** The `h=` list of a signed message. */
function hOf(message: Buffer): string[] {
  return (tagsOf(message).find(([name]) => name === "h")?.[1] ?? "").split(":");
}

/** A hand-written message: padded and folded headers, two To fields, trailing body whitespace. */
const MESSAGE = [
  "From: Sender <sender@example.com>",
  "To: first@example.org",
  "Subject: Monthly   report",
  "\tcontinued on a folded line ",
  "Date: Mon, 02 Nov 2026 10:00:00 +0000",
  "Message-ID: <signer@example.com>",
  "To: second@example.org",
  "X-Custom: not signed",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hello there,  ",
  "",
  "a line with   inner\t spaces\t ",
  "",
  "",
].join("\r\n");

describe("signedHeaderNames (#345)", () => {
  test("each present field once per instance, plus one for an over-signed name, absent ones only when over-signed", () => {
    const fields = [
      "from",
      "to",
      "to",
      "subject",
      "x-custom",
      "list-id",
      "feedback-id",
    ].map((name) => ({ name, raw: `${name}: v` }));
    expect(signedHeaderNames(fields)).toEqual([
      "from",
      "from",
      "sender",
      "reply-to",
      "subject",
      "subject",
      "date",
      "message-id",
      "to",
      "to",
      "to",
      "cc",
      "mime-version",
      "content-type",
      "content-transfer-encoding",
      "in-reply-to",
      "references",
      "list-id",
      "list-unsubscribe",
      "list-unsubscribe-post",
      "feedback-id",
      "feedback-id",
      "content-disposition",
      "auto-submitted",
    ]);
  });

  test("over-signs at least the headers a reader sees or that decide how the message is read", () => {
    for (const name of [
      "from",
      "to",
      "cc",
      "subject",
      "date",
      "message-id",
      "reply-to",
      "sender",
      "mime-version",
      "content-type",
      "list-unsubscribe",
      "list-unsubscribe-post",
      "feedback-id",
      "content-disposition",
      "auto-submitted",
    ]) {
      expect(DKIM_OVERSIGNED_HEADERS.has(name)).toBe(true);
    }
    /** Every over-signed name is a signed one. */
    const signed = new Set(DKIM_SIGNED_HEADERS.map((name) => name.toLowerCase()));
    for (const name of DKIM_OVERSIGNED_HEADERS) expect(signed.has(name)).toBe(true);
    /** List-Unsubscribe-Post stays signed (RFC 8058, #241). */
    expect(signed.has("list-unsubscribe-post")).toBe(true);
  });
});

describe("dkimSignMessage (#345)", () => {
  test("tags: v, a, c, d, q, s, bh, h, b in nodemailer's former order, no t/x/i/l", () => {
    const signed = dkimSignMessage(
      Buffer.from(MESSAGE, "latin1"),
      dkimFor(rsa.privateKey),
    );
    const tags = tagsOf(signed);
    expect(tags.map(([name]) => name)).toEqual([
      "v",
      "a",
      "c",
      "d",
      "q",
      "s",
      "bh",
      "h",
      "b",
    ]);
    expect(Object.fromEntries(tags)).toMatchObject({
      v: "1",
      a: "rsa-sha256",
      c: "relaxed/relaxed",
      d: "example.com",
      q: "dns/txt",
      s: "bunmail",
    });
  });

  test("h= signs each instance bottom up and over-signs: from:from, to:to:to (two To fields)", () => {
    const h = hOf(
      dkimSignMessage(Buffer.from(MESSAGE, "latin1"), dkimFor(rsa.privateKey)),
    );
    expect(h.filter((name) => name === "from")).toHaveLength(2);
    expect(h.filter((name) => name === "to")).toHaveLength(3);
    expect(h).toContain("reply-to");
    expect(h).not.toContain("x-custom");
    expect(h).not.toContain("list-id");
  });

  test("the two To fields are signed in their order: swapping them breaks the signature", async () => {
    const signed = dkimSignMessage(
      Buffer.from(MESSAGE, "latin1"),
      dkimFor(rsa.privateKey),
    );
    const swapped = Buffer.from(
      signed
        .toString("latin1")
        .replace("To: first@example.org", "To: PLACEHOLDER")
        .replace("To: second@example.org", "To: first@example.org")
        .replace("To: PLACEHOLDER", "To: second@example.org"),
      "latin1",
    );
    expect(await ownVerify(signed, rsa.publicKey)).toEqual(["pass"]);
    expect(await ownVerify(swapped, rsa.publicKey)).toEqual(["fail"]);
    expect(independentVerify(swapped, rsa.publicKey)).toEqual(["fail: signature"]);
  });

  for (const [label, pair, algorithm] of [
    ["RSA", rsa, "rsa-sha256"],
    ["Ed25519", ed25519, "ed25519-sha256"],
  ] as const) {
    test(`${label}: a=${algorithm}, verified by the built-in and the independent verifier`, async () => {
      const signed = dkimSignMessage(
        Buffer.from(MESSAGE, "latin1"),
        dkimFor(pair.privateKey),
      );
      expect(Object.fromEntries(tagsOf(signed)).a).toBe(algorithm);
      expect(await ownVerify(signed, pair.publicKey)).toEqual(["pass"]);
      expect(independentVerify(signed, pair.publicKey)).toEqual(["pass"]);
    });
  }

  test("relaxed canonicalization: refolding a header and adding empty lines at the end still verifies", async () => {
    const signed = dkimSignMessage(
      Buffer.from(MESSAGE, "latin1"),
      dkimFor(rsa.privateKey),
    );
    const refolded = Buffer.from(
      `${signed
        .toString("latin1")
        .replace("Subject: Monthly   report", "Subject:   Monthly\r\n report")}\r\n\r\n`,
      "latin1",
    );
    expect(await ownVerify(refolded, rsa.publicKey)).toEqual(["pass"]);
    expect(independentVerify(refolded, rsa.publicKey)).toEqual(["pass"]);
  });

  test("bare LF and bare CR become CRLF and the message ends with CRLF: the signed bytes are the sent bytes", async () => {
    const lf = "From: a@example.com\nTo: b@example.org\rSubject: s\n\nline one\nline two";
    const signed = dkimSignMessage(Buffer.from(lf, "latin1"), dkimFor(rsa.privateKey));
    const text = signed.toString("latin1");
    expect(text).not.toMatch(/\r(?!\n)|(?<!\r)\n/);
    expect(text).toEndWith("line two\r\n");
    expect(independentVerify(signed, rsa.publicKey)).toEqual(["pass"]);
    expect(await ownVerify(signed, rsa.publicKey)).toEqual(["pass"]);
  });

  test("the field is folded under 77 characters per line", () => {
    const signed = dkimSignMessage(
      Buffer.from(MESSAGE, "latin1"),
      dkimFor(rsa.privateKey),
    );
    const lines = signatureField(signed).replace(/\r\n$/, "").split("\r\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(76);
  });

  test("h= breaks its lines after a colon, never before one", () => {
    const signed = dkimSignMessage(
      Buffer.from(MESSAGE, "latin1"),
      dkimFor(rsa.privateKey),
    );
    const lines = signatureField(signed).replace(/\r\n$/, "").split("\r\n");
    const start = lines.findIndex((line) => line.startsWith(" h="));
    const end = lines.findIndex((line, i) => i > start && line.includes(";"));
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    for (const line of lines.slice(start, end)) expect(line).toEndWith(":");
    for (const line of lines.slice(start + 1, end + 1))
      expect(line).not.toStartWith(" :");
  });

  test("a stored domain with a final dot signs as the domain without it (d=) and verifies", async () => {
    const signed = dkimSignMessage(
      Buffer.from(MESSAGE, "latin1"),
      dkimFor(rsa.privateKey, "Example.COM."),
    );
    expect(Object.fromEntries(tagsOf(signed)).d).toBe("example.com");
    expect(await ownVerify(signed, rsa.publicKey)).toEqual(["pass"]);
    expect(independentVerify(signed, rsa.publicKey)).toEqual(["pass"]);
  });

  test("d= is the A-label of an internationalized domain", () => {
    const signed = dkimSignMessage(
      Buffer.from(MESSAGE, "latin1"),
      dkimFor(rsa.privateKey, "bücher.example"),
    );
    expect(Object.fromEntries(tagsOf(signed)).d).toBe("xn--bcher-kva.example");
  });

  test("refuses an invalid domain or selector, or a key type other than RSA or ed25519", () => {
    const message = Buffer.from(MESSAGE, "latin1");
    expect(() =>
      dkimSignMessage(message, { ...dkimFor(rsa.privateKey), domainName: "a;b=c" }),
    ).toThrow(DkimSignError);
    expect(() =>
      dkimSignMessage(message, { ...dkimFor(rsa.privateKey), keySelector: "bad;sel" }),
    ).toThrow(DkimSignError);
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(() => dkimSignMessage(message, dkimFor(ec.privateKey))).toThrow(DkimSignError);
  });
});

/** A message as the mailer builds it: attachments, non-ASCII, long headers, several To and Cc. */
function fullMessage(dkim: DkimOptions | undefined): MessageParts {
  return {
    from: "hello@example.com",
    fromName: "Zoë Ünïcode",
    headerTo: "first@example.org, second@example.org, Third <third@example.net>",
    headerCc: "cc1@example.org, cc2@example.net",
    replyTo: "replies@example.com",
    subject: `Grüße € ${"a long subject that folds ".repeat(5)}`,
    html: "<p>Héllo wörld, ünïcode body</p>",
    text: "Héllo wörld  \n\nünïcode body\t \n",
    messageId: "<full@example.com>",
    headers: { "X-Long": "value ".repeat(40).trim(), "X-Correlation-Id": "abc" },
    attachments: [
      {
        filename: "naïve report.pdf",
        contentType: "application/pdf",
        contentId: null,
        content: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x0a, 0x2e]),
      },
      {
        filename: "logo.png",
        contentType: "image/png",
        contentId: "logo@example.com",
        content: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
    ],
    unsubscribe: { url: "https://example.com/u/token" },
    feedback: { source: "api", apiKeyId: "key-1" },
    ...(dkim === undefined ? {} : { dkim }),
  };
}

/** The raw message of a transaction's options. */
function rawOf(mail: { raw?: unknown }): Buffer {
  if (!Buffer.isBuffer(mail.raw)) throw new Error("expected a raw signed message");
  return mail.raw;
}

const envelopes = [
  { key: "a", recipients: ["first@example.org"], envelopeFrom: "b+1@example.com" },
  { key: "b", recipients: ["cc1@example.org"], envelopeFrom: "b+2@example.com" },
];

/** What the mailer does per call and per session: sign once, then one `mail` per transaction. */
async function mailsFor<T extends { recipients: string[]; envelopeFrom: string }>(
  message: MessageParts,
  transactions: readonly T[],
): Promise<Array<T & { mail: Mail.Options }>> {
  const signed = await signMessage(message);
  if (signed.kind === "uncomposable") throw new Error("expected a composable message");
  return buildTransactionMails(
    message,
    signed.kind === "signed" ? signed.raw : null,
    transactions,
  );
}

describe("signMessage and buildTransactionMails (#345)", () => {
  for (const [label, pair] of [
    ["RSA", rsa],
    ["Ed25519", ed25519],
  ] as const) {
    test(`${label}: one signed message for every transaction, each with its own envelope, verified twice`, async () => {
      const mails = await mailsFor(fullMessage(dkimFor(pair.privateKey)), envelopes);
      expect(mails.map((m) => m.key)).toEqual(["a", "b"]);
      expect(mails.map((m) => m.mail.envelope)).toEqual([
        { from: "b+1@example.com", to: ["first@example.org"] },
        { from: "b+2@example.com", to: ["cc1@example.org"] },
      ]);
      const [first, second] = mails.map((m) => rawOf(m.mail));
      expect(first?.equals(second ?? Buffer.alloc(0))).toBe(true);
      const raw = first ?? Buffer.alloc(0);
      const header = raw.toString("latin1").split("\r\n\r\n")[0] ?? "";
      expect(header).toStartWith("DKIM-Signature:");
      expect(header).toContain(
        "\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n",
      );
      expect(header).toContain("\r\nFeedback-ID: ");
      /** Nodemailer writes the custom header with its own capitalization, as before. */
      expect(header).toContain("\r\nX-Correlation-ID: abc\r\n");
      expect(header).toMatch(/\r\nCc: cc1@example\.org, cc2@example\.net\r\n/);
      expect(raw.toString("latin1")).toContain("filename*0*=utf-8''na%C3%AFve");
      expect(hOf(raw)).toContain("list-unsubscribe-post");
      expect(await ownVerify(raw, pair.publicKey)).toEqual(["pass"]);
      expect(independentVerify(raw, pair.publicKey)).toEqual(["pass"]);
    });
  }

  test("without DKIM: Nodemailer's own options per transaction, as before", async () => {
    expect(await signMessage(fullMessage(undefined))).toEqual({ kind: "unsigned" });
    const mails = await mailsFor(fullMessage(undefined), envelopes);
    for (const [index, { mail }] of mails.entries()) {
      expect(mail.raw).toBeUndefined();
      expect(mail.dkim).toBeUndefined();
      expect(mail.subject).toStartWith("Grüße");
      expect(mail.envelope).toEqual({
        from: envelopes[index]?.envelopeFrom,
        to: envelopes[index]?.recipients,
      });
    }
  });

  for (const [label, dkim] of [
    ["a key that does not parse", { privateKey: "PEM" }],
    [
      "an EC key",
      {
        privateKey: dkimFor(generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey)
          .privateKey,
      },
    ],
    ["an invalid domain", { domainName: "a;b=c" }],
    ["an invalid selector", { keySelector: "bad;sel" }],
  ] as const) {
    test(`${label}: signMessage throws DkimSigningFailedError and logs without the key`, async () => {
      const options = { ...dkimFor(rsa.privateKey), ...dkim };
      const errorSpy = spyOn(logger, "error");
      try {
        let thrown: unknown;
        try {
          await signMessage(fullMessage(options));
        } catch (err) {
          thrown = err;
        }
        expect(thrown).toBeInstanceOf(DkimSigningFailedError);
        expect(thrown instanceof DkimSigningFailedError && thrown.domain).toBe(
          options.domainName,
        );
        const call = errorSpy.mock.calls.find(([message]) =>
          message.startsWith("DKIM signing failed"),
        );
        expect(call).toBeDefined();
        expect(JSON.stringify(call)).not.toContain("PRIVATE KEY");
        /** The PEM's first base64 line, or the whole value when it is not a PEM. */
        const keyPart = options.privateKey.split("\n")[1] ?? options.privateKey;
        expect(JSON.stringify(call)).not.toContain(keyPart);
      } finally {
        errorSpy.mockRestore();
      }
    });
  }

  test("buildTransactionMails never gives unsigned options for a message that has a key", () => {
    expect(() =>
      buildTransactionMails(fullMessage(dkimFor(rsa.privateKey)), null, envelopes),
    ).toThrow(DkimSigningFailedError);
  });

  test("a message that cannot be composed is `uncomposable`: its own log, no DKIM error, no throw", async () => {
    const compile = spyOn(MailComposer.prototype, "compile").mockImplementation(() => {
      throw new Error("compose boom");
    });
    const errorSpy = spyOn(logger, "error");
    errorSpy.mockClear();
    try {
      const result = await signMessage(fullMessage(dkimFor(rsa.privateKey)));
      expect(result.kind).toBe("uncomposable");
      const messages = errorSpy.mock.calls.map(([message]) => message);
      expect(messages).toContain("Message could not be composed");
      expect(messages.some((m) => m.startsWith("DKIM signing failed"))).toBe(false);
    } finally {
      compile.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

/** Messages the in-process receiver got: envelope and the DATA bytes, dot-unstuffed. */
const received: Array<{ mailFrom: string; rcptTo: string[]; data: Buffer }> = [];

/** A plaintext SMTP receiver (Bun cannot serve STARTTLS, see `test/smtp-fixture.ts`). */
const receiver = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS", "AUTH"],
  logger: false,
  onData(stream, session, callback) {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const from = session.envelope.mailFrom;
      received.push({
        mailFrom: from === false ? "" : from.address,
        rcptTo: session.envelope.rcptTo.map((r) => r.address),
        data: Buffer.concat(chunks),
      });
      callback();
    });
  },
});
let receiverPort = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", () => resolve()));
  const address = receiver.server.address();
  receiverPort = typeof address === "object" && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
});

describe("the signed message on the wire (#345)", () => {
  test("Nodemailer's SMTP pool sends the `raw` bytes unchanged, one envelope per transaction", async () => {
    received.length = 0;
    const mails = await mailsFor(fullMessage(dkimFor(rsa.privateKey)), envelopes);
    /** The pool the mailer's MX sessions use (`mx-transport.ts`), reached by its subpath. */
    const transport = new Mailer(
      new SMTPPool({
        host: "127.0.0.1",
        port: receiverPort,
        ignoreTLS: true,
        maxConnections: 1,
        maxRequeues: 0,
      }),
    );
    try {
      for (const { mail } of mails) await transport.sendMail(mail);
    } finally {
      transport.close();
    }
    expect(received.map(({ mailFrom, rcptTo }) => ({ mailFrom, rcptTo }))).toEqual([
      { mailFrom: "b+1@example.com", rcptTo: ["first@example.org"] },
      { mailFrom: "b+2@example.com", rcptTo: ["cc1@example.org"] },
    ]);
    const sent = rawOf(mails[0]?.mail ?? {});
    for (const { data } of received) {
      expect(data.equals(sent)).toBe(true);
      expect(await ownVerify(data, rsa.publicKey)).toEqual(["pass"]);
      expect(independentVerify(data, rsa.publicKey)).toEqual(["pass"]);
    }
  });
});
