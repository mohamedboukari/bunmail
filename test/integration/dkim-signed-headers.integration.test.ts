/**
 * BunMail's DKIM signature on a real SMTP session (#241, #345): the
 * message the mailer composes and signs (`signMessage`, then
 * `buildTransactionMails`) goes
 * through the real MX session (`runMxSession`, real nodemailer, no mocks in
 * this tier) to an in-process receiver, which must get the exact signed
 * bytes. The signature verifies, covers `List-Unsubscribe` and
 * `List-Unsubscribe-Post` (RFC 8058 one-click unsubscribe, which Gmail and
 * Yahoo rely on, only counts when both are signed), and over-signs `From`,
 * so a second `From:` added in transit breaks it.
 *
 * No database: the receiver is plaintext on 127.0.0.1 (Bun cannot serve
 * STARTTLS), and the key lookup is a fixed TXT answer.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { SMTPServer } from "smtp-server";
import {
  buildTransactionMails,
  signMessage,
} from "../../src/modules/emails/services/mailer.service.ts";
import { runMxSession } from "../../src/modules/emails/services/mx-transport.ts";
import { verifyDkimSignatures } from "../../src/modules/inbound/services/dkim-verifier.service.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "der" },
});
const RECORD = `v=DKIM1; k=rsa; p=${publicKey.toString("base64")}`;

/** The DATA of every message the receiver accepted, dot-unstuffed. */
const received: Buffer[] = [];

const receiver = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS", "AUTH"],
  logger: false,
  onData(stream, _session, callback) {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      received.push(Buffer.concat(chunks));
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

/** The built-in verifier's verdict, over a lookup that knows only the test key. */
async function verdict(message: Buffer): Promise<string | undefined> {
  const [result] = await verifyDkimSignatures(message, {
    resolveTxt: async (name) =>
      name === "bunmail._domainkey.example.com" ? [[RECORD]] : [],
  });
  return result?.result;
}

/** The `h=` names of the message's DKIM-Signature. */
function signedNames(message: Buffer): string[] {
  const field = /^DKIM-Signature:[\s\S]*?\r\n(?![ \t])/.exec(
    message.toString("latin1"),
  )?.[0];
  const h = /;\s*h=([^;]+);/.exec(field ?? "")?.[1] ?? "";
  return h.replace(/\s+/g, "").split(":");
}

describe("DKIM signature on the wire (#345)", () => {
  test("the receiver gets the signed bytes; they verify, sign the unsubscribe pair and over-sign From", async () => {
    received.length = 0;
    const parts = {
      from: "hello@example.com",
      headerTo: "user@example.org",
      headerCc: null,
      replyTo: null,
      subject: "unsubscribe test",
      html: null,
      text: "hi\r\n.a line that starts with a dot\r\n",
      messageId: "<wire@example.com>",
      headers: {},
      unsubscribe: { url: "https://example.com/u/abc" },
      dkim: { domainName: "example.com", keySelector: "bunmail", privateKey },
    };
    const signing = await signMessage(parts);
    if (signing.kind !== "signed") throw new Error("expected a signed message");
    const transactions = buildTransactionMails(parts, signing.raw, [
      { key: "k", recipients: ["user@example.org"], envelopeFrom: "hello@example.com" },
    ]);
    const outcomes = await runMxSession({
      address: "127.0.0.1",
      mxHost: "localhost",
      heloName: "test.localhost",
      transactions: transactions.map(({ key, mail }) => ({ key, mail })),
      port: receiverPort,
    });
    expect(outcomes.map((o) => o.error)).toEqual([undefined]);

    const sent = transactions[0]?.mail.raw;
    if (!Buffer.isBuffer(sent)) throw new Error("expected a raw signed message");
    expect(received).toHaveLength(1);
    const message = received[0] ?? Buffer.alloc(0);
    expect(message.equals(sent)).toBe(true);
    expect(await verdict(message)).toBe("pass");

    const names = signedNames(message);
    expect(names).toContain("list-unsubscribe");
    expect(names).toContain("list-unsubscribe-post");
    expect(names.filter((name) => name === "from")).toHaveLength(2);

    const spoofed = Buffer.from(
      message
        .toString("latin1")
        .replace(/^From: /m, "From: CEO <ceo@attacker.example>\r\nFrom: "),
      "latin1",
    );
    expect(await verdict(spoofed)).toBe("fail");
  });
});
