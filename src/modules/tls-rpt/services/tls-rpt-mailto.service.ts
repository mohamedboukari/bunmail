import type { DeliveryLimits } from "../../emails/services/mailer.service.ts";
import {
  oneLine,
  sendSystemMail,
  systemMailDeps,
  type SystemMailDeps,
} from "../../users/services/system-mail.service.ts";
import type { ReportSendOutcome } from "./tls-rpt-https.service.ts";
import { reportSubject } from "./tls-rpt-report.ts";

/**
 * Sends a TLS report by mail (RFC 8460 section 5.3, #345), from
 * `SYSTEM_MAIL_FROM` through BunMail's own outbound path, like invitations
 * (`sendSystemMail`): only when that address's domain is registered,
 * DKIM-verified and its key usable, and never unsigned (RFC 8460 requires
 * the DKIM signature). The message is `multipart/report;
 * report-type=tlsrpt`: a short text part, then the gzipped report as
 * `application/tlsrpt+gzip`, with `TLS-Report-Domain` and
 * `TLS-Report-Submitter` (both signed). MTA-STS is not applied to it
 * (`sendMail`'s `report` option): a report about TLS failures must reach
 * the domain despite them. The job passes tighter `limits` (a short
 * deadline, few MX hosts), so a hostile domain's MX cannot hold it.
 *
 * The recipient comes from the domain's record (`tls-rpt-record.ts`
 * checked it is one plain address); the MX path's address check refuses a
 * private MX as for any mail.
 */

/** What one mailed report is made of. */
export interface MailedReport {
  /** The reporting address (`mailto:` of the record), already checked. */
  to: string;
  policyDomain: string;
  submitter: string;
  organizationName: string;
  contactEmail: string;
  rfcReportId: string;
  day: string;
  filename: string;
  /** The gzipped report. */
  body: Uint8Array;
}

/** The text part: what the message is, in one paragraph. */
function textPart(report: MailedReport): string {
  return [
    oneLine(
      `This is an SMTP TLS report (RFC 8460) from ${report.organizationName} for ${report.policyDomain}, covering ${report.day} (UTC).`,
    ),
    oneLine(`The report is attached as ${report.filename}.`),
    oneLine(`Contact: ${report.contactEmail}`),
    "",
  ].join("\n");
}

/**
 * Mails `report`. `skipped` when the system sender is not usable (unset, not
 * registered, not DKIM-verified: a retry would not help), `failed` when the
 * receiving MX did not take it. Never throws.
 */
export async function mailReport(
  report: MailedReport,
  deps: SystemMailDeps = systemMailDeps(),
  limits?: DeliveryLimits,
): Promise<ReportSendOutcome> {
  const result = await sendSystemMail(
    {
      to: report.to,
      subject: reportSubject(report.policyDomain, report.submitter, report.rfcReportId),
      text: textPart(report),
      attachments: [
        {
          filename: report.filename,
          contentType: "application/tlsrpt+gzip",
          contentId: null,
          content: report.body,
        },
      ],
      report: {
        reportType: "tlsrpt",
        headers: {
          "TLS-Report-Domain": report.policyDomain,
          "TLS-Report-Submitter": report.submitter,
        },
      },
      ...(limits ? { deliveryLimits: limits } : {}),
    },
    deps,
  );
  if (result.sent) return { kind: "sent" };
  if (result.reason === "not_configured") {
    return { kind: "skipped", reason: "SYSTEM_MAIL_FROM is not set" };
  }
  if (result.reason === "sender_unavailable") {
    return {
      kind: "skipped",
      reason: "SYSTEM_MAIL_FROM's domain is not registered with a verified DKIM key",
    };
  }
  return { kind: "failed", reason: "the receiving MX did not accept it" };
}
