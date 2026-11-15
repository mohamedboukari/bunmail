import type { SendWarning } from "../modules/emails/types/email.types.ts";
import type { Flash } from "./lib/flash.ts";

/**
 * Record names in the order the sentence lists them, with the bit each
 * one sets in the send flash's number (#421: the URL carries the bits,
 * never the sentence).
 */
const RECORDS: ReadonlyArray<readonly [SendWarning, string, number]> = [
  ["dkim_unverified", "DKIM", 1],
  ["spf_unverified", "SPF", 2],
  ["dmarc_unverified", "DMARC", 4],
];

/** "A", "A and B", "A, B and C". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * The dashboard send flash for a queued email (#245): "Email queued for
 * delivery", plus the sender-domain warnings so the sender learns why the
 * mail may be rejected or land in spam. Returned as a flash code (#421):
 * an unregistered domain has its own code, unverified records go as bits
 * of the numeric `email_queued_unverified` code.
 */
export function sendSuccessFlash(warnings: readonly SendWarning[]): Flash {
  if (warnings.includes("domain_unregistered")) return "email_queued_unregistered";
  const bits = RECORDS.reduce(
    (sum, [warning, , bit]) => (warnings.includes(warning) ? sum + bit : sum),
    0,
  );
  return bits === 0 ? "email_queued" : { code: "email_queued_unverified", n: bits };
}

/**
 * The text of `email_queued_unverified` for its number: the records whose
 * bit is set, in plain words. Bits outside the three records are ignored,
 * and no bit set is the plain "queued" sentence.
 */
export function queuedWithWarningsText(bits: number): string {
  const queued = "Email queued for delivery.";
  const unverified = RECORDS.filter(([, , bit]) => (bits & bit) !== 0).map(
    ([, name]) => name,
  );
  if (unverified.length === 0) return queued;
  const records = unverified.length === 1 ? "record is" : "records are";
  return `${queued} Warning: the sender domain's ${joinNames(unverified)} ${records} not verified, so the email may be rejected or land in spam. Publish the DNS records and run Verify on the Domains page.`;
}
