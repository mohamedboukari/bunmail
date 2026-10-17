/**
 * The DKIM signature must cover `List-Unsubscribe-Post`: RFC 8058 one-click
 * unsubscribe (which Gmail and Yahoo rely on) only counts when both
 * List-Unsubscribe headers are signed. Nodemailer's default list omits it.
 *
 * Signs a real message with the real nodemailer (no mocks in this tier)
 * using BunMail's header list, and reads the signature's `h=` tag.
 */
import { describe, test, expect } from "bun:test";
import { generateKeyPairSync } from "crypto";
import { createTransport } from "nodemailer";
import { DKIM_SIGNED_HEADERS } from "../../src/modules/emails/services/mailer.service.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

async function signedHeaderNames(headerFieldNames?: string): Promise<string[]> {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail({
    from: "hello@example.com",
    to: "user@example.org",
    subject: "unsubscribe test",
    text: "hi",
    list: { unsubscribe: { url: "https://example.com/u/abc", comment: "Unsubscribe" } },
    headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    dkim: {
      domainName: "example.com",
      keySelector: "bunmail",
      privateKey,
      headerFieldNames,
    },
  });
  const raw = Buffer.isBuffer(info.message)
    ? info.message.toString()
    : String(info.message);
  const signature = /^DKIM-Signature:([\s\S]*?)\r?\n(?!\s)/im.exec(raw)?.[1] ?? "";
  const h = /\bh=([^;]+)/.exec(signature.replace(/\s+/g, ""))?.[1] ?? "";
  return h.toLowerCase().split(":");
}

describe("DKIM signed headers", () => {
  test("BunMail's list signs List-Unsubscribe and List-Unsubscribe-Post", async () => {
    const names = await signedHeaderNames(DKIM_SIGNED_HEADERS);
    expect(names).toContain("list-unsubscribe");
    expect(names).toContain("list-unsubscribe-post");
    expect(names).toContain("from");
  });

  test("nodemailer's default list leaves List-Unsubscribe-Post unsigned", async () => {
    expect(await signedHeaderNames()).not.toContain("list-unsubscribe-post");
  });
});
