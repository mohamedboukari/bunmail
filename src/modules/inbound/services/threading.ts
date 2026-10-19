import { MAX_CUSTOM_HEADER_VALUE_LENGTH } from "../../emails/services/custom-headers.ts";

/**
 * RFC 5322 threading identifiers (#192): reading `Message-ID`,
 * `In-Reply-To` and `References` from received mail, and building the
 * `In-Reply-To` / `References` pair of a reply.
 *
 * Every value read here comes from the sender of an inbound message, so it
 * is attacker-controlled. Only syntactically valid msg-ids survive
 * (`<id-left@id-right>`, printable ASCII, no space, CR, LF or NUL, at most
 * {@link MAX_MESSAGE_ID_LENGTH} characters with the brackets); everything
 * else in a field (comments, junk, broken ids) is dropped. A reply's
 * headers are rebuilt from those ids alone, never from the raw field text.
 *
 * Pure: no I/O, no logging.
 */

/** Longest msg-id kept, in characters, angle brackets included. */
export const MAX_MESSAGE_ID_LENGTH = 250;

/** Most ids kept in a chain (stored `References`, outgoing `References`). */
export const MAX_THREAD_IDS = 20;

/**
 * A valid msg-id, brackets included: a dot-atom-ish left part, `@`, and a
 * dot-atom-ish right part or a domain literal (`[...]`). Quoted local parts
 * and obsolete forms are refused; a refused id only costs threading.
 */
const MESSAGE_ID_PATTERN =
  /^<[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+|\[[\x21-\x5a\x5e-\x7e]*\])>$/;

/** The threading identifiers of one message, each list valid, deduplicated and in order. */
export interface ThreadingIds {
  /** The message's own `Message-ID`, or `null` when it has no valid one. */
  messageId: string | null;
  /** Ids in `In-Reply-To`, capped to {@link MAX_THREAD_IDS}. */
  inReplyTo: string[];
  /** Ids in `References`, capped to {@link MAX_THREAD_IDS} (the first one is kept). */
  references: string[];
}

/** The threading headers of a reply, as custom headers (#177). */
export type ReplyThreadingHeaders = {
  "In-Reply-To": string;
  References: string;
};

/** One raw header line, as mailparser's `headerLines` holds it. */
export interface RawHeaderLine {
  /** Header name, lowercase. */
  key: string;
  /** The whole raw line, `Name: value`, folding line breaks included. */
  line: string;
}

/** Whether `id` (brackets included) is a msg-id this module keeps. */
export function isValidMessageId(id: string): boolean {
  return id.length <= MAX_MESSAGE_ID_LENGTH && MESSAGE_ID_PATTERN.test(id);
}

/**
 * The valid msg-ids in a header field value, in order, without
 * duplicates. The value is unfolded first (a line break followed by a space
 * or tab is removed); comments (`(...)`, nested, with `\` escapes) between
 * ids are skipped; an id that is not closed, holds a second `<`, or runs
 * past {@link MAX_MESSAGE_ID_LENGTH} is dropped. One pass, linear in the
 * length of `value`.
 */
export function extractMessageIds(value: string): string[] {
  const text = value.replace(/\r?\n(?=[ \t])/g, "");
  const ids: string[] = [];
  const seen = new Set<string>();
  /** Index of the `<` of the id being read, or -1. */
  let start = -1;
  /** True while skipping an overlong id up to its `>`. */
  let skipping = false;
  /** Comment nesting depth, outside ids only. */
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (skipping) {
      if (c === ">") skipping = false;
      continue;
    }
    if (start >= 0) {
      if (c === ">") {
        const id = text.slice(start, i + 1);
        if (isValidMessageId(id) && !seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
        start = -1;
      } else if (c === "<") {
        start = i;
      } else if (i - start >= MAX_MESSAGE_ID_LENGTH) {
        start = -1;
        skipping = true;
      }
      continue;
    }
    if (depth > 0) {
      if (c === "\\") i += 1;
      else if (c === "(") depth += 1;
      else if (c === ")") depth -= 1;
      continue;
    }
    if (c === "(") depth = 1;
    else if (c === "<") start = i;
  }
  return ids;
}

/**
 * At most `max` ids, dropping the oldest but keeping the first (the root of
 * the thread, which clients use to group it): the first id plus the last
 * `max - 1`.
 */
export function capThreadIds(ids: readonly string[], max = MAX_THREAD_IDS): string[] {
  if (ids.length <= max) return [...ids];
  if (max <= 1) return ids.slice(-max);
  return [ids[0]!, ...ids.slice(ids.length - (max - 1))];
}

/**
 * The longest tail of `ids` whose space-joined form fits in `maxLength`
 * characters, keeping the first id while it fits: the oldest ids after the
 * first are dropped first, then the first one itself. The last id is
 * always kept (a single id is at most {@link MAX_MESSAGE_ID_LENGTH}).
 */
export function fitThreadIds(
  ids: readonly string[],
  maxLength = MAX_CUSTOM_HEADER_VALUE_LENGTH,
): string[] {
  const kept = [...ids];
  while (kept.length > 1 && kept.join(" ").length > maxLength) {
    kept.splice(kept.length > 2 ? 1 : 0, 1);
  }
  return kept;
}

/**
 * The threading ids of a message from its raw header lines: the first
 * `Message-ID`, `In-Reply-To` and `References` field each (a repeated field
 * is ignored), validated by {@link extractMessageIds}.
 */
export function threadingIdsFromHeaderLines(
  lines: readonly RawHeaderLine[],
): ThreadingIds {
  const values = new Map<string, string>();
  for (const { key, line } of lines) {
    const name = key.toLowerCase();
    if (name !== "message-id" && name !== "in-reply-to" && name !== "references") {
      continue;
    }
    if (values.has(name)) continue;
    const colon = line.indexOf(":");
    if (colon >= 0) values.set(name, line.slice(colon + 1));
  }
  return {
    messageId: extractMessageIds(values.get("message-id") ?? "")[0] ?? null,
    inReplyTo: capThreadIds(extractMessageIds(values.get("in-reply-to") ?? "")),
    references: capThreadIds(extractMessageIds(values.get("references") ?? "")),
  };
}

/** The stored form of an id list: space-separated, `null` when empty. */
export function joinThreadIds(ids: readonly string[]): string | null {
  return ids.length > 0 ? ids.join(" ") : null;
}

/** The threading values of a stored inbound row (`inbound_emails`). */
export interface StoredThreading {
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
}

/**
 * The `In-Reply-To` and `References` of a reply to a message, per RFC 5322
 * section 3.6.4: `In-Reply-To` is the parent's `Message-ID`; `References` is
 * the parent's `References` followed by its `Message-ID` (appended, never
 * replaced). Without a `References` field, a parent whose `In-Reply-To`
 * holds a single id starts the chain with that id. The chain is capped to
 * {@link MAX_THREAD_IDS} and to 998 characters, dropping the oldest ids
 * after the first.
 *
 * Stored values are parsed again, so only valid ids ever reach a header.
 * `null` when the parent has no valid `Message-ID`: such a reply is sent
 * without threading headers.
 */
export function buildReplyHeaders(parent: StoredThreading): ReplyThreadingHeaders | null {
  const messageId = extractMessageIds(parent.messageId ?? "")[0];
  if (messageId === undefined) return null;

  let chain = extractMessageIds(parent.references ?? "");
  if (chain.length === 0) {
    const inReplyTo = extractMessageIds(parent.inReplyTo ?? "");
    if (inReplyTo.length === 1) chain = inReplyTo;
  }
  const ids = fitThreadIds(
    capThreadIds([...chain.filter((id) => id !== messageId), messageId]),
  );
  return { "In-Reply-To": messageId, References: ids.join(" ") };
}

/**
 * The ids an inbound message may be a reply to, most direct first:
 * `In-Reply-To`, then `References` from the newest to the oldest. Used to
 * find the email of ours it answers.
 */
export function replyCandidates(ids: ThreadingIds): string[] {
  const out: string[] = [];
  for (const id of [...ids.inReplyTo, ...ids.references.toReversed()]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
