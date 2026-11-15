/**
 * Pure ARF parser (RFC 5965, #191): feedback-loop complaint reports from
 * mailbox providers (Yahoo/AOL CFL, Microsoft JMRP, ...). Takes the raw
 * RFC 822 message the SMTP receiver accepted and returns the fields the
 * complaint handler needs, or `null` when the message is not a usable
 * feedback report.
 *
 * Pure on purpose (no I/O, no mailparser) so unit tests feed fixture
 * strings and assert the shape. The input is unauthenticated and up to
 * the receiver's 10 MB cap, so every step is bounded and linear: header
 * sections are read from their first 64 KB only, at most 200 fields per
 * section and 1000 characters per field, at most 16 MIME parts, and only
 * the first bytes of each part are looked at (the feedback part is small,
 * and only the headers of the reported message are needed). No regex
 * here is built from input, and none backtracks over more than a capped
 * slice.
 *
 * Shape of a report (RFC 5965 section 2):
 *
 *   Content-Type: multipart/report; report-type=feedback-report; boundary=...
 *     1. text/plain                  human-readable note (ignored)
 *     2. message/feedback-report     machine-readable fields
 *     3. message/rfc822 or           the reported message, often with the
 *        text/rfc822-headers         body (or more) redacted
 */

import { isEmailAddress } from "../../../utils/recipients.ts";
import { lowerAscii, trimFws } from "./dkim-verifier-parse.service.ts";
import type { FeedbackReport } from "../types/feedback-report.types.ts";

/** How much of any header section is read. */
const MAX_HEADER_BYTES = 64 * 1024;

/** Fields kept per header section; the rest are ignored. */
const MAX_FIELDS = 200;

/** Longest field value kept (longer ones are cut, folded lines included). */
const MAX_FIELD_LENGTH = 1000;

/** Longest field name looked at; longer "names" are not header fields. */
const MAX_FIELD_NAME_LENGTH = 76;

/** MIME parts looked at in the report. RFC 5965 needs three. */
const MAX_PARTS = 16;

/** How much of one part is kept: enough for the feedback fields or the headers. */
const MAX_PART_SCAN = 2 * MAX_HEADER_BYTES;

/** `Original-Rcpt-To` fields kept. */
const MAX_RCPT_TO = 50;

/** RFC 2046 caps a boundary at 70 characters; anything much longer is hostile. */
const MAX_BOUNDARY_LENGTH = 200;

/** `emails.message_id` is varchar(255); a longer id can never match one of ours. */
const MAX_MESSAGE_ID_LENGTH = 255;

/** Longest slice an address regex looks at (an address is at most 254 characters). */
const MAX_ADDRESS_SCAN = 300;

/** Longest feedback type kept (registered ones are a single short word). */
const MAX_FEEDBACK_TYPE_LENGTH = 64;

/** One header field: lowercased name, unfolded and trimmed value. */
interface HeaderField {
  name: string;
  value: string;
}

/** A parsed `Content-Type`: lowercased type and its parameters (lowercased names). */
interface ContentType {
  type: string;
  params: Map<string, string>;
}

/**
 * How a blank line is recognised. `strict` (an empty line) for the
 * message's own header section, the way the DKIM verifier ends it: there a
 * line of spaces continues the field above. `relaxed` (empty or only SP
 * and HTAB) everywhere inside the body, where relaxed DKIM body
 * canonicalization treats the two as the same line, so they must split the
 * same way.
 */
const BLANK_LINE = {
  strict: { start: /^\r?\n/, between: /\r?\n\r?\n/ },
  relaxed: { start: /^[ \t]*\r?\n/, between: /\r?\n[ \t]*\r?\n/ },
} as const;

/**
 * Splits `text` at the blank line ending its header section (see
 * {@link BLANK_LINE}). Only the first {@link MAX_HEADER_BYTES} are
 * searched; a section running past that is cut there (and the body is
 * then empty). Text starting with a blank line has no headers at all.
 */
function splitHeaderSection(
  text: string,
  blankLine: keyof typeof BLANK_LINE = "relaxed",
): { headers: string; body: string } {
  const rule = BLANK_LINE[blankLine];
  const window = text.slice(0, MAX_HEADER_BYTES);
  const leading = rule.start.exec(window);
  if (leading) return { headers: "", body: text.slice(leading[0].length) };
  const end = rule.between.exec(window);
  if (!end) return { headers: window, body: "" };
  return {
    headers: text.slice(0, end.index),
    body: text.slice(end.index + end[0].length),
  };
}

/**
 * The body as relaxed DKIM body canonicalization sees it (RFC 6376 section
 * 3.4.4), with every line end made LF (so the size caps applied later fall
 * in the same place whatever the input's line ends): every run of SP and HTAB made one SP, a space at
 * the end of a line dropped, and the empty lines at the end dropped. Two
 * bodies a relaxed signature cannot tell apart become the same text, so
 * whatever parts and fields are read from one are read from the other.
 * Linear: runs are collapsed first, so the second pass looks at one space.
 */
function relaxedBody(body: string): string {
  const collapsed = body
    .replace(/\r?\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ (?=\n)/g, "");
  let end = collapsed.length;
  while (end > 0 && " \r\n".includes(collapsed[end - 1]!)) end -= 1;
  return collapsed.slice(0, end);
}

/**
 * Parses a header section into fields, unfolding continuation lines (a line
 * starting with a space or tab continues the previous field). Lines without
 * a colon, including blank ones, are skipped, so the same function reads the
 * machine-readable feedback part.
 */
function parseFields(section: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of section.split(/\r?\n/)) {
    /** A line of only SP and HTAB is a blank line, like an empty one: skipped. */
    if (/^[ \t]*$/.test(line)) continue;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      const last = fields.at(-1);
      if (last && last.value.length < MAX_FIELD_LENGTH) {
        last.value = `${last.value} ${line.trim()}`.trim().slice(0, MAX_FIELD_LENGTH);
      }
      continue;
    }
    if (fields.length >= MAX_FIELDS) break;
    const colon = line.indexOf(":");
    if (colon <= 0 || colon > MAX_FIELD_NAME_LENGTH) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === "" || /\s/.test(name)) continue;
    fields.push({
      name,
      value: line
        .slice(colon + 1)
        .trim()
        .slice(0, MAX_FIELD_LENGTH),
    });
  }
  return fields;
}

/** Value of the first field named `name` (lowercase), or `null`. */
function firstField(fields: HeaderField[], name: string): string | null {
  return fields.find((field) => field.name === name)?.value ?? null;
}

/** First field named `name`, trimmed, or `null` when missing or empty. */
function firstNonEmpty(fields: HeaderField[], name: string): string | null {
  const value = firstField(fields, name)?.trim();
  return value ? value : null;
}

/** Parses a `Content-Type` value; parameters may be quoted, names in any case. */
function parseContentType(value: string | null): ContentType {
  const [type = "", ...rest] = (value ?? "").split(";");
  const params = new Map<string, string>();
  for (const piece of rest) {
    const eq = piece.indexOf("=");
    if (eq <= 0) continue;
    const name = piece.slice(0, eq).trim().toLowerCase();
    let paramValue = piece.slice(eq + 1).trim();
    if (
      paramValue.length >= 2 &&
      paramValue.startsWith('"') &&
      paramValue.endsWith('"')
    ) {
      paramValue = paramValue.slice(1, -1);
    }
    if (!params.has(name)) params.set(name, paramValue);
  }
  return { type: type.trim().toLowerCase(), params };
}

/** True for `multipart/report` with `report-type=feedback-report`, in any case. */
function isFeedbackContentType(contentType: ContentType): boolean {
  return (
    contentType.type === "multipart/report" &&
    contentType.params.get("report-type")?.toLowerCase() === "feedback-report"
  );
}

/** The top-level `Content-Type` of a raw message. */
function topContentType(raw: string): {
  contentType: ContentType;
  fields: HeaderField[];
  body: string;
} {
  const { headers, body } = splitHeaderSection(raw, "strict");
  const fields = parseFields(headers);
  return {
    contentType: parseContentType(firstField(fields, "content-type")),
    fields,
    body,
  };
}

/**
 * Splits a multipart body into at most {@link MAX_PARTS} parts, each cut to
 * {@link MAX_PART_SCAN} characters. A delimiter is `--<boundary>` at the
 * start of a line; `--<boundary>--` closes the body. Each search starts
 * where the previous one stopped, so the whole walk is one linear pass.
 */
function splitParts(body: string, boundary: string): string[] {
  const delimiter = `--${boundary}`;
  const marker = `\n${delimiter}`;
  const parts: string[] = [];

  let start: number;
  if (body.startsWith(delimiter)) {
    start = 0;
  } else {
    const found = body.indexOf(marker);
    if (found < 0) return parts;
    start = found + 1;
  }

  while (parts.length < MAX_PARTS) {
    const afterDelimiter = start + delimiter.length;
    if (body.startsWith("--", afterDelimiter)) break;
    const lineEnd = body.indexOf("\n", afterDelimiter);
    if (lineEnd < 0) break;
    const next = body.indexOf(marker, lineEnd);
    const end = next < 0 ? body.length : next;
    const contentEnd = Math.min(end, lineEnd + 1 + MAX_PART_SCAN);
    let content = body.slice(lineEnd + 1, contentEnd);
    if (contentEnd === end && content.endsWith("\r")) content = content.slice(0, -1);
    parts.push(content);
    if (next < 0) break;
    start = next + 1;
  }
  return parts;
}

/**
 * Decodes a part body for its `Content-Transfer-Encoding`: base64 is decoded
 * (whitespace and line breaks are skipped by the decoder), anything else is
 * read as is. The result is cut to `cap` characters.
 */
function decodePart(body: string, encoding: string | null, cap: number): string {
  if (encoding?.trim().toLowerCase() === "base64") {
    return Buffer.from(body, "base64").toString("utf-8").slice(0, cap);
  }
  return body.slice(0, cap);
}

/**
 * The bare address in a field value such as `user@example.com`,
 * `<user@example.com>` or `rfc822; user@example.com`, lowercased, or `null`
 * when there is none (a redacted value, for example).
 */
function cleanAddress(value: string | null): string | null {
  if (value === null) return null;
  const semicolon = value.indexOf(";");
  const rest = (semicolon >= 0 ? value.slice(semicolon + 1) : value).slice(
    0,
    MAX_ADDRESS_SCAN,
  );
  const match = /<?([^@<>\s;]+@[^@<>\s;]+)>?/.exec(rest);
  const address = match?.[1]?.toLowerCase();
  return address !== undefined && isEmailAddress(address) ? address : null;
}

/**
 * The one address of a `From` field value, or `null` when the value is not
 * plainly one mailbox. Accepted: a bare address without quotes, or a
 * leading display name (plain, or one quoted string) and the address in
 * angle brackets, which is how feedback-loop senders write it. Refused
 * rather than tokenized (RFC 5322 comments nest): a value of
 * {@link MAX_FIELD_LENGTH} characters or more (it may have been cut), a
 * backslash anywhere, a quote anywhere but around the leading display
 * name, a `(` or `)` outside it (a comment), a list or group (`,`, `;`,
 * `:`), anything after the closing bracket, and an address with anything
 * but printable ASCII.
 * The address is lowercased in ASCII only, so no other character folds
 * into a listed one. Linear: no pattern backtracks.
 *
 * Shared with the DKIM side (`feedback-verification.service.ts`), which
 * reads the `From` field the signature covers.
 */
export function mailboxAddress(value: string): string | null {
  /** A backslash anywhere: an escaped quote would change where a quoted name ends. */
  if (value.length >= MAX_FIELD_LENGTH || value.includes("\\")) return null;
  const trimmed = trimFws(value);
  /**
   * `Name <address>`: the name is one quoted string (anything but `"`
   * inside) or plain text without quotes, brackets, `@`, comments or list
   * separators, and nothing follows the closing bracket. Otherwise the
   * whole value is the address. Linear: the alternatives cannot overlap.
   */
  const angle = /^(?:"[^"]*"[ \t]*|[^"<>@(),;:]*)<([^<>"]+)>$/.exec(trimmed);
  if (trimmed.includes("<") && !angle) return null;
  const candidate = angle ? angle[1]! : trimmed;
  if (!/^[\x21-\x7e]+$/.test(candidate) || /["(),;:<>]/.test(candidate)) return null;
  const address = lowerAscii(candidate);
  return isEmailAddress(address) ? address : null;
}

/**
 * The one mailbox of a report's `From` as this parser reads it, or `null`:
 * when the header section has no `From` field or more than one, or the
 * value is not plainly one mailbox ({@link mailboxAddress}). Logged only:
 * whether a complaint is verified depends on the `From` field the DKIM
 * signature covers, read by the verifier's own header split.
 */
function singleMailbox(fields: HeaderField[]): string | null {
  const from = fields.filter((field) => field.name === "from");
  return from.length === 1 ? mailboxAddress(from[0]!.value) : null;
}

/**
 * The Message-ID in a field value, without angle brackets: the first
 * `<...>` token, else the bare value when it has no space or bracket.
 * `null` when there is none or it is longer than any id BunMail stores.
 */
function cleanMessageId(value: string | null): string | null {
  if (value === null) return null;
  const bracketed = /<([^<>\s]{1,255})>/.exec(value);
  const id = bracketed?.[1] ?? value.trim();
  if (id === "" || id.length > MAX_MESSAGE_ID_LENGTH || /[<>\s]/.test(id)) return null;
  return id;
}

/** A date field as a `Date`, or `null` when it does not parse. */
function parseDate(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * True when the message's top-level `Content-Type` is `multipart/report`
 * with `report-type=feedback-report` (parameter names and values in any
 * case, quoted or not). Cheap: reads the top header section only.
 */
export function isFeedbackReport(raw: string): boolean {
  return isFeedbackContentType(topContentType(raw).contentType);
}

/**
 * Parses an ARF feedback report. Returns `null` when the message is not a
 * `feedback-report` or has no `message/feedback-report` part.
 */
export function parseFeedbackReport(raw: string): FeedbackReport | null {
  const top = topContentType(raw);
  if (!isFeedbackContentType(top.contentType)) return null;
  /**
   * The body and the boundary in their relaxed-canonical form: a relaxed
   * signature lets whitespace runs, trailing whitespace and trailing empty
   * lines change, so the parts are found in a form those edits cannot move.
   */
  const boundary = relaxedBody(top.contentType.params.get("boundary") ?? "");
  if (boundary === "" || boundary.length > MAX_BOUNDARY_LENGTH) return null;

  let feedback: HeaderField[] | null = null;
  let embeddedMessageId: string | null = null;

  for (const part of splitParts(relaxedBody(top.body), boundary)) {
    const { headers, body } = splitHeaderSection(part);
    const partFields = parseFields(headers);
    const partType = parseContentType(firstField(partFields, "content-type")).type;
    const encoding = firstField(partFields, "content-transfer-encoding");

    if (partType === "message/feedback-report" && feedback === null) {
      feedback = parseFields(decodePart(body, encoding, MAX_HEADER_BYTES));
    } else if (
      (partType === "message/rfc822" || partType === "text/rfc822-headers") &&
      embeddedMessageId === null
    ) {
      const embedded = splitHeaderSection(decodePart(body, encoding, MAX_HEADER_BYTES));
      embeddedMessageId = cleanMessageId(
        firstField(parseFields(embedded.headers), "message-id"),
      );
    }
  }

  if (feedback === null) return null;

  const feedbackType = firstNonEmpty(feedback, "feedback-type")
    ?.toLowerCase()
    .slice(0, MAX_FEEDBACK_TYPE_LENGTH);
  const originalRcptTo: string[] = [];
  for (const field of feedback) {
    if (field.name !== "original-rcpt-to") continue;
    const address = cleanAddress(field.value);
    if (address !== null) originalRcptTo.push(address);
    if (originalRcptTo.length >= MAX_RCPT_TO) break;
  }

  return {
    feedbackType: feedbackType ?? null,
    userAgent: firstNonEmpty(feedback, "user-agent"),
    version: firstNonEmpty(feedback, "version"),
    originalMailFrom: cleanAddress(firstField(feedback, "original-mail-from")),
    originalRcptTo,
    arrivalDate: parseDate(
      firstNonEmpty(feedback, "arrival-date") ?? firstNonEmpty(feedback, "received-date"),
    ),
    reportedDomain: firstNonEmpty(feedback, "reported-domain")?.toLowerCase() ?? null,
    sourceIp: firstNonEmpty(feedback, "source-ip"),
    originalMessageId:
      cleanMessageId(firstField(feedback, "original-message-id")) ?? embeddedMessageId,
    reporterDomain: cleanAddress(firstField(top.fields, "from"))?.split("@")[1] ?? null,
    reporterAddress: singleMailbox(top.fields),
  };
}
