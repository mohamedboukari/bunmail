import { parseRecipients } from "../../../utils/recipients.ts";

/**
 * The `to` list of a send and its recipient caps (#178).
 *
 * `to` is one address or several. Several addresses make ONE message whose
 * `To:` header lists them all; delivery is still split per recipient
 * domain (and per recipient under signed return paths) by the mailer. The
 * list is stored on the email row as a comma-separated string, like `cc`
 * and `bcc`, so `parseRecipients` reads all three the same way.
 */

/** Most addresses in `to`, after deduplication. */
export const MAX_TO_RECIPIENTS = 50;

/** Most unique recipients across `to`, `cc` and `bcc` together. */
export const MAX_TOTAL_RECIPIENTS = 100;

/** The separator of a stored recipient list. */
const LIST_SEPARATOR = ", ";

/**
 * The `to` addresses of a send, in order: each item (or each comma-separated
 * piece of a string, which is how SMTP submission and stored rows carry
 * several) trimmed, empty pieces dropped, and duplicates removed ignoring
 * case, the first spelling kept. Syntax is not checked here: the REST DTO
 * checks every address, and `parseRecipients` drops a bad one at delivery.
 */
export function normalizeToList(to: string | readonly string[]): string[] {
  const pieces = typeof to === "string" ? to.split(",") : to.flatMap((a) => a.split(","));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const piece of pieces) {
    const address = piece.trim();
    if (address === "") continue;
    const lower = address.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(address);
  }
  return out;
}

/** A normalized `to` list in its stored form: `a@example.com, b@example.org`. */
export function joinToList(addresses: readonly string[]): string {
  return addresses.join(LIST_SEPARATOR);
}

/**
 * The addresses of a stored `to_address` (one, or several comma-separated),
 * for display and logging. Not deduplicated again: the stored list already is.
 */
export function splitToList(stored: string): string[] {
  return stored
    .split(",")
    .map((address) => address.trim())
    .filter((address) => address !== "");
}

/** Which recipient cap a send breaks. */
export type RecipientCapProblem = "to" | "total";

/**
 * The cap a send breaks, or `null`: more than {@link MAX_TO_RECIPIENTS}
 * addresses in the (normalized) `to` list, or more than
 * {@link MAX_TOTAL_RECIPIENTS} unique recipients across `to`, `cc` and
 * `bcc` (counted as `parseRecipients` delivers them: deduplicated ignoring
 * case across the three fields).
 */
export function recipientCapProblem(
  toList: readonly string[],
  cc: string | null | undefined,
  bcc: string | null | undefined,
): RecipientCapProblem | null {
  if (toList.length > MAX_TO_RECIPIENTS) return "to";
  if (parseRecipients(joinToList(toList), cc, bcc).length > MAX_TOTAL_RECIPIENTS) {
    return "total";
  }
  return null;
}
