import { isIPv6 } from "net";
import { config } from "../../../config.ts";
import type { Domain, RequiredDnsRecord } from "../types/domain.types.ts";
import {
  getDkimDnsRecord,
  spfAuthorizationTerm,
  suggestedSpfRecord,
} from "./domain.service.ts";

/**
 * The DNS records an operator publishes for a domain (#250), shown on the
 * domain page and returned as `dnsRecords` by the domains API: SPF, DKIM,
 * DMARC, the A and PTR records of `MAIL_HOSTNAME`, and an optional MX.
 * Pure: the server settings are passed in (read from `config` by default).
 */

/** Longest character-string in a TXT record (RFC 1035 3.3). */
export const TXT_STRING_MAX = 255;

/** The server settings the records depend on. */
export interface DnsRecordSettings {
  /** `MAIL_HOSTNAME`. */
  mailHostname: string;
  /** `MAIL_PUBLIC_IP`, possibly empty. */
  publicIps: string[];
}

/**
 * Splits a TXT value into quoted strings of at most 255 characters each,
 * separated by spaces, as zone files and most DNS providers take a long
 * value. Receivers join the strings back without separators.
 */
export function splitTxtValue(value: string, max: number = TXT_STRING_MAX): string {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += max) chunks.push(value.slice(i, i + max));
  return chunks.map((chunk) => `"${chunk}"`).join(" ");
}

/** The address DMARC aggregate reports are suggested to go to. */
function dmarcReportAddress(domain: string): string {
  return `dmarc@${domain}`;
}

/**
 * The records to publish for `domain`, in the order a new setup adds them.
 * The DKIM record is left out when the domain has no public key.
 */
export function getRequiredDnsRecords(
  domain: Pick<Domain, "name" | "dkimSelector" | "dkimPublicKey">,
  settings: DnsRecordSettings = {
    mailHostname: config.mail.hostname,
    publicIps: config.mail.publicIps,
  },
): RequiredDnsRecord[] {
  const { mailHostname, publicIps } = settings;
  const records: RequiredDnsRecord[] = [
    {
      type: "TXT",
      host: domain.name,
      value: suggestedSpfRecord(mailHostname),
      purpose: "SPF: authorizes this server to send for the domain",
      optional: false,
      note: `Already have an SPF record (Google Workspace, Microsoft 365, ...)? Add the ${spfAuthorizationTerm(mailHostname)} term to it instead: a domain must publish exactly one SPF record.`,
    },
  ];

  const dkim = getDkimDnsRecord(domain);
  if (dkim !== null) {
    records.push({
      type: "TXT",
      host: `${domain.dkimSelector}._domainkey.${domain.name}`,
      value: splitTxtValue(dkim),
      purpose: "DKIM: the public key receivers check BunMail's signatures with",
      optional: false,
      note: "A TXT string holds at most 255 characters, so the key is split into quoted strings: paste them as they are. A provider that takes one unquoted value and splits it itself (the API's dkimDnsRecord) works too.",
    });
  }

  const reportAddress = dmarcReportAddress(domain.name);
  records.push({
    type: "TXT",
    host: `_dmarc.${domain.name}`,
    value: `v=DMARC1; p=none; rua=mailto:${reportAddress}`,
    purpose:
      "DMARC: the policy for mail failing SPF and DKIM alignment, and where reports go",
    optional: false,
    note: `p=none only collects reports: move to quarantine, then reject, once they show your mail passes. BunMail stores reports sent to ${reportAddress} when inbound SMTP is on (SMTP_ENABLED=true) and the domain's MX points at ${mailHostname}; otherwise use an address you read. Publish exactly one DMARC record: edit an existing one instead of adding another.`,
  });

  const serverNote = "Once per server, not per domain.";
  if (publicIps.length > 0) {
    for (const ip of publicIps) {
      records.push({
        type: isIPv6(ip) ? "AAAA" : "A",
        host: mailHostname,
        value: ip,
        purpose: "Points MAIL_HOSTNAME at this server (SPF a: term, reverse DNS check)",
        optional: false,
        note: serverNote,
      });
    }
    for (const ip of publicIps) {
      records.push({
        type: "PTR",
        host: ip,
        value: mailHostname,
        purpose: "Reverse DNS: the sending IP names MAIL_HOSTNAME",
        optional: false,
        note: `Set at your VPS or hosting provider, not in your DNS zone. ${mailHostname} must resolve back to ${ip}.`,
      });
    }
  } else {
    records.push(
      {
        type: "A",
        host: mailHostname,
        value: "this server's public IP address",
        purpose: "Points MAIL_HOSTNAME at this server (SPF a: term, reverse DNS check)",
        optional: false,
        note: `${serverNote} Set MAIL_PUBLIC_IP to show the exact address here.`,
      },
      {
        type: "PTR",
        host: "this server's public IP address",
        value: mailHostname,
        purpose: "Reverse DNS: the sending IP names MAIL_HOSTNAME",
        optional: false,
        note: `Set at your VPS or hosting provider, not in your DNS zone. ${mailHostname} must resolve back to the same address.`,
      },
    );
  }

  records.push({
    type: "MX",
    host: domain.name,
    value: `10 ${mailHostname}`,
    purpose: "Receives bounces, DMARC reports and inbound mail at BunMail",
    optional: true,
    note: "Only to receive bounces, DMARC reports and inbound mail here (SMTP_ENABLED=true). Sending works without it. Leave an MX that serves mailboxes (Google Workspace, Microsoft 365) as it is: replacing it moves this domain's mail to BunMail.",
  });

  return records;
}
