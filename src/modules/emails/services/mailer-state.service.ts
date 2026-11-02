import { logger } from "../../../utils/logger.ts";
import { parseRecipients, groupByDomain } from "../../../utils/recipients.ts";
import { mintReturnPath, recipientOrder } from "../../bounces/services/return-path.ts";
import type { DeliveryState } from "../models/email.schema.ts";

/**
 * Builds the initial state for a fresh send: one entry per recipient
 * domain (#250), keyed by the domain, at `status: "retry"` so the attempt
 * loop picks it up. No DNS here: each attempt resolves the domains itself.
 */
export function buildInitialState(
  to: string,
  cc: string | null | undefined,
  bcc: string | null | undefined,
): DeliveryState {
  const state: DeliveryState = {};
  for (const [domain, rcpts] of groupByDomain(parseRecipients(to, cc, bcc))) {
    state[domain] = {
      status: "retry",
      recipients: rcpts.map((r) => r.address),
      attempts: 0,
      domain,
    };
  }
  return state;
}

/** The lowercased domain of an address. */
function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * Gives every pending entry written before #250 its recipient domain, so
 * it is routed like a new one. Such an entry is keyed by its MX, which is
 * kept as its last known `mxHost`; one whose recipients span several
 * domains (two domains that shared an MX) is split into one entry per
 * domain, keyed `<old key>|<domain>`. Other entries are unchanged.
 */
export function withDomains(state: DeliveryState): DeliveryState {
  const next: DeliveryState = {};
  for (const [key, group] of Object.entries(state)) {
    if (
      group.status !== "retry" ||
      group.domain !== undefined ||
      key.startsWith("<dns:") ||
      group.recipients.length === 0
    ) {
      next[key] = group;
      continue;
    }
    const byDomain = new Map<string, string[]>();
    for (const recipient of group.recipients) {
      const domain = domainOf(recipient);
      byDomain.set(domain, [...(byDomain.get(domain) ?? []), recipient]);
    }
    const mxHost = group.mxHost ?? key;
    if (byDomain.size === 1) {
      next[key] = { ...group, domain: domainOf(group.recipients[0] ?? ""), mxHost };
      continue;
    }
    for (const [domain, recipients] of byDomain) {
      next[`${key}|${domain}`] = { ...group, recipients, domain, mxHost };
    }
  }
  return next;
}

/** A recipient's return-path index and address (#236); `address` is null when none could be minted. */
interface RecipientReturnPath {
  index: number;
  address: string | null;
}

/** Return paths of an email, by lowercased recipient (#236). */
type ReturnPaths = Map<string, RecipientReturnPath>;

/**
 * Mints the signed return path of every recipient of an email (#236), in
 * the documented recipient order (`recipientOrder`). A recipient that gets
 * none (an email id not in the `msg_` shape, which the queue never sends)
 * keeps the plain envelope sender; that is logged, since a DSN for it will
 * have no effect.
 */
export function returnPathsFor(
  emailId: string,
  from: string,
  to: string,
  cc: string | null | undefined,
  bcc: string | null | undefined,
): ReturnPaths {
  const senderDomain = from.slice(from.lastIndexOf("@") + 1);
  const paths: ReturnPaths = new Map();
  let unsigned = 0;
  recipientOrder(to, cc, bcc).forEach((recipient, index) => {
    const address = mintReturnPath({ emailId, index, recipient }, senderDomain);
    if (address === null) unsigned += 1;
    paths.set(recipient, { index, address });
  });
  if (unsigned > 0) {
    logger.warn("Signed return path unavailable: plain envelope sender used", {
      emailId,
      recipients: unsigned,
    });
  }
  return paths;
}

/**
 * Splits every pending group of several recipients into one entry per
 * recipient (#236), keyed `<group key>#<recipient index>` (the group key
 * is the domain, or the MX on an entry from before #250), so each
 * recipient is its own SMTP transaction and keeps its own outcome and
 * retries. Groups already `sent` or `failed`, and single-recipient groups,
 * are kept unchanged (a single-recipient email stays one entry keyed by
 * its domain, as without return paths).
 */
export function splitPerRecipient(
  state: DeliveryState,
  returnPaths: ReturnPaths,
): DeliveryState {
  const next: DeliveryState = {};
  for (const [key, group] of Object.entries(state)) {
    if (
      group.status !== "retry" ||
      group.recipients.length <= 1 ||
      key.startsWith("<dns:")
    ) {
      next[key] = group;
      continue;
    }
    group.recipients.forEach((recipient, position) => {
      const index = returnPaths.get(recipient.toLowerCase())?.index;
      const entryKey = index === undefined ? `${key}#u${position}` : `${key}#${index}`;
      next[entryKey] = { ...group, recipients: [recipient] };
    });
  }
  return next;
}

/**
 * The envelope sender of one transaction: the recipient's signed return
 * path when return paths are on and the transaction has exactly one
 * recipient (#236), else the From address.
 */
export function envelopeSenderFor(
  recipients: string[],
  returnPaths: ReturnPaths | null,
  from: string,
): string {
  const only = recipients.length === 1 ? recipients[0] : undefined;
  if (!returnPaths || only === undefined) return from;
  return returnPaths.get(only.toLowerCase())?.address ?? from;
}
