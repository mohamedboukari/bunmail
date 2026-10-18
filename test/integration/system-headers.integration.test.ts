/**
 * Feedback-ID and Auto-Submitted headers (#250), rendered through
 * Nodemailer's stream transport (no SMTP, no database).
 */
import { describe, test, expect } from "bun:test";
import { createTransport } from "nodemailer";
import {
  buildMailOptions,
  feedbackIdHeader,
} from "../../src/modules/emails/services/mailer.service.ts";

async function headerBlock(
  options: ReturnType<typeof buildMailOptions>,
): Promise<string> {
  const transport = createTransport({ streamTransport: true, buffer: true });
  const info = await transport.sendMail(options);
  if (!Buffer.isBuffer(info.message)) throw new Error("expected a buffered message");
  return info.message.toString().split("\r\n\r\n")[0] ?? "";
}

const base = {
  recipients: ["user@example.org"],
  from: "hello@example.com",
  headerTo: "user@example.org",
  headerCc: null,
  replyTo: null,
  subject: "Hi",
  html: null,
  text: "hello",
  messageId: "<abc@mail.example.com>",
  headers: {},
};

describe("Feedback-ID", () => {
  test("API mail carries a low-cardinality Feedback-ID with the key hashed", async () => {
    const block = await headerBlock(
      buildMailOptions({
        ...base,
        feedback: { source: "api", apiKeyId: "key_secret123" },
      }),
    );
    const hashed = Bun.hash("key_secret123").toString(16).padStart(16, "0").slice(0, 12);
    expect(block).toContain(`Feedback-ID: api:${hashed}:example.com:bunmail`);
    expect(block).not.toContain("key_secret123");
  });

  test("fields are reduced to safe characters", () => {
    expect(feedbackIdHeader({ source: "smtp", apiKeyId: null }, "exa mple\r\n.com")).toBe(
      "smtp:system:example.com:bunmail",
    );
  });

  test("no feedback source: no header", async () => {
    expect(await headerBlock(buildMailOptions(base))).not.toContain("Feedback-ID");
  });
});

describe("Auto-Submitted", () => {
  test("BunMail's own mail is marked so auto-responders stay quiet", async () => {
    const block = await headerBlock(buildMailOptions({ ...base, autoSubmitted: true }));
    expect(block).toContain("Auto-Submitted: auto-generated");
    expect(block).toContain("X-Auto-Response-Suppress: All");
  });

  test("regular mail is not marked", async () => {
    expect(await headerBlock(buildMailOptions(base))).not.toContain("Auto-Submitted");
  });
});
