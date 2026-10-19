import { fileTypeFromBuffer, type FileTypeResult } from "file-type";
import { codePointLength } from "./from-name.ts";
import {
  AttachmentTypeNotAllowedError,
  AttachmentsTooLargeError,
  InvalidAttachmentError,
  TooManyAttachmentsError,
} from "../errors.ts";

/**
 * Rules for attachments on a send (#181), shared by the REST send API and
 * SMTP submission (both reach them through `createEmail`):
 *
 * - at most {@link MAX_ATTACHMENTS} files, together at most the configured
 *   `ATTACHMENTS_MAX_TOTAL_MB` once decoded (one file may use it all);
 * - a filename is 1 to {@link MAX_FILENAME_LENGTH} characters after
 *   trimming, with no control, line-separator or bidi-control character,
 *   no lone surrogate, no `/` or `\`, and not only dots;
 * - a `contentId` (for inline `cid:` images) is 1 to
 *   {@link MAX_CONTENT_ID_LENGTH} characters of a msg-id style token;
 * - REST content is standard, padded base64, decoded strictly;
 * - executables, scripts and installers are refused by their extension
 *   ({@link BLOCKED_EXTENSIONS}, the last one of the name, case-insensitive)
 *   and by their sniffed content (`file-type` on the bytes, see
 *   {@link BLOCKED_SNIFFED_TYPES}), so a PE file named `invoice.pdf` is
 *   still refused;
 * - the Content-Type sent is never the declared one: the sniffed type
 *   when the bytes are recognised, else a type from a short map of text
 *   extensions, else `application/octet-stream`.
 *
 * Refusals throw `EmailSendRejectedError` subclasses whose messages name
 * the attachment by its index, never by its name or content: filenames
 * may carry personal data. No I/O apart from the sniff, no logging.
 */

/** Most attachments one email may carry. */
export const MAX_ATTACHMENTS = 10;

/** Longest filename, in characters (code points), after trimming. */
export const MAX_FILENAME_LENGTH = 255;

/** Longest `contentId`, in characters. */
export const MAX_CONTENT_ID_LENGTH = 128;

/**
 * A raw filename longer than this (UTF-16 code units) is refused before
 * it is trimmed or scanned: it cannot be a valid name.
 */
const MAX_RAW_FILENAME_LENGTH = 1024;

/** A valid `contentId`: a msg-id style token, local part and optional domain. */
const CONTENT_ID_PATTERN = /^[A-Za-z0-9._%+-]+(?:@[A-Za-z0-9.-]+)?$/;

/** Characters a filename must not contain: controls, line separators, bidi controls. */
const FORBIDDEN_FILENAME_CHARS =
  /[\p{Cc}\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

/** Path separators: a filename names a file, never a path. */
const PATH_SEPARATORS = /[/\\]/;

/**
 * Extensions refused whatever the content (lowercase, without the dot):
 * Windows executables, scripts, installers, shortcuts and disk images,
 * plus shell scripts. Checked on the last extension of the name, so
 * `invoice.pdf.exe` is refused and `report.exe.pdf` is not.
 */
export const BLOCKED_EXTENSIONS: ReadonlySet<string> = new Set([
  "exe",
  "com",
  "bat",
  "cmd",
  "scr",
  "pif",
  "cpl",
  "msi",
  "msp",
  "mst",
  "dll",
  "sys",
  "vbs",
  "vbe",
  "js",
  "jse",
  "ws",
  "wsf",
  "wsc",
  "wsh",
  "ps1",
  "ps1xml",
  "ps2",
  "psc1",
  "psc2",
  "msc",
  "jar",
  "lnk",
  "inf",
  "reg",
  "hta",
  "app",
  "gadget",
  "application",
  "iso",
  "img",
  "vhd",
  "vhdx",
  "appx",
  "appxbundle",
  "msix",
  "sh",
  "bash",
  "command",
  "scf",
  "url",
]);

/**
 * `file-type` results refused whatever the name (its `ext` values):
 * native executables (Windows PE, ELF, Mach-O), Java classes and
 * archives, Windows cabinets, Android, Debian and RPM packages, browser
 * extensions, shortcuts and aliases, registry files, compiled HTML help,
 * Flash and WebAssembly, macOS and ISO disk images. Windows Installer
 * files (MSI, MSP, MST) are compound files that `file-type` reports as
 * `cfb`, like old Office documents: they are told apart by their root
 * storage class id ({@link windowsInstallerKind}).
 */
export const BLOCKED_SNIFFED_TYPES: ReadonlySet<string> = new Set([
  "exe",
  "elf",
  "macho",
  "class",
  "jar",
  "cab",
  "apk",
  "deb",
  "rpm",
  "crx",
  "xpi",
  "lnk",
  "alias",
  "reg",
  "chm",
  "swf",
  "wasm",
  "dmg",
  "iso",
]);

/**
 * Content-Types for text formats `file-type` cannot recognise (they have
 * no magic number), by extension. Only formats a mail client shows as
 * text or imports as data: anything else unrecognised goes out as
 * `application/octet-stream`. HTML and SVG are deliberately absent: they
 * can carry script.
 */
const TEXT_TYPES_BY_EXTENSION: ReadonlyMap<string, string> = new Map([
  ["txt", "text/plain"],
  ["log", "text/plain"],
  ["csv", "text/csv"],
  ["tsv", "text/tab-separated-values"],
  ["md", "text/markdown"],
  ["ics", "text/calendar"],
  ["vcf", "text/vcard"],
  ["json", "application/json"],
  ["xml", "application/xml"],
]);

/** What every attachment the sniff and the map do not type is sent as. */
export const FALLBACK_CONTENT_TYPE = "application/octet-stream";

/** One attachment as a send carries it, before the rules. */
export interface AttachmentInput {
  filename: string;
  /** Standard base64 (REST send) or the raw bytes (SMTP submission). */
  content: string | Uint8Array;
  /** The declared type: accepted for compatibility, never trusted or used. */
  contentType?: string;
  /** Content-ID for inline `cid:` references, without angle brackets. */
  contentId?: string;
}

/** An attachment that passed every rule, ready to store. */
export interface PreparedAttachment {
  /** 0-based index in the send's list. */
  position: number;
  filename: string;
  /** Derived, never declared (see {@link deriveContentType}). */
  contentType: string;
  contentId: string | null;
  sizeBytes: number;
  /** Hex SHA-256 of the content: dedup and debugging, not security. */
  sha256: string;
  content: Uint8Array;
}

/** Why a filename was refused. */
export type FilenameProblem =
  "empty" | "too_long" | "forbidden_character" | "path_separator" | "only_dots";

/** Why an attachment's input was refused (the 422 `VALIDATION_ERROR` kind). */
export type AttachmentProblem = FilenameProblem | "invalid_content_id" | "invalid_base64";

/** Checks a filename and returns it trimmed, or the rule it breaks. */
export function checkAttachmentFilename(
  raw: string,
): { ok: true; filename: string } | { ok: false; problem: FilenameProblem } {
  if (raw.length > MAX_RAW_FILENAME_LENGTH) return { ok: false, problem: "too_long" };
  const filename = raw.trim();
  if (filename === "") return { ok: false, problem: "empty" };
  if (FORBIDDEN_FILENAME_CHARS.test(filename) || !filename.isWellFormed()) {
    return { ok: false, problem: "forbidden_character" };
  }
  if (PATH_SEPARATORS.test(filename)) return { ok: false, problem: "path_separator" };
  if (/^\.+$/.test(filename)) return { ok: false, problem: "only_dots" };
  /** Code points, not UTF-16 units: an emoji counts once. */
  if (codePointLength(filename) > MAX_FILENAME_LENGTH) {
    return { ok: false, problem: "too_long" };
  }
  return { ok: true, filename };
}

/** Whether `value` is a valid `contentId`. */
export function isValidContentId(value: string): boolean {
  return value.length <= MAX_CONTENT_ID_LENGTH && CONTENT_ID_PATTERN.test(value);
}

/**
 * The bytes of standard, padded base64, or `null` when `value` is not
 * exactly that: any other character (whitespace and line breaks
 * included), the URL-safe alphabet, missing or misplaced padding, or
 * non-zero padding bits. Decoding is lenient, so the check is a
 * round-trip: only the canonical encoding of the bytes is accepted.
 */
export function decodeStrictBase64(value: string): Uint8Array | null {
  if (value.length % 4 !== 0) return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

/**
 * The decoded size of base64 of this length, assuming it is valid: used
 * to refuse an oversized send before decoding it.
 */
export function decodedBase64Length(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(value.length / 4) * 3 - padding);
}

/**
 * The lowercase last extension of a filename, ignoring trailing dots and
 * spaces (Windows drops them, so `evil.exe.` opens as `evil.exe`), or
 * `null` when it has none.
 */
export function lastExtension(filename: string): string | null {
  const name = filename.replace(/[. ]+$/, "");
  const dot = name.lastIndexOf(".");
  /** A leading dot counts: Windows runs `.exe` as an executable. */
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** Whether the filename's last extension is a blocked one. */
export function hasBlockedExtension(filename: string): boolean {
  const ext = lastExtension(filename);
  return ext !== null && BLOCKED_EXTENSIONS.has(ext);
}

/** The compound-file signature (`D0 CF 11 E0 A1 B1 1A E1`). */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

/**
 * Bytes 4 to 15 of the Windows Installer class ids
 * `{000C108x-0000-0000-C000-000000000046}` as stored (little-endian
 * fields); byte 0 is `0x84` for a package (MSI), `0x86` for a patch (MSP)
 * and `0x82` for a transform (MST).
 */
const MSI_CLSID_TAIL = [
  0x10, 0x0c, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x46,
];
const MSI_CLSID_FIRST: ReadonlyMap<number, string> = new Map([
  [0x84, "msi"],
  [0x86, "msp"],
  [0x82, "mst"],
]);

/**
 * `msi`, `msp` or `mst` when the bytes are a compound file whose root
 * storage carries a Windows Installer class id, else `null`. Reads the
 * header (sector size, first directory sector) and the root directory
 * entry's class id at offset 80, with every offset bounds-checked.
 */
export function windowsInstallerKind(bytes: Uint8Array): string | null {
  if (bytes.length < 512) return null;
  if (!CFB_SIGNATURE.every((b, i) => bytes[i] === b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorShift = view.getUint16(30, true);
  if (sectorShift !== 9 && sectorShift !== 12) return null;
  const firstDirSector = view.getUint32(48, true);
  /** Sector `n` starts after the header, which takes one sector. */
  const rootEntry = (firstDirSector + 1) * 2 ** sectorShift;
  const clsid = rootEntry + 80;
  if (!Number.isSafeInteger(clsid) || clsid + 16 > bytes.length) return null;
  const kind = MSI_CLSID_FIRST.get(bytes[clsid] ?? -1);
  if (kind === undefined) return null;
  return MSI_CLSID_TAIL.every((b, i) => bytes[clsid + 1 + i] === b) ? kind : null;
}

/**
 * The type `file-type` recognises in the bytes, or `undefined`. A sniff
 * that throws (a malformed container) is reported as `"unreadable"`:
 * the caller refuses the file rather than send what it could not check.
 */
export async function sniffContent(
  bytes: Uint8Array,
): Promise<FileTypeResult | "unreadable" | undefined> {
  try {
    return await fileTypeFromBuffer(bytes);
  } catch {
    return "unreadable";
  }
}

/**
 * Whether sniffed bytes are refused: a {@link BLOCKED_SNIFFED_TYPES} type,
 * a Windows Installer file, or content the sniff could not read.
 */
export function isBlockedContent(
  bytes: Uint8Array,
  sniffed: FileTypeResult | "unreadable" | undefined,
): boolean {
  if (sniffed === "unreadable") return true;
  if (sniffed === undefined) return false;
  if (BLOCKED_SNIFFED_TYPES.has(sniffed.ext)) return true;
  return sniffed.ext === "cfb" && windowsInstallerKind(bytes) !== null;
}

/**
 * The Content-Type an attachment is sent and stored with, never the
 * declared one: the sniffed type when `file-type` recognised the bytes,
 * else the text type of the extension ({@link TEXT_TYPES_BY_EXTENSION}),
 * else `application/octet-stream`.
 */
export function deriveContentType(
  filename: string,
  sniffed: FileTypeResult | undefined,
): string {
  if (sniffed !== undefined) return sniffed.mime;
  const ext = lastExtension(filename);
  return (
    (ext === null ? undefined : TEXT_TYPES_BY_EXTENSION.get(ext)) ?? FALLBACK_CONTENT_TYPE
  );
}

/** Caller-facing message for an attachment refused on its input. */
function describeAttachmentProblem(index: number, problem: AttachmentProblem): string {
  const which = `Attachment ${index}`;
  switch (problem) {
    case "empty":
      return `${which}: filename is required.`;
    case "too_long":
      return `${which}: filename must be at most ${MAX_FILENAME_LENGTH} characters.`;
    case "forbidden_character":
      return `${which}: filename must not contain control or bidi-control characters.`;
    case "path_separator":
      return `${which}: filename must not contain / or \\.`;
    case "only_dots":
      return `${which}: filename must not be only dots.`;
    case "invalid_content_id":
      return `${which}: contentId must be 1 to ${MAX_CONTENT_ID_LENGTH} characters of A-Z a-z 0-9 . _ % + -, optionally followed by @ and a domain.`;
    case "invalid_base64":
      return `${which}: content must be standard base64 (A-Z a-z 0-9 + /, padded with =, no whitespace).`;
  }
}

/** The 422 for an attachment refused on its input, at `/attachments/<index>/<field>`. */
function invalid(
  index: number,
  field: "filename" | "contentId" | "content",
  problem: AttachmentProblem,
): InvalidAttachmentError {
  return new InvalidAttachmentError(
    problem,
    `/attachments/${index}/${field}`,
    describeAttachmentProblem(index, problem),
  );
}

/** The size an input will have once decoded (exact for bytes, from the length for base64). */
function declaredSize(content: string | Uint8Array): number {
  return typeof content === "string" ? decodedBase64Length(content) : content.byteLength;
}

/**
 * Applies every rule to a send's attachments and returns them ready to
 * store, in order, or throws the first refusal:
 *
 * 1. more than {@link MAX_ATTACHMENTS}: `TooManyAttachmentsError`;
 * 2. per file, a bad filename or contentId: `InvalidAttachmentError`, a
 *    blocked extension: `AttachmentTypeNotAllowedError`;
 * 3. the total size, from the base64 length before anything is decoded,
 *    then exactly: `AttachmentsTooLargeError`;
 * 4. per file, content that is not strict base64: `InvalidAttachmentError`;
 * 5. per file, blocked sniffed content: `AttachmentTypeNotAllowedError`.
 */
export async function prepareAttachments(
  inputs: readonly AttachmentInput[],
  maxTotalBytes: number,
): Promise<PreparedAttachment[]> {
  if (inputs.length > MAX_ATTACHMENTS) throw new TooManyAttachmentsError(MAX_ATTACHMENTS);

  const named = inputs.map((input, index) => {
    const checked = checkAttachmentFilename(input.filename);
    if (!checked.ok) throw invalid(index, "filename", checked.problem);
    if (input.contentId !== undefined && !isValidContentId(input.contentId)) {
      throw invalid(index, "contentId", "invalid_content_id");
    }
    if (hasBlockedExtension(checked.filename)) {
      throw new AttachmentTypeNotAllowedError(index, "extension");
    }
    return { input, filename: checked.filename };
  });

  const declaredTotal = inputs.reduce(
    (sum, input) => sum + declaredSize(input.content),
    0,
  );
  if (declaredTotal > maxTotalBytes) throw new AttachmentsTooLargeError(maxTotalBytes);

  const decoded = named.map(({ input, filename }, index) => {
    const content =
      typeof input.content === "string"
        ? decodeStrictBase64(input.content)
        : input.content;
    if (content === null) throw invalid(index, "content", "invalid_base64");
    return { input, filename, content };
  });

  const total = decoded.reduce((sum, { content }) => sum + content.byteLength, 0);
  if (total > maxTotalBytes) throw new AttachmentsTooLargeError(maxTotalBytes);

  const prepared: PreparedAttachment[] = [];
  for (const [index, { input, filename, content }] of decoded.entries()) {
    const sniffed = await sniffContent(content);
    if (isBlockedContent(content, sniffed)) {
      throw new AttachmentTypeNotAllowedError(index, "content");
    }
    prepared.push({
      position: index,
      filename,
      contentType: deriveContentType(
        filename,
        sniffed === "unreadable" ? undefined : sniffed,
      ),
      contentId: input.contentId ?? null,
      sizeBytes: content.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
      content,
    });
  }
  return prepared;
}

/**
 * RFC 5987 `ext-value` encoding of a filename (UTF-8, percent-encoded):
 * every byte outside `attr-char` is escaped, so the result is plain
 * ASCII with no quote, semicolon, space or line break. The filename rules
 * refuse lone surrogates, so `encodeURIComponent` cannot throw.
 */
export function rfc5987Encode(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `Content-Disposition` of a download: always an attachment, the name RFC 5987 encoded. */
export function attachmentContentDisposition(filename: string): string {
  return `attachment; filename*=UTF-8''${rfc5987Encode(filename)}`;
}
