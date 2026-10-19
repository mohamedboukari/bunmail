import { describe, test, expect } from "bun:test";
import {
  automaticInboundReason,
  buildInboundNotification,
  plainTextLine,
  type BuildNotificationInput,
} from "../../src/modules/inbound/services/inbound-notify.service.ts";
import { optionalStrictBoolean } from "../../src/config.ts";

/**
 * Unit tests for the pure parts of inbound notifications (#106, #250):
 * the builder, the line sanitizer and the automatic-mail check. The
 * orchestrator runs against the real receiver in
 * test/integration/inbound-notify.integration.test.ts.
 */

/** Every link-like fragment the hostile inputs below carry. */
const HOSTILE_LINKS = ["http://", "https://", "www.", "evil.example", "phish.example"];

const base: BuildNotificationInput = {
  to: "hello@example.com",
  from: "sender@somewhere.com",
  receivedAt: new Date("2026-10-19T12:00:00Z"),
  sizeBytes: 2048,
  detailUrl: null,
  preview: false,
  subject: "Verify your account https://evil.example/login now",
  text: "Click http://phish.example/x or www.phish.example/reset or HTTPS://EVIL.EXAMPLE today",
  skipped: null,
};

/** The whole composed output, subject included, lower-cased. */
function everything(input: BuildNotificationInput): string {
  const { subject, text } = buildInboundNotification(input);
  return `${subject}\n${text}`.toLowerCase();
}

/** The first line of the text part starting with `prefix`. */
function lineStarting(input: BuildNotificationInput, prefix: string): string | undefined {
  return buildInboundNotification(input)
    .text.split("\n")
    .find((l) => l.startsWith(prefix));
}

describe("buildInboundNotification, preview off (the default)", () => {
  test("the subject is fixed and never carries the inbound subject", () => {
    expect(buildInboundNotification(base).subject).toBe(
      "New email for hello@example.com",
    );
  });

  test("no inbound subject, no body text and no link anywhere", () => {
    const all = everything(base);
    expect(all).not.toContain("verify your account");
    expect(all).not.toContain("click");
    for (const fragment of HOSTILE_LINKS) expect(all).not.toContain(fragment);
  });

  test("names the sender as text, the arrival time and the size", () => {
    const { text } = buildInboundNotification(base);
    expect(text).toContain("You have a new email at hello@example.com.");
    expect(text).toContain("From:     sender@somewhere.com");
    expect(text).toContain("Received: Mon, 19 Oct 2026 12:00:00 GMT");
    expect(text).toContain("Size:     2.0 KB");
    expect(text).not.toContain("Subject:");
  });

  test("plain text only: there is no html part", () => {
    expect(Object.keys(buildInboundNotification(base)).toSorted()).toEqual([
      "subject",
      "text",
    ]);
  });

  test("the dashboard link only when detailUrl is set, and no other link", () => {
    const url = "https://mail.example.com/dashboard/inbound/inb_123";
    const { text } = buildInboundNotification({ ...base, detailUrl: url });
    expect(text).toContain(`View it in your dashboard: ${url}`);
    expect(text.match(/https?:\/\//g)).toEqual(["https://"]);
    expect(buildInboundNotification(base).text).not.toContain("dashboard/inbound");
  });

  test("sizes are readable", () => {
    expect(lineStarting({ ...base, sizeBytes: 512 }, "Size:")).toBe(
      "Size:     512 bytes",
    );
    expect(lineStarting({ ...base, sizeBytes: 5 * 1024 * 1024 }, "Size:")).toBe(
      "Size:     5.0 MB",
    );
  });

  test("a sender address carrying a link does not relay it", () => {
    const all = everything({ ...base, from: "https://evil.example/x@somewhere.com" });
    expect(all).not.toContain("evil.example");
    expect(all).toContain("[link removed]");
  });

  test("a recipient local part carrying a link does not reach the subject", () => {
    const { subject } = buildInboundNotification({
      ...base,
      to: "www.evil.example@example.com",
    });
    expect(subject).toBe("New email for [link removed]");
  });

  test("a www. inside a domain stays readable", () => {
    expect(lineStarting({ ...base, from: "news@www.example.org" }, "From:")).toBe(
      "From:     news@www.example.org",
    );
  });

  test("CR/LF in the sender cannot add lines", () => {
    const { text } = buildInboundNotification({
      ...base,
      from: "a@b.example\r\nSubject: injected\r\n\r\nbody",
    });
    expect(text).not.toMatch(/^Subject: injected/m);
    expect(text).toContain("From:     a@b.example Subject: injected body");
  });

  test("reports mail skipped by the throttle", () => {
    const since = Date.parse("2026-10-19T11:55:00Z");
    expect(
      buildInboundNotification({ ...base, skipped: { count: 1, since } }).text,
    ).toContain("And 1 more email since Mon, 19 Oct 2026 11:55:00 GMT");
    expect(
      buildInboundNotification({ ...base, skipped: { count: 7, since } }).text,
    ).toContain("And 7 more emails since Mon, 19 Oct 2026 11:55:00 GMT");
    expect(buildInboundNotification(base).text).not.toContain("more email");
  });
});

describe("buildInboundNotification, preview on", () => {
  const on: BuildNotificationInput = { ...base, preview: true };

  test("the subject line stays fixed", () => {
    expect(buildInboundNotification(on).subject).toBe("New email for hello@example.com");
  });

  test("the original subject and the preview are in the body, every link replaced", () => {
    const { text } = buildInboundNotification(on);
    expect(text).toContain("Subject:  Verify your account [link removed] now");
    expect(text).toContain(
      "Click [link removed] or [link removed] or [link removed] today",
    );
    const all = everything(on);
    for (const fragment of HOSTILE_LINKS) expect(all).not.toContain(fragment);
  });

  test("(no subject) when absent or blank", () => {
    for (const subject of [null, "   "]) {
      expect(lineStarting({ ...on, subject }, "Subject:")).toBe("Subject:  (no subject)");
    }
  });

  test("CR/LF in the subject cannot add lines or headers", () => {
    const { subject, text } = buildInboundNotification({
      ...on,
      subject: "Hi\r\nBcc: victim@example.org\r\n\r\nfake body",
    });
    expect(subject).not.toMatch(/[\r\n]/);
    expect(text).not.toMatch(/^Bcc:/m);
    expect(text).toContain("Subject:  Hi Bcc: victim@example.org fake body");
  });

  test("a very long subject and body are cut to 200 characters", () => {
    const input = { ...on, subject: "s".repeat(5000), text: "word ".repeat(1000) };
    expect(lineStarting(input, "Subject:")).toBe(`Subject:  ${"s".repeat(200)}…`);
    const preview = lineStarting(input, "word word") ?? "";
    expect(preview.endsWith("…")).toBe(true);
    expect(Array.from(preview).length).toBeLessThanOrEqual(201);
  });

  test("unicode is kept whole, bidi controls are dropped", () => {
    const input = {
      ...on,
      subject: "😀".repeat(300),
      text: "Invoice ‮fdp.exe‬ ready",
    };
    expect(lineStarting(input, "Subject:")).toBe(`Subject:  ${"😀".repeat(200)}…`);
    const { text } = buildInboundNotification(input);
    expect(text).toContain("Invoice fdp.exe ready");
    expect(text).not.toMatch(/[‪-‮]/);
  });

  test("no preview block when there is no text part", () => {
    const { text } = buildInboundNotification({ ...on, text: null });
    expect(text).toContain("Subject:");
    expect(text).not.toContain("Click");
  });
});

describe("plainTextLine", () => {
  test("replaces http, https and www links, any case", () => {
    expect(plainTextLine("a http://x.example/b c", 100)).toBe("a [link removed] c");
    expect(plainTextLine("HtTpS://X.EXAMPLE", 100)).toBe("[link removed]");
    expect(plainTextLine("go to WWW.x.example/y.", 100)).toBe("go to [link removed]");
    expect(plainTextLine("(www.x.example)", 100)).toBe("([link removed]");
  });

  test("a link cut by the length limit is still replaced", () => {
    const line = plainTextLine(
      `${"a ".repeat(98)}https://evil.example/very/long/path`,
      200,
    );
    expect(line).not.toContain("evil");
    expect(line).not.toContain("http");
  });

  test("a link split from its text by a line break is still replaced", () => {
    expect(plainTextLine("see\r\nhttps://evil.example", 100)).toBe("see [link removed]");
  });
});

describe("automaticInboundReason", () => {
  const line = (name: string, value: string): { key: string; line: string } => ({
    key: name.toLowerCase(),
    line: `${name}: ${value}`,
  });
  const human = [line("From", "a@b.example"), line("Subject", "hi")];

  test("a regular message is not automatic", () => {
    expect(automaticInboundReason(human, "a@b.example")).toBeNull();
    expect(
      automaticInboundReason([...human, line("Auto-Submitted", "no")], "a@b.example"),
    ).toBeNull();
    expect(
      automaticInboundReason(
        [line("Auto-Submitted", "No (sent by a person)")],
        "a@b.example",
      ),
    ).toBeNull();
    expect(
      automaticInboundReason([line("Precedence", "first-class")], "a@b.example"),
    ).toBeNull();
  });

  test.each([
    ["auto-replied"],
    ["auto-generated"],
    ["AUTO-NOTIFIED; owner-email=x@y.example"],
    [""],
  ])("Auto-Submitted: %p is automatic", (value) => {
    expect(
      automaticInboundReason([...human, line("Auto-Submitted", value)], "a@b.example"),
    ).toBe("auto_submitted");
  });

  test.each(["bulk", "junk", "list", "Bulk", " LIST "])(
    "Precedence: %p is automatic",
    (v) => {
      expect(automaticInboundReason([line("Precedence", v)], "a@b.example")).toBe(
        "precedence",
      );
    },
  );

  test.each(["X-Autoreply", "X-Autorespond", "x-autoreply"])(
    "%s is automatic",
    (name) => {
      expect(automaticInboundReason([line(name, "yes")], "a@b.example")).toBe(
        "autoreply_header",
      );
    },
  );

  test("a folded Auto-Submitted value is read whole", () => {
    expect(
      automaticInboundReason(
        [{ key: "auto-submitted", line: "Auto-Submitted:\r\n auto-replied" }],
        "a@b.example",
      ),
    ).toBe("auto_submitted");
  });

  test("a null or blank return path is automatic", () => {
    expect(automaticInboundReason(human, "")).toBe("null_return_path");
    expect(automaticInboundReason(human, "  ")).toBe("null_return_path");
  });
});

describe("INBOUND_NOTIFY_PREVIEW", () => {
  /**
   * Read through the parser, not the `config` singleton: other unit files
   * stub `config` with `mock.module`, and that stub leaks into this file in
   * some run orders. The `undefined` case below is the default.
   */
  test("off by default; strict: only true or false, anything else refuses to boot", () => {
    const read = (raw: string | undefined): boolean =>
      optionalStrictBoolean("INBOUND_NOTIFY_PREVIEW", false, raw);
    expect(read(undefined)).toBe(false);
    expect(read("true")).toBe(true);
    expect(read("false")).toBe(false);
    for (const raw of ["1", "yes", "TRUE", "on"]) {
      expect(() => read(raw)).toThrow(/INBOUND_NOTIFY_PREVIEW must be "true" or "false"/);
    }
  });
});
