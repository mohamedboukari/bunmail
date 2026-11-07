import { createHash, createPrivateKey, sign, type KeyObject } from "crypto";
import { domainToASCII } from "url";
import type { HeaderField } from "../../inbound/types/dkim.types.ts";
import { splitMessage } from "../../inbound/services/dkim-verifier-parse.service.ts";
import {
  canonicalBody,
  signedHeaderData,
} from "../../inbound/services/dkim-verifier-canonical.service.ts";
import type { DkimOptions } from "./mailer-message.service.ts";

/**
 * BunMail's own DKIM signer (RFC 6376, #345): relaxed/relaxed, rsa-sha256
 * or ed25519-sha256 (RFC 8463) by the key's type, with the over-signed
 * header set below. Nodemailer's signer cannot over-sign: it lists each
 * field once and only when present, so a second `From:` added in transit
 * still verified under it.
 *
 * The canonicalization and the header selection are the verifier's own
 * (`inbound/services/dkim-verifier-*.service.ts`, #373), imported across
 * modules rather than moved to `src/utils/`: two modules use them, below
 * the three-module rule for a shared helper. One implementation means the
 * signer and the verifier cannot drift apart; the unit tests also check the
 * output with an implementation written apart from both.
 */

/**
 * Header fields the signature covers, in `h=` order: nodemailer's former
 * default list, plus `List-Unsubscribe-Post` (RFC 8058 requires it signed
 * for one-click unsubscribe, which Gmail and Yahoo rely on, #241),
 * `Feedback-ID`, `Content-Disposition` and `Auto-Submitted` (#345), and
 * the TLS report fields `TLS-Report-Domain` and `TLS-Report-Submitter`
 * (RFC 8460 section 5.3, #345). Each field present is signed once per
 * instance; a field absent is not listed, unless it is over-signed.
 */
export const DKIM_SIGNED_HEADERS: readonly string[] = [
  "From",
  "Sender",
  "Reply-To",
  "Subject",
  "Date",
  "Message-ID",
  "To",
  "Cc",
  "MIME-Version",
  "Content-Type",
  "Content-Transfer-Encoding",
  "Content-ID",
  "Content-Description",
  "Resent-Date",
  "Resent-From",
  "Resent-Sender",
  "Resent-To",
  "Resent-Cc",
  "Resent-Message-ID",
  "In-Reply-To",
  "References",
  "List-Id",
  "List-Help",
  "List-Unsubscribe",
  "List-Unsubscribe-Post",
  "List-Subscribe",
  "List-Post",
  "List-Owner",
  "List-Archive",
  "Feedback-ID",
  "Content-Disposition",
  "Auto-Submitted",
  "TLS-Report-Domain",
  "TLS-Report-Submitter",
];

/**
 * Header fields listed in `h=` once more than they occur (RFC 6376 sections
 * 5.4.2 and 8.15), present or not: the extra entry selects no field, so the
 * signature also covers the absence of any further instance, and a field of
 * this set added after signing (above or below the original) breaks it.
 *
 * The set is what a reader sees or what decides how the message is read:
 * the originator and reply addresses (`From`, `Sender`, `Reply-To`; a second
 * `From` is the classic display spoof), the recipients (`To`, `Cc`), the
 * `Subject`, `Date` and `Message-ID`, the threading headers (`In-Reply-To`,
 * `References`: which conversation a client files the message in), the MIME
 * structure (`MIME-Version`, `Content-Type`, `Content-Transfer-Encoding`:
 * a second one can make a client decode another body) and the unsubscribe
 * pair (`List-Unsubscribe`, `List-Unsubscribe-Post`: an added one-click URL
 * would point the client's unsubscribe button somewhere else),
 * `Content-Disposition` (an added one on a single-part message can turn its
 * body into an attachment, or the reverse), `Auto-Submitted` (an added one
 * marks the message automatic, so auto-responders and some filters treat it
 * differently, and a second one on BunMail's own mail would contradict the
 * first), and `Feedback-ID` (a second one would charge complaints to another
 * sender in the provider's feedback loop).
 *
 * Not over-signed: the `Resent-*` fields, which a legitimate resend adds,
 * the other `List-*` fields, which a mailing list adds when it redistributes
 * (a list that also rewrites the body breaks the signature anyway), and the
 * MIME part fields (`Content-ID`, `Content-Description`), which have no
 * meaning on the top-level header.
 */
export const DKIM_OVERSIGNED_HEADERS: ReadonlySet<string> = new Set([
  "from",
  "sender",
  "reply-to",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "feedback-id",
  "content-disposition",
  "auto-submitted",
]);

/**
 * A message BunMail refuses to sign: an invalid domain or selector, or a key
 * of another type than RSA or ed25519. Its message is fixed text, safe to log.
 */
export class DkimSignError extends Error {
  override name = "DkimSignError";
}

/** RFC 6376 section 3.5 sub-domain, lowercase. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";

/** `d=`: domain-name = sub-domain 1*("." sub-domain). */
const SIGNING_DOMAIN = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);

/** `s=`: selector = sub-domain *("." sub-domain). */
const SELECTOR = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** Header lines are folded before this length (RFC 5322 section 2.1.1 recommends 78). */
const FOLD_AT = 76;

/**
 * The `h=` list of a message (lowercase names): each name of
 * {@link DKIM_SIGNED_HEADERS} once per instance in the header, plus once
 * more when it is in {@link DKIM_OVERSIGNED_HEADERS}. Repeated names select
 * their instances bottom up (RFC 6376 section 5.4.2), so listing a name `n`
 * times signs its `n` instances, last first.
 */
export function signedHeaderNames(fields: readonly HeaderField[]): string[] {
  const counts = new Map<string, number>();
  for (const field of fields) counts.set(field.name, (counts.get(field.name) ?? 0) + 1);
  const names: string[] = [];
  for (const header of DKIM_SIGNED_HEADERS) {
    const name = header.toLowerCase();
    const listed = (counts.get(name) ?? 0) + (DKIM_OVERSIGNED_HEADERS.has(name) ? 1 : 0);
    for (let i = 0; i < listed; i += 1) names.push(name);
  }
  return names;
}

/**
 * The message as it goes on the wire, read as latin1 (one character per
 * byte): every bare CR and bare LF made CRLF, and a final CRLF. Nodemailer's
 * SMTP data stream would do both while sending; doing it before signing
 * means the signed bytes are the sent bytes.
 */
function wireText(message: Uint8Array): string {
  const text = Buffer.from(message.buffer, message.byteOffset, message.byteLength)
    .toString("latin1")
    .replace(/\r\n|\r|\n/g, "\r\n");
  return text.endsWith("\r\n") ? text : `${text}\r\n`;
}

/** The signing algorithm of a private key; any other type than RSA or ed25519 is refused. */
function algorithmOf(key: KeyObject): "rsa-sha256" | "ed25519-sha256" {
  if (key.asymmetricKeyType === "rsa") return "rsa-sha256";
  if (key.asymmetricKeyType === "ed25519") return "ed25519-sha256";
  throw new DkimSignError(
    `Unsupported DKIM key type: ${key.asymmetricKeyType ?? "unknown"}`,
  );
}

/**
 * Folds the tag list of a DKIM-Signature field: tags are separated by
 * `"; "`, and a line is broken before a tag, after a `:` of `h=`, or inside
 * the `b=` value, which comes last (FWS is allowed in all three places,
 * RFC 6376 section 3.5). Returns the field text, without a final CRLF.
 */
function foldSignature(tags: readonly string[]): string {
  const lines: string[] = [];
  let line = "DKIM-Signature:";
  /** Appends a piece, after a space or not, breaking the line first when it would be too long. */
  const append = (piece: string, spaced: boolean): void => {
    if (line.length + (spaced ? 1 : 0) + piece.length > FOLD_AT && line.trim() !== "") {
      lines.push(line);
      line = ` ${piece}`;
      return;
    }
    line += spaced ? ` ${piece}` : piece;
  };
  /** Appends a base64 value that may be broken anywhere, in chunks that fill each line. */
  const appendBase64 = (value: string): void => {
    let rest = value;
    while (rest !== "") {
      const room = FOLD_AT - line.length;
      if (room <= 0) {
        lines.push(line);
        line = " ";
        continue;
      }
      line += rest.slice(0, room);
      rest = rest.slice(room);
    }
  };
  tags.forEach((tag, index) => {
    const last = index === tags.length - 1;
    const eq = tag.indexOf("=");
    const name = tag.slice(0, eq);
    const value = tag.slice(eq + 1);
    if (name === "h") {
      /** Each entry carries its trailing `:`, so a line breaks after the colon. */
      const entries = value.split(":");
      entries.forEach((entry, i) => {
        const end = i < entries.length - 1 ? ":" : last ? "" : ";";
        append(`${i === 0 ? "h=" : ""}${entry}${end}`, i === 0);
      });
    } else if (name === "b") {
      append("b=", true);
      appendBase64(value);
    } else {
      append(`${tag}${last ? "" : ";"}`, true);
    }
  });
  lines.push(line);
  return lines.join("\r\n");
}

/**
 * Signs a message with a domain's DKIM key and returns it with the
 * `DKIM-Signature` field on top, as the exact bytes to send (line ends made
 * CRLF, see {@link wireText}). Tags, in nodemailer's former order: `v=1`,
 * `a=` (`rsa-sha256`, or `ed25519-sha256` for an ed25519 key), `c=relaxed/relaxed`,
 * `d=` (as an A-label), `q=dns/txt`, `s=`, `bh=`, `h=` ({@link signedHeaderNames})
 * and `b=`. No `t=` or `x=`, as before.
 *
 * Throws a {@link DkimSignError} when the key is of another type or the
 * domain or selector is not a valid DNS name, and `node:crypto`'s error when
 * the key cannot be read; the caller decides what an unsigned message means.
 * No error carries the key.
 */
export function dkimSignMessage(message: Uint8Array, dkim: DkimOptions): Buffer {
  /**
   * A domain stored before #406 was kept as entered, trimmed and
   * lowercased, so `example.com.` is possible: one final dot is dropped, as
   * it names the same domain and `d=` takes none.
   */
  const domain = domainToASCII(dkim.domainName.trim().replace(/\.$/, "")).toLowerCase();
  if (!SIGNING_DOMAIN.test(domain))
    throw new DkimSignError("Invalid DKIM signing domain");
  const selector = dkim.keySelector.trim().toLowerCase();
  if (!SELECTOR.test(selector)) throw new DkimSignError("Invalid DKIM selector");
  const key = createPrivateKey(dkim.privateKey);
  const algorithm = algorithmOf(key);

  const text = wireText(message);
  const { fields, body } = splitMessage(Buffer.from(text, "latin1"));
  const bodyHash = createHash("sha256")
    .update(canonicalBody(body, "relaxed"), "latin1")
    .digest("base64");
  const names = signedHeaderNames(fields);

  const tags = [
    "v=1",
    `a=${algorithm}`,
    "c=relaxed/relaxed",
    `d=${domain}`,
    "q=dns/txt",
    `s=${selector}`,
    `bh=${bodyHash}`,
    `h=${names.join(":")}`,
  ];
  /** The field with an empty `b=`: what the signature itself covers (RFC 6376 section 3.7). */
  const unsigned = foldSignature([...tags, "b="]);
  const data = signedHeaderData(
    fields,
    { name: "dkim-signature", raw: unsigned },
    { headerCanon: "relaxed", signedHeaders: names },
  );
  const signature =
    algorithm === "ed25519-sha256"
      ? sign(null, createHash("sha256").update(data).digest(), key)
      : sign("sha256", data, key);
  const field = foldSignature([...tags, `b=${signature.toString("base64")}`]);
  return Buffer.from(`${field}\r\n${text}`, "latin1");
}
