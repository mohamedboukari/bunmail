import { describe, test, expect } from "bun:test";
import { zipSync } from "fflate";
import {
  BLOCKED_EXTENSIONS,
  FALLBACK_CONTENT_TYPE,
  MAX_ATTACHMENTS,
  attachmentContentDisposition,
  checkAttachmentFilename,
  decodeStrictBase64,
  decodedBase64Length,
  deriveContentType,
  hasBlockedExtension,
  isValidContentId,
  lastExtension,
  prepareAttachments,
  rfc5987Encode,
  sniffContent,
  windowsInstallerKind,
  type AttachmentInput,
} from "../../src/modules/emails/services/attachments.ts";
import {
  AttachmentTypeNotAllowedError,
  AttachmentsTooLargeError,
  InvalidAttachmentError,
  TooManyAttachmentsError,
} from "../../src/modules/emails/errors.ts";
import {
  BYTES_PER_MB,
  DEFAULT_ATTACHMENTS_MAX_TOTAL_MB,
  MAX_ATTACHMENTS_MAX_TOTAL_MB,
  base64Length,
  maxRequestBodyBytesFor,
  readAttachmentsMaxTotalMb,
} from "../../src/config.ts";
import { MAX_ATTACHMENT_BASE64_LENGTH } from "../../src/modules/emails/dtos/send-email.dto.ts";
import { submissionMaxMessageBytes } from "../../src/modules/smtp-submission/services/smtp-submission.service.ts";
import { submissionAttachments } from "../../src/modules/smtp-submission/message-mapper.ts";

/**
 * Attachment rules (#181): filenames, Content-IDs, strict base64, the
 * limits, the blocked extensions and sniffed types, the derived
 * Content-Type, the download's Content-Disposition, and the env var and
 * size limits around them. Real file headers stand in for real files:
 * `file-type` only reads the magic numbers.
 */

/** A character by its code point, so this file holds no invisible character. */
const ch = (code: number): string => String.fromCodePoint(code);

/** A buffer that starts with `head` and is padded with zeros to `size`. */
function headed(head: number[], size = 64): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set(head);
  return bytes;
}

/** Windows PE (`MZ`), ELF, Mach-O (64-bit, little-endian) and Java class headers. */
const PE = headed([0x4d, 0x5a, 0x90, 0x00, 0x03]);
const ELF = headed([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]);
const MACHO = headed([0xcf, 0xfa, 0xed, 0xfe, 0x07, 0x00, 0x00, 0x01]);
const JAVA_CLASS = headed([0xca, 0xfe, 0xba, 0xbe, 0x00, 0x00, 0x00, 0x34]);

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** The start of a PDF. */
const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

/**
 * A minimal compound file whose root directory entry carries `clsidFirst`
 * as the first byte of a Windows Installer class id (`0x84`: MSI), or a
 * plain class id when `null` (an old Office document is a compound file
 * too).
 */
function compoundFile(clsidFirst: number | null): Uint8Array {
  const bytes = new Uint8Array(1024);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const view = new DataView(bytes.buffer);
  view.setUint16(30, 9, true);
  view.setUint32(48, 0, true);
  if (clsidFirst !== null) {
    bytes.set(
      [
        clsidFirst,
        0x10,
        0x0c,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0xc0,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x00,
        0x46,
      ],
      512 + 80,
    );
  }
  return bytes;
}

/** An input with base64 content. */
function b64(filename: string, bytes: Uint8Array, extra: Partial<AttachmentInput> = {}) {
  return { filename, content: Buffer.from(bytes).toString("base64"), ...extra };
}

/** The error a promise rejects with. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    return error;
  }
  throw new Error("expected a rejection");
}

const MB = 1_000_000;

describe("checkAttachmentFilename", () => {
  test("trims and accepts a normal name, in any script", () => {
    expect(checkAttachmentFilename("  report.pdf ")).toEqual({
      ok: true,
      filename: "report.pdf",
    });
    expect(checkAttachmentFilename(`r${ch(0xe9)}sum${ch(0xe9)}.pdf`).ok).toBe(true);
  });

  test("1 to 255 characters, counted in code points", () => {
    expect(checkAttachmentFilename("a".repeat(255)).ok).toBe(true);
    expect(checkAttachmentFilename("a".repeat(256))).toEqual({
      ok: false,
      problem: "too_long",
    });
    /** 255 emoji are 510 UTF-16 units but 255 characters. */
    expect(checkAttachmentFilename(ch(0x1f600).repeat(255)).ok).toBe(true);
    expect(checkAttachmentFilename("")).toEqual({ ok: false, problem: "empty" });
    expect(checkAttachmentFilename("   ")).toEqual({ ok: false, problem: "empty" });
  });

  test.each([
    ["NUL", `a${ch(0)}.pdf`],
    ["CR", `a${ch(13)}.pdf`],
    ["LF", `a${ch(10)}.pdf`],
    ["tab", `a${ch(9)}.pdf`],
    ["DEL", `a${ch(0x7f)}.pdf`],
    ["C1", `a${ch(0x85)}.pdf`],
    ["line separator", `a${ch(0x2028)}.pdf`],
    ["right-to-left override", `invoice${ch(0x202e)}fdp.exe`],
    ["right-to-left isolate", `a${ch(0x2067)}.pdf`],
    ["right-to-left mark", `a${ch(0x200f)}.pdf`],
    ["arabic letter mark", `a${ch(0x61c)}.pdf`],
    ["lone surrogate", `a${String.fromCharCode(0xd800)}.pdf`],
  ])("refuses a %s", (_label, name) => {
    expect(checkAttachmentFilename(name)).toEqual({
      ok: false,
      problem: "forbidden_character",
    });
  });

  test("refuses path separators and names that are only dots", () => {
    expect(checkAttachmentFilename("../etc/passwd")).toEqual({
      ok: false,
      problem: "path_separator",
    });
    expect(checkAttachmentFilename("C:\\Users\\a.pdf")).toEqual({
      ok: false,
      problem: "path_separator",
    });
    for (const name of [".", "..", "...", " .. "]) {
      expect(checkAttachmentFilename(name)).toEqual({ ok: false, problem: "only_dots" });
    }
    expect(checkAttachmentFilename(".env").ok).toBe(true);
  });
});

describe("isValidContentId", () => {
  test.each(["logo", "logo@example.com", "part1.ABC%2B_x-y@mail.example.org", "a"])(
    "accepts %p",
    (cid) => {
      expect(isValidContentId(cid)).toBe(true);
    },
  );

  test.each([
    "",
    "<logo>",
    "a b",
    "a@b@c",
    "logo@",
    "@example.com",
    'a"b',
    "x".repeat(129),
  ])("refuses %p", (cid) => {
    expect(isValidContentId(cid)).toBe(false);
  });

  test("128 characters are allowed", () => {
    expect(isValidContentId("x".repeat(128))).toBe(true);
  });
});

describe("decodeStrictBase64", () => {
  test("decodes standard padded base64", () => {
    expect(Buffer.from(decodeStrictBase64("aGVsbG8=") ?? []).toString()).toBe("hello");
    expect(Buffer.from(decodeStrictBase64("aGk=") ?? []).toString()).toBe("hi");
    expect(decodeStrictBase64("")?.byteLength).toBe(0);
  });

  test.each([
    ["missing padding", "aGVsbG8"],
    ["a space", "aGVs bG8="],
    ["a line break", "aGVsbG8=\n"],
    ["a CRLF in the middle", "aGVs\r\nbG8="],
    ["the URL-safe alphabet", "-_-_"],
    ["non-zero padding bits", "aGVsbG9="],
    ["padding in the middle", "aG=sbG8="],
    ["a non-base64 character", "aGVsbG8!"],
    ["too much padding", "aGVsbA==="],
  ])("refuses %s", (_label, value) => {
    expect(decodeStrictBase64(value)).toBeNull();
  });

  test("decodedBase64Length matches the decoded size of valid base64", () => {
    for (const size of [0, 1, 2, 3, 4, 5, 1000]) {
      const value = Buffer.alloc(size, 7).toString("base64");
      expect(decodedBase64Length(value)).toBe(size);
    }
  });
});

describe("blocked extensions", () => {
  test.each([
    "invoice.exe",
    "INVOICE.EXE",
    "invoice.pdf.exe",
    "report.Pdf.Scr",
    "setup.MSI",
    "x.ps1",
    "x.js",
    "x.url",
    "x.lnk",
    "disk.iso",
    "run.sh",
    "evil.exe.",
    "evil.exe . .",
    ".sh",
  ])("refuses %p", (name) => {
    expect(hasBlockedExtension(name)).toBe(true);
  });

  test.each([
    "report.pdf",
    "report.exe.pdf",
    "archive.zip",
    "noext",
    "photo.jpeg",
    "a.json",
  ])("allows %p", (name) => {
    expect(hasBlockedExtension(name)).toBe(false);
  });

  test("the list holds the documented extensions", () => {
    for (const ext of [
      "exe",
      "com",
      "bat",
      "cmd",
      "scr",
      "vbs",
      "jar",
      "hta",
      "msix",
      "scf",
    ]) {
      expect(BLOCKED_EXTENSIONS.has(ext)).toBe(true);
    }
    expect(BLOCKED_EXTENSIONS.size).toBe(46);
  });

  test("lastExtension takes the last one, lowercase", () => {
    expect(lastExtension("a.tar.GZ")).toBe("gz");
    expect(lastExtension("a.")).toBeNull();
    expect(lastExtension("a")).toBeNull();
  });
});

describe("sniffed content", () => {
  test("recognises executables from their headers", async () => {
    expect(await sniffContent(PE)).toEqual({
      ext: "exe",
      mime: "application/x-msdownload",
    });
    expect(await sniffContent(ELF)).toMatchObject({ ext: "elf" });
    expect(await sniffContent(MACHO)).toMatchObject({ ext: "macho" });
  });

  test("a compound file is a Windows Installer only with its class id", () => {
    expect(windowsInstallerKind(compoundFile(0x84))).toBe("msi");
    expect(windowsInstallerKind(compoundFile(0x86))).toBe("msp");
    expect(windowsInstallerKind(compoundFile(0x82))).toBe("mst");
    expect(windowsInstallerKind(compoundFile(null))).toBeNull();
    expect(windowsInstallerKind(PE)).toBeNull();
    /** A directory sector past the end is not read. */
    const truncated = compoundFile(0x84).slice(0, 600);
    expect(windowsInstallerKind(truncated)).toBeNull();
  });
});

describe("deriveContentType never trusts the declared type", () => {
  test("the sniffed type wins over the name", async () => {
    const png = await sniffContent(PNG);
    expect(png).toMatchObject({ mime: "image/png" });
    expect(deriveContentType("notes.txt", png === "unreadable" ? undefined : png)).toBe(
      "image/png",
    );
  });

  test("unrecognised bytes: a text type by extension, else octet-stream", () => {
    expect(deriveContentType("notes.TXT", undefined)).toBe("text/plain");
    expect(deriveContentType("data.csv", undefined)).toBe("text/csv");
    expect(deriveContentType("invite.ics", undefined)).toBe("text/calendar");
    expect(deriveContentType("page.html", undefined)).toBe(FALLBACK_CONTENT_TYPE);
    expect(deriveContentType("image.svg", undefined)).toBe(FALLBACK_CONTENT_TYPE);
    expect(deriveContentType("fake.pdf", undefined)).toBe(FALLBACK_CONTENT_TYPE);
    expect(deriveContentType("noext", undefined)).toBe(FALLBACK_CONTENT_TYPE);
  });

  test("prepareAttachments ignores contentType entirely", async () => {
    const [text, png, pdf] = await prepareAttachments(
      [
        b64("notes.txt", Buffer.from("plain words"), { contentType: "application/pdf" }),
        b64("logo.txt", PNG, { contentType: "text/html" }),
        b64("doc.pdf", PDF, { contentType: "image/png" }),
      ],
      5 * MB,
    );
    expect(text?.contentType).toBe("text/plain");
    expect(png?.contentType).toBe("image/png");
    expect(pdf?.contentType).toBe("application/pdf");
  });
});

describe("prepareAttachments", () => {
  test("returns the files in order, decoded, typed and hashed", async () => {
    const prepared = await prepareAttachments(
      [b64(" doc.pdf ", PDF), b64("logo.png", PNG, { contentId: "logo@example.com" })],
      5 * MB,
    );
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toMatchObject({
      position: 0,
      filename: "doc.pdf",
      contentType: "application/pdf",
      contentId: null,
      sizeBytes: PDF.byteLength,
      sha256: new Bun.CryptoHasher("sha256").update(PDF).digest("hex"),
    });
    expect(Buffer.from(prepared[0]!.content).equals(PDF)).toBe(true);
    expect(prepared[1]).toMatchObject({ position: 1, contentId: "logo@example.com" });
  });

  test("raw bytes (SMTP submission) skip the base64 step", async () => {
    const [only] = await prepareAttachments([{ filename: "doc.pdf", content: PDF }], MB);
    expect(only?.sizeBytes).toBe(PDF.byteLength);
  });

  test(`at most ${MAX_ATTACHMENTS} files`, async () => {
    const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) =>
      b64(`f${i}.txt`, Buffer.from("x")),
    );
    expect(await rejection(prepareAttachments(files, MB))).toBeInstanceOf(
      TooManyAttachmentsError,
    );
    expect(await prepareAttachments(files.slice(0, MAX_ATTACHMENTS), MB)).toHaveLength(
      MAX_ATTACHMENTS,
    );
  });

  test("the total, and so one file, is capped at the budget", async () => {
    const half = Buffer.alloc(600_000, 1);
    const error = await rejection(
      prepareAttachments([b64("a.txt", half), b64("b.txt", half)], MB),
    );
    expect(error).toBeInstanceOf(AttachmentsTooLargeError);
    expect(error instanceof AttachmentsTooLargeError && error.code).toBe(
      "ATTACHMENTS_TOO_LARGE",
    );
    expect(
      await rejection(prepareAttachments([b64("one.txt", Buffer.alloc(MB + 1))], MB)),
    ).toBeInstanceOf(AttachmentsTooLargeError);
    expect(await prepareAttachments([b64("one.txt", Buffer.alloc(MB))], MB)).toHaveLength(
      1,
    );
    expect(
      await rejection(
        prepareAttachments([{ filename: "r.txt", content: Buffer.alloc(MB + 1) }], MB),
      ),
    ).toBeInstanceOf(AttachmentsTooLargeError);
  });

  test("invalid base64 is a validation error at the content's path", async () => {
    const error = await rejection(
      prepareAttachments(
        [b64("ok.txt", Buffer.from("x")), { filename: "b.txt", content: "aGVsbG8" }],
        MB,
      ),
    );
    expect(error).toBeInstanceOf(InvalidAttachmentError);
    expect(error instanceof InvalidAttachmentError && error.path).toBe(
      "/attachments/1/content",
    );
    expect(error instanceof InvalidAttachmentError && error.code).toBe(
      "VALIDATION_ERROR",
    );
  });

  test("a bad filename or contentId names the field, never the value", async () => {
    const secret = "patient-jane-doe";
    const name = await rejection(
      prepareAttachments([{ filename: `${secret}/x.pdf`, content: "" }], MB),
    );
    expect(name instanceof InvalidAttachmentError && name.path).toBe(
      "/attachments/0/filename",
    );
    expect(name instanceof Error && name.message).not.toContain(secret);
    const cid = await rejection(
      prepareAttachments([{ filename: "a.png", content: "", contentId: "<a b>" }], MB),
    );
    expect(cid instanceof InvalidAttachmentError && cid.path).toBe(
      "/attachments/0/contentId",
    );
  });

  test("a blocked extension is refused by index, before decoding", async () => {
    const error = await rejection(
      prepareAttachments(
        [
          b64("a.txt", Buffer.from("x")),
          { filename: "invoice.pdf.exe", content: "not base64" },
        ],
        MB,
      ),
    );
    expect(error).toBeInstanceOf(AttachmentTypeNotAllowedError);
    expect(error instanceof AttachmentTypeNotAllowedError && error.index).toBe(1);
    expect(error instanceof AttachmentTypeNotAllowedError && error.reason).toBe(
      "extension",
    );
    expect(error instanceof Error && error.message).not.toContain("invoice");
  });

  test.each([
    ["a PE executable named invoice.pdf, declared application/pdf", PE],
    ["an ELF binary", ELF],
    ["a Mach-O binary", MACHO],
    ["a Java class", JAVA_CLASS],
    ["a Windows Installer package", compoundFile(0x84)],
  ])("refuses %s by its content", async (_label, bytes) => {
    const error = await rejection(
      prepareAttachments(
        [b64("invoice.pdf", bytes, { contentType: "application/pdf" })],
        MB,
      ),
    );
    expect(error).toBeInstanceOf(AttachmentTypeNotAllowedError);
    expect(error instanceof AttachmentTypeNotAllowedError && error.reason).toBe(
      "content",
    );
    expect(error instanceof AttachmentTypeNotAllowedError && error.code).toBe(
      "ATTACHMENT_TYPE_NOT_ALLOWED",
    );
  });

  test("archives and other compound files are allowed", async () => {
    const zip = zipSync({ "readme.txt": Buffer.from("hello") });
    const [archive, doc] = await prepareAttachments(
      [b64("bundle.zip", zip), b64("old.doc", compoundFile(null))],
      MB,
    );
    expect(archive?.contentType).toBe("application/zip");
    expect(doc?.contentType).toBe("application/x-cfb");
  });

  test("a zip holding a jar manifest is refused as a Java archive", async () => {
    const jar = zipSync({
      "META-INF/MANIFEST.MF": Buffer.from("Manifest-Version: 1.0\n"),
    });
    expect(await rejection(prepareAttachments([b64("lib.zip", jar)], MB))).toBeInstanceOf(
      AttachmentTypeNotAllowedError,
    );
  });
});

describe("download Content-Disposition (RFC 5987)", () => {
  test("percent-encodes everything outside attr-char", () => {
    expect(rfc5987Encode(`na${ch(0xef)}ve r${ch(0xe9)}sum${ch(0xe9)} (1).pdf`)).toBe(
      "na%C3%AFve%20r%C3%A9sum%C3%A9%20%281%29.pdf",
    );
    expect(rfc5987Encode(`it's*"x";y.txt`)).toBe("it%27s%2A%22x%22%3By.txt");
    expect(rfc5987Encode(ch(0x1f600))).toBe("%F0%9F%98%80");
  });

  test("is always an attachment, with only ASCII and no quote or separator", () => {
    const header = attachmentContentDisposition(`a "b"; c=d.pdf`);
    expect(header.startsWith("attachment; filename*=UTF-8''")).toBe(true);
    expect(header.slice("attachment; filename*=UTF-8''".length)).toMatch(
      /^[A-Za-z0-9%!#$&+\-.^_`|~]+$/,
    );
  });
});

describe("ATTACHMENTS_MAX_TOTAL_MB and the size limits", () => {
  test("unset or blank: the default", () => {
    expect(readAttachmentsMaxTotalMb(undefined)).toBe(DEFAULT_ATTACHMENTS_MAX_TOTAL_MB);
    expect(readAttachmentsMaxTotalMb("")).toBe(5);
  });

  test.each([
    ["1", 1],
    ["18", 18],
    [" 7 ", 7],
  ])("accepts %p", (raw, value) => {
    expect(readAttachmentsMaxTotalMb(raw)).toBe(value);
  });

  test.each(["0", "19", "-1", "1.5", "5MB", "abc", "1e1", "0x5"])("refuses %p", (raw) => {
    expect(() => readAttachmentsMaxTotalMb(raw)).toThrow(
      /ATTACHMENTS_MAX_TOTAL_MB must be a whole number from 1 to 18/,
    );
  });

  test("the HTTP body limit fits the base64 of the budget, and not much more", () => {
    for (const mb of [1, 5, 18]) {
      const limit = maxRequestBodyBytesFor(mb * BYTES_PER_MB);
      /** 5 MB of html, 5 MB of text and the base64 of the whole budget fit. */
      expect(limit).toBeGreaterThan(10 * 1024 * 1024 + base64Length(mb * BYTES_PER_MB));
      /** At most 2.1 MB beyond that. */
      expect(limit).toBeLessThan(
        10 * 1024 * 1024 + base64Length(mb * BYTES_PER_MB) + 2_200_000,
      );
    }
  });

  test("the DTO's per-file cap is the base64 of the largest budget", () => {
    expect(MAX_ATTACHMENT_BASE64_LENGTH).toBe(
      base64Length(MAX_ATTACHMENTS_MAX_TOTAL_MB * BYTES_PER_MB),
    );
  });

  test("the SMTP submission cap fits the MIME encoding of the budget", () => {
    for (const mb of [1, 5, 18]) {
      const bytes = mb * BYTES_PER_MB;
      const mime = Math.ceil(((bytes * 4) / 3) * (78 / 76));
      const cap = submissionMaxMessageBytes(bytes);
      expect(cap).toBeGreaterThan(10 * 1024 * 1024 + mime);
      expect(cap).toBeLessThan(10 * 1024 * 1024 + mime + 100_000);
    }
  });
});

describe("submissionAttachments", () => {
  test("keeps bytes and Content-ID, names a part without a filename", () => {
    const parts = submissionAttachments([
      { filename: "a.pdf", content: PDF },
      { content: PNG, cid: "logo@x" },
    ]);
    expect(parts).toEqual([
      { filename: "a.pdf", content: PDF },
      { filename: "attachment-2", content: PNG, contentId: "logo@x" },
    ]);
  });
});
