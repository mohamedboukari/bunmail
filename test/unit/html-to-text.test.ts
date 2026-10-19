import { describe, test, expect } from "bun:test";
import {
  htmlToText,
  MAX_HTML_INPUT_LENGTH,
  MAX_TEXT_OUTPUT_LENGTH,
} from "../../src/modules/emails/services/html-to-text.ts";

/**
 * The bounded HTML-to-text converter behind the text alternative of
 * HTML-only sends (#250): what it keeps, what it drops, and that its cost
 * stays linear on hostile input.
 */

describe("htmlToText: content", () => {
  test("plain markup becomes its text", () => {
    expect(htmlToText("<p>Hello <b>world</b></p>")).toBe("Hello world");
  });

  test("script, style, head, title and comments are dropped with their content", () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head>" +
      "<body><script>alert('x')</script><!-- secret -->Visible" +
      "<STYLE type='text/css'>.a{}</STYLE><Script>var a = '</p>';</Script> text</body></html>";
    const text = htmlToText(html);
    expect(text).toBe("Visible text");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color");
  });

  test("an element that is never closed drops the rest", () => {
    expect(htmlToText("Before<script>never closed and more text")).toBe("Before");
    expect(htmlToText("Before<!-- never closed")).toBe("Before");
    expect(htmlToText('Before<a href="unterminated>after')).toBe("Before");
  });

  test("a > inside a quoted attribute does not end the tag", () => {
    expect(htmlToText('<img alt="a > b" src="x">Text')).toBe("Text");
  });

  test("block elements end lines; paragraphs and headings leave a blank line", () => {
    const html =
      "<h1>Title</h1><p>One</p><p>Two<br>Three</p><div>Four</div><div>Five</div>";
    expect(htmlToText(html)).toBe("Title\n\nOne\n\nTwo\nThree\n\nFour\nFive");
  });

  test("table rows end lines and cells are separated", () => {
    const html =
      "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>";
    expect(htmlToText(html)).toBe("A B\nC D");
  });

  test("list items start with a dash", () => {
    expect(htmlToText("<ul><li>One</li><li> Two </li></ul>")).toBe("- One\n- Two");
  });

  test("whitespace collapses and lines are trimmed", () => {
    expect(htmlToText("  <p>  Hello \n\t  world  </p>\n\n\n  <p>Again</p>  ")).toBe(
      "Hello world\n\nAgain",
    );
  });

  test("a < that starts no tag is kept as text", () => {
    expect(htmlToText("1 < 2 and 3 <= 4")).toBe("1 < 2 and 3 <= 4");
  });

  test("no text at all gives an empty string", () => {
    expect(htmlToText('<img src="logo.png"><br>')).toBe("");
  });
});

describe("htmlToText: links", () => {
  test.each([
    ['<a href="https://example.com/x">Open</a>', "Open (https://example.com/x)"],
    ['<a href="http://example.com">Site</a>', "Site (http://example.com)"],
    [
      "<a href='mailto:help@example.com'>Write to us</a>",
      "Write to us (mailto:help@example.com)",
    ],
    ["<a href=https://example.com/u>Bare</a>", "Bare (https://example.com/u)"],
    ['<A HREF="HTTPS://EXAMPLE.COM">Upper</A>', "Upper (HTTPS://EXAMPLE.COM)"],
  ])("%s", (html, expected) => {
    expect(htmlToText(html)).toBe(expected);
  });

  test("entities in the href are decoded", () => {
    expect(htmlToText('<a href="https://example.com/?a=1&amp;b=2">Go</a>')).toBe(
      "Go (https://example.com/?a=1&b=2)",
    );
  });

  test.each([
    '<a href="javascript:alert(1)">Click</a>',
    '<a href="data:text/html,x">Click</a>',
    '<a href="/relative">Click</a>',
    '<a href=" java\tscript:alert(1)">Click</a>',
    "<a>Click</a>",
  ])("other schemes keep the text only: %s", (html) => {
    expect(htmlToText(html)).toBe("Click");
  });

  test("a link whose text is its target is written once", () => {
    expect(htmlToText('<a href="https://example.com">https://example.com</a>')).toBe(
      "https://example.com",
    );
    expect(htmlToText('<a href="mailto:a@example.com">a@example.com</a>')).toBe(
      "a@example.com",
    );
  });

  test("a link with no text is written as its target", () => {
    expect(htmlToText('<a href="https://example.com"><img src="x"></a>')).toBe(
      "https://example.com",
    );
  });
});

describe("htmlToText: entities", () => {
  test("common named entities", () => {
    expect(htmlToText("Tom &amp; Jerry &lt;3 &quot;hi&quot; &apos;yo&apos;")).toBe(
      "Tom & Jerry <3 \"hi\" 'yo'",
    );
    expect(htmlToText("&copy; 2026 &euro;5 caf&#233;")).toBe(
      "\u00a9 2026 \u20ac5 caf\u00e9",
    );
  });

  test("numeric entities, decimal and hex", () => {
    expect(htmlToText("&#72;&#x69;&#X21; &#x1F600;")).toBe("Hi! \u{1f600}");
  });

  test("invalid code points become U+FFFD, controls are dropped", () => {
    expect(htmlToText("a&#0;b&#xD800;c&#x110000;d")).toBe("a\ufffdb\ufffdc\ufffdd");
    expect(htmlToText("a&#7;b")).toBe("ab");
  });

  test("unknown or unterminated entities stay as written", () => {
    expect(htmlToText("&bogus; &amp &")).toBe("&bogus; &amp &");
  });

  test("&nbsp; collapses like a space", () => {
    expect(htmlToText("a&nbsp;&nbsp; b")).toBe("a b");
  });
});

describe("htmlToText: bounds", () => {
  test("output is capped", () => {
    const text = htmlToText(`<p>${"word ".repeat(200_000)}</p>`);
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_OUTPUT_LENGTH);
    expect(text.length).toBeGreaterThan(MAX_TEXT_OUTPUT_LENGTH - 10);
  });

  test("only the first 1 MB of HTML is read", () => {
    const html = "a".repeat(MAX_HTML_INPUT_LENGTH) + "TAIL";
    expect(htmlToText(html)).not.toContain("TAIL");
  });

  test("the cap never splits a surrogate pair", () => {
    const html = "x".repeat(MAX_HTML_INPUT_LENGTH - 1) + "\u{1f600}";
    const text = htmlToText(html);
    const last = text.charCodeAt(text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

/**
 * Linear time on hostile input (#250): 10 MB shaped to stress each branch
 * (nesting, unclosed tags and quotes, entity starts, dropped elements
 * with many near-miss closings). The converter reads 1 MB of it; the
 * budget is generous, so only a super-linear regression fails.
 */
describe("htmlToText: time budget at 10 MB", () => {
  const TEN_MB = 10 * 1024 * 1024;
  const BUDGET_MS = 1500;
  const RUNNER_TIMEOUT_MS = 30_000;

  test.each([
    ["deep nesting", () => "<div><a href='https://x'>".repeat(TEN_MB / 26)],
    ["unclosed tags", () => "<a <a <a ".repeat(TEN_MB / 9)],
    ["many lone <", () => "<".repeat(TEN_MB)],
    ["many & without ;", () => "&".repeat(TEN_MB)],
    ["entity-like runs", () => "&#1234567890123456789012345678901".repeat(TEN_MB / 33)],
    [
      "script with near-miss closings",
      () => "<script>" + "</scrip</a>".repeat(TEN_MB / 11),
    ],
    ["many dropped elements", () => "<style>x</style>".repeat(TEN_MB / 16)],
    ["unterminated quote", () => '<a href="' + "x".repeat(TEN_MB)],
    ["many comments starts", () => "<!-".repeat(TEN_MB / 3)],
    ["many list items", () => "<li>".repeat(TEN_MB / 4)],
  ])(
    "%s",
    (_name, build) => {
      const html = build();
      const start = performance.now();
      htmlToText(html);
      expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    },
    RUNNER_TIMEOUT_MS,
  );
});
