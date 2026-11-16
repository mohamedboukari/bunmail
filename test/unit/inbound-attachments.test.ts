import { describe, test, expect } from "bun:test";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import {
  getInboundAttachment,
  listInboundAttachments,
  parseAttachmentPosition,
} from "../../src/modules/inbound/services/inbound-attachments.service.ts";
import type { InboundEmail } from "../../src/modules/inbound/types/inbound.types.ts";

/**
 * Unit tests for inbound attachments (#486): parsed from the stored raw
 * message on demand, no database involved.
 */

/** A 1x1 PNG, for the inline image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

/** Builds a raw RFC 5322 message the way a sender's MTA would. */
async function rawMessage(attachments: Mail.Attachment[]): Promise<string> {
  const composer = new MailComposer({
    from: "alice@example.org",
    to: "inbox@sandbox.test",
    subject: "Files",
    html: '<p>See <img src="cid:dot@test"></p>',
    attachments,
  });
  const built = await composer.compile().build();
  return built.toString("utf8");
}

/** An inbound row around `raw`; only `rawMessage` and `id` matter here. */
function inbound(raw: string | null): InboundEmail {
  return {
    id: "inb_test",
    fromAddress: "alice@example.org",
    toAddress: "inbox@sandbox.test",
    subject: "Files",
    html: null,
    textContent: null,
    rawMessage: raw,
    messageId: null,
    inReplyTo: null,
    references: null,
    inReplyToEmailId: null,
    receivedAt: new Date("2026-11-16"),
    deletedAt: null,
  };
}

describe("listInboundAttachments", () => {
  test("lists every attachment in MIME order, with inline Content-ID", async () => {
    const raw = await rawMessage([
      {
        filename: "invoice.pdf",
        content: "%PDF-1.4 test",
        contentType: "application/pdf",
      },
      { filename: "dot.png", content: PNG, cid: "dot@test" },
      { filename: "résumé ✓.txt", content: "unicode name" },
    ]);

    const list = await listInboundAttachments(inbound(raw));

    /** The composer nests the inline image in multipart/related, ahead of the rest. */
    expect(list.map((a) => a.filename)).toEqual([
      "dot.png",
      "invoice.pdf",
      "résumé ✓.txt",
    ]);
    expect(list.map((a) => a.position)).toEqual([0, 1, 2]);
    expect(list[0]!.contentId).toBe("dot@test");
    expect(list[0]!.sizeBytes).toBe(PNG.length);
    expect(list[1]!.contentType).toBe("application/pdf");
    expect(list[1]!.sizeBytes).toBe("%PDF-1.4 test".length);
    expect(list[1]!.contentId).toBeNull();
  });

  test("names a part without a filename attachment-<n>", async () => {
    const raw = [
      "From: a@example.org",
      "To: b@sandbox.test",
      "Subject: unnamed",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "body",
      "--b",
      "Content-Type: application/octet-stream",
      "Content-Disposition: attachment",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("no name").toString("base64"),
      "--b--",
      "",
    ].join("\r\n");
    const list = await listInboundAttachments(inbound(raw));
    expect(list).toHaveLength(1);
    expect(list[0]!.filename).toBe("attachment-1");
  });

  test("returns an empty list without a raw message", async () => {
    expect(await listInboundAttachments(inbound(null))).toEqual([]);
    expect(await listInboundAttachments(inbound(""))).toEqual([]);
  });

  test("returns an empty list for a message without attachments", async () => {
    const raw =
      "From: a@example.org\r\nTo: b@sandbox.test\r\nSubject: hi\r\n\r\nbody\r\n";
    expect(await listInboundAttachments(inbound(raw))).toEqual([]);
  });
});

describe("getInboundAttachment", () => {
  test("returns the decoded bytes of the attachment at a position", async () => {
    const raw = await rawMessage([
      { filename: "notes.txt", content: "line one\n" },
      { filename: "dot.png", content: PNG, cid: "dot@test" },
    ]);

    const list = await listInboundAttachments(inbound(raw));
    const position = list.findIndex((a) => a.filename === "dot.png");
    const attachment = await getInboundAttachment(inbound(raw), position);

    expect(attachment?.filename).toBe("dot.png");
    expect(attachment?.position).toBe(position);
    expect(attachment?.content.equals(PNG)).toBe(true);
  });

  test("returns undefined past the last attachment", async () => {
    const raw = await rawMessage([{ filename: "notes.txt", content: "x" }]);
    expect(await getInboundAttachment(inbound(raw), 1)).toBeUndefined();
    expect(await getInboundAttachment(inbound(null), 0)).toBeUndefined();
  });
});

describe("parseAttachmentPosition", () => {
  test("accepts one to three digits", () => {
    expect(parseAttachmentPosition("0")).toBe(0);
    expect(parseAttachmentPosition("42")).toBe(42);
    expect(parseAttachmentPosition("999")).toBe(999);
  });

  test("refuses anything else", () => {
    for (const bad of ["", "-1", "1000", "1.5", "abc", " 1", "0x1"]) {
      expect(parseAttachmentPosition(bad)).toBeNull();
    }
  });
});
