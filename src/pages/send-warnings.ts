import type { SendWarning } from "../modules/emails/types/email.types.ts";

/** Record names in the order the sentence lists them. */
const RECORD_NAMES: ReadonlyArray<readonly [SendWarning, string]> = [
  ["dkim_unverified", "DKIM"],
  ["spf_unverified", "SPF"],
  ["dmarc_unverified", "DMARC"],
];

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The dashboard send flash for a queued email (#245): "Email queued for
 * delivery", plus the sender-domain warnings in plain words so the sender
 * learns why the mail may be rejected or land in spam.
 */
export function sendSuccessFlash(warnings: readonly SendWarning[]): string {
  const queued = "Email queued for delivery.";
  if (warnings.includes("domain_unregistered")) {
    return `${queued} Warning: the sender domain is not registered in BunMail, so the email goes out without a DKIM signature (allowed in development only). Add it on the Domains page.`;
  }
  const unverified = RECORD_NAMES.filter(([w]) => warnings.includes(w)).map(
    ([, name]) => name,
  );
  if (unverified.length === 0) return queued;
  const records = unverified.length === 1 ? "record is" : "records are";
  return `${queued} Warning: the sender domain's ${joinNames(unverified)} ${records} not verified, so the email may be rejected or land in spam. Publish the DNS records and run Verify on the Domains page.`;
}
