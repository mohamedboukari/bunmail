import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "crypto";
import {
  signMessage,
  type MessageParts,
} from "../../src/modules/emails/services/mailer-message.service.ts";
import {
  sendMail,
  type DkimOptions,
  type SendMailResult,
} from "../../src/modules/emails/services/mailer.service.ts";
import type { Domain } from "../../src/modules/domains/types/domain.types.ts";
import { verifyDkimSignatures } from "../../src/modules/inbound/services/dkim-verifier.service.ts";
import {
  mailReport,
  type MailedReport,
} from "../../src/modules/tls-rpt/services/tls-rpt-mailto.service.ts";
import {
  buildReport,
  encodeReport,
} from "../../src/modules/tls-rpt/services/tls-rpt-report.ts";
import type { SystemMailDeps } from "../../src/modules/users/services/system-mail.service.ts";

/**
 * A TLS report by mail (RFC 8460 section 5.3, #345): `multipart/report;
 * report-type=tlsrpt`, a text part then the gzipped report as
 * `application/tlsrpt+gzip`, the subject and the two TLS-Report header
 * fields, DKIM-signed over them. Sent only from a usable `SYSTEM_MAIL_FROM`.
 * The send is replaced; the message is composed and signed for real.
 */

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const RECORD = `v=DKIM1; k=rsa; p=${keys.publicKey
  .export({ type: "spki", format: "der" })
  .toString("base64")}`;
const DKIM: DkimOptions = {
  domainName: "example.com",
  keySelector: "bunmail",
  privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
};

const DOMAIN: Domain = {
  id: "dom_1",
  name: "example.com",
  dkimPrivateKey: "v1:a:b:c",
  dkimPublicKey: null,
  dkimSelector: "bunmail",
  dkimPendingSelector: null,
  dkimPendingPrivateKey: null,
  dkimPendingPublicKey: null,
  dkimPendingCreatedAt: null,
  dkimPreviousSelector: null,
  dkimPreviousPublicKey: null,
  dkimRotatedAt: null,
  spfVerified: true,
  dkimVerified: true,
  dmarcVerified: true,
  verifiedAt: new Date(),
  lastCheckedAt: null,
  nextCheckAt: null,
  consecutiveFailures: 0,
  lastCheckResult: null,
  unsubscribeEmail: null,
  unsubscribeUrl: null,
  notifyEmail: null,
  trackOpens: false,
  trackClicks: false,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdByUserId: null,
};

const JSON_REPORT = buildReport({
  organizationName: "Example",
  contactEmail: "tls@example.com",
  rfcReportId: "0b6f9a3e-1d2c-4b5a-9e8f-7a6b5c4d3e2f",
  day: "2026-11-06",
  policyDomain: "example.net",
  results: [
    {
      policyType: "no-policy-found",
      policyHash: "a".repeat(32),
      policyString: "",
      mxHost: "",
      resultType: "success",
      receivingMxHostname: "",
      receivingIp: "",
      failureReasonCode: "",
      sessionCount: 3,
    },
  ],
  sendingIps: [],
});

const REPORT: MailedReport = {
  to: "tls-reports@example.net",
  policyDomain: "example.net",
  submitter: "example.com",
  organizationName: "Example",
  contactEmail: "tls@example.com",
  rfcReportId: "0b6f9a3e-1d2c-4b5a-9e8f-7a6b5c4d3e2f",
  day: "2026-11-06",
  filename: "example.com!example.net!1793923200!1794009599.json.gz",
  body: encodeReport(JSON_REPORT),
};

type SendOptions = Parameters<typeof sendMail>[0];

/** System mail deps that capture what would be sent; `status` is the MX outcome. */
function capture(
  overrides: Partial<SystemMailDeps> = {},
  status: "sent" | "retry" = "sent",
): { deps: SystemMailDeps; sent: SendOptions[] } {
  const sent: SendOptions[] = [];
  return {
    sent,
    deps: {
      from: "noreply@example.com",
      findDomain: async (name) => (name === "example.com" ? DOMAIN : undefined),
      resolveDkim: () => DKIM,
      send: async (options): Promise<SendMailResult> => {
        sent.push(options);
        return {
          messageId: options.messageId,
          deliveryState: {
            "example.net": { status, recipients: [options.to], attempts: 1 },
          },
        };
      },
      hostname: "mail.example.com",
      ...overrides,
    },
  };
}

/** Composes and signs what `mailReport` handed to `sendMail`, as the mailer would. */
async function composed(options: SendOptions): Promise<string> {
  const parts: MessageParts = {
    from: options.from,
    fromName: null,
    headerTo: options.to,
    headerCc: null,
    replyTo: null,
    subject: options.subject,
    html: options.html ?? null,
    text: options.text ?? null,
    messageId: options.messageId,
    headers: {},
    attachments: options.attachments ?? [],
    ...(options.dkim ? { dkim: options.dkim } : {}),
    ...(options.feedback ? { feedback: options.feedback } : {}),
    autoSubmitted: options.autoSubmitted === true,
    category: options.category ?? null,
    ...(options.report ? { report: options.report } : {}),
  };
  const signed = await signMessage(parts);
  if (signed.kind !== "signed") throw new Error(`not signed: ${signed.kind}`);
  return signed.raw.toString("latin1");
}

/** The header block of a raw message, unfolded. */
function headerBlock(raw: string): string {
  return (raw.split("\r\n\r\n")[0] ?? "").replace(/\r\n[ \t]+/g, " ");
}

describe("mailReport", () => {
  test("hands sendMail a DKIM-signed report from SYSTEM_MAIL_FROM", async () => {
    const { deps, sent } = capture();
    expect(await mailReport(REPORT, deps)).toEqual({ kind: "sent" });
    expect(sent).toHaveLength(1);
    const [options] = sent;
    expect(options?.from).toBe("noreply@example.com");
    expect(options?.to).toBe("tls-reports@example.net");
    expect(options?.dkim).toEqual(DKIM);
    expect(options?.html).toBeNull();
    expect(options?.subject).toBe(
      "Report Domain: example.net Submitter: example.com Report-ID: <0b6f9a3e-1d2c-4b5a-9e8f-7a6b5c4d3e2f>",
    );
    expect(options?.report).toEqual({
      reportType: "tlsrpt",
      headers: {
        "TLS-Report-Domain": "example.net",
        "TLS-Report-Submitter": "example.com",
      },
    });
    expect(options?.attachments).toEqual([
      {
        filename: REPORT.filename,
        contentType: "application/tlsrpt+gzip",
        contentId: null,
        content: REPORT.body,
      },
    ]);
  });

  test("the message: multipart/report, text then the gzipped report, signed over the TLS-Report fields", async () => {
    const { deps, sent } = capture();
    await mailReport(REPORT, deps);
    const options = sent[0];
    if (!options) throw new Error("nothing sent");
    const raw = await composed(options);
    const head = headerBlock(raw);

    const contentType = /^Content-Type: (.*)$/im.exec(head)?.[1] ?? "";
    expect(contentType).toMatch(/^multipart\/report; report-type=tlsrpt;/);
    const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1] ?? "";
    expect(boundary).not.toBe("");
    expect(head).toMatch(/^Tls-Report-Domain: example\.net$/im);
    expect(head).toMatch(/^Tls-Report-Submitter: example\.com$/im);
    expect(head).toMatch(
      /^Subject: Report Domain: example\.net Submitter: example\.com Report-ID: <0b6f9a3e-1d2c-4b5a-9e8f-7a6b5c4d3e2f>$/im,
    );

    const parts = raw.split(`--${boundary}`).slice(1, -1);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/Content-Type: text\/plain/);
    expect(parts[0]).toContain("SMTP TLS report (RFC 8460)");
    const [reportHead = "", reportBody = ""] = (parts[1] ?? "")
      .replace(/^\r\n/, "")
      .split("\r\n\r\n");
    expect(reportHead).toMatch(/Content-Type: application\/tlsrpt\+gzip/);
    expect(reportHead).toMatch(/Content-Transfer-Encoding: base64/);
    expect(reportHead).toContain(REPORT.filename);
    const gz = Buffer.from(reportBody.replace(/\s+/g, ""), "base64");
    expect(JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz)))).toEqual(JSON_REPORT);

    const h =
      /^DKIM-Signature:.*\bh=([^;]+);/im.exec(head)?.[1]?.replace(/\s+/g, "") ?? "";
    expect(h.split(":")).toContain("tls-report-domain");
    expect(h.split(":")).toContain("tls-report-submitter");
    const [verdict] = await verifyDkimSignatures(Buffer.from(raw, "latin1"), {
      resolveTxt: async (name) =>
        name === "bunmail._domainkey.example.com" ? [[RECORD]] : [],
    });
    expect(verdict?.result).toBe("pass");
  });

  test("no usable sender: skipped, nothing sent", async () => {
    const unset = capture({ from: null });
    expect(await mailReport(REPORT, unset.deps)).toEqual({
      kind: "skipped",
      reason: "SYSTEM_MAIL_FROM is not set",
    });
    const unverified = capture({
      findDomain: async () => ({ ...DOMAIN, dkimVerified: false }),
    });
    expect((await mailReport(REPORT, unverified.deps)).kind).toBe("skipped");
    expect([...unset.sent, ...unverified.sent]).toHaveLength(0);
  });

  test("an MX that did not take it: failed", async () => {
    const { deps } = capture({}, "retry");
    expect(await mailReport(REPORT, deps)).toEqual({
      kind: "failed",
      reason: "the receiving MX did not accept it",
    });
  });
});

describe("report messages in the mailer", () => {
  test("sendMail refuses a report without DKIM, before any lookup", async () => {
    let error: unknown;
    try {
      await sendMail({
        from: "noreply@example.com",
        to: "tls-reports@example.net",
        subject: "x",
        text: "x",
        messageId: "<r@example.com>",
        report: {
          reportType: "tlsrpt",
          headers: {
            "TLS-Report-Domain": "example.net",
            "TLS-Report-Submitter": "example.com",
          },
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toBe(
      "A report is only sent DKIM-signed",
    );
  });

  test("a report without its attachment is not composed (never a broken multipart)", async () => {
    const signed = await signMessage({
      from: "noreply@example.com",
      headerTo: "tls-reports@example.net",
      headerCc: null,
      replyTo: null,
      subject: "x",
      html: null,
      text: "only text",
      messageId: "<r2@example.com>",
      headers: {},
      dkim: DKIM,
      report: {
        reportType: "tlsrpt",
        headers: {
          "TLS-Report-Domain": "example.net",
          "TLS-Report-Submitter": "example.com",
        },
      },
    });
    expect(signed.kind).toBe("uncomposable");
  });

  test("header values never carry a line break", async () => {
    const raw = await composed({
      from: "noreply@example.com",
      to: "tls-reports@example.net",
      subject: "x",
      text: "x",
      messageId: "<r3@example.com>",
      dkim: DKIM,
      attachments: [
        {
          filename: "r.json.gz",
          contentType: "application/tlsrpt+gzip",
          contentId: null,
          content: new Uint8Array([1]),
        },
      ],
      report: {
        reportType: "tlsrpt",
        headers: {
          "TLS-Report-Domain": "example.net\r\nBcc: victim@example.org",
          "TLS-Report-Submitter": "example.com",
        },
      },
    });
    expect(headerBlock(raw)).not.toMatch(/^Bcc:/im);
  });
});

describe("report delivery limits (#345)", () => {
  test("the limits reach sendMail; without them none are set", async () => {
    const limited = capture();
    await mailReport(REPORT, limited.deps, { deadlineMs: 120_000, maxMxHosts: 2 });
    expect(limited.sent[0]?.deliveryLimits).toEqual({
      deadlineMs: 120_000,
      maxMxHosts: 2,
    });
    const plain = capture();
    await mailReport(REPORT, plain.deps);
    expect(plain.sent[0]?.deliveryLimits).toBeUndefined();
  });
});
