import { describe, test, expect } from "bun:test";
import {
  matchesUnsubscribeUrl,
  rewriteLinks,
  type LinkRewriteOptions,
} from "../../src/modules/tracking/services/link-rewriter.ts";
import { lastBodyClose } from "../../src/modules/tracking/services/html-scan.ts";
import { decodeHref } from "../../src/modules/tracking/services/href-decode.ts";

/**
 * The click tracking link rewriter (#187): only quoted http(s) hrefs of
 * `<a>` tags change, everything else stays byte for byte, the skip rules
 * hold, and adversarial input neither breaks it nor makes it slow.
 */

/** Rewrites with a recognisable tracking URL and records what was signed. */
function rewrite(
  html: string,
  unsubscribeUrl: string | null = "https://example.com/unsubscribe",
): { html: string; rewritten: number; signed: Array<[string, number]> } {
  const signed: Array<[string, number]> = [];
  const options: LinkRewriteOptions = {
    ownHost: "mail.example.com",
    unsubscribeUrl,
    trackingUrl: (url, position) => {
      signed.push([url, position]);
      return `https://mail.example.com/t/c/T${position}`;
    },
  };
  const result = rewriteLinks(html, options);
  return { ...result, signed };
}

describe("what is rewritten", () => {
  test("a double- or single-quoted http(s) href, and only the value", () => {
    const html = `<p>See <a class="x" href="https://example.com/a">a</a> and <a href='http://example.com/b' id=y>b</a>.</p>`;
    const out = rewrite(html);
    expect(out.html).toBe(
      `<p>See <a class="x" href="https://mail.example.com/t/c/T0">a</a> and <a href='https://mail.example.com/t/c/T1' id=y>b</a>.</p>`,
    );
    expect(out.rewritten).toBe(2);
    expect(out.signed).toEqual([
      ["https://example.com/a", 0],
      ["http://example.com/b", 1],
    ]);
  });

  test("attributes in any order and case, with spaces around =", () => {
    const out = rewrite(
      `<A TITLE="t" HREF = "https://example.com/x" target=_blank>go</A>`,
    );
    expect(out.html).toBe(
      `<A TITLE="t" HREF = "https://mail.example.com/t/c/T0" target=_blank>go</A>`,
    );
  });

  test("entities and whitespace in href are read as a browser does; the canonical URL is signed", () => {
    const out = rewrite(
      `<a href="  https://Example.com/p?a=1&amp;b=2&#38;c=3\n  ">x</a>`,
    );
    expect(out.signed).toEqual([["https://example.com/p?a=1&b=2&c=3", 0]]);
  });

  test("a > inside a quoted attribute does not end the tag", () => {
    const out = rewrite(`<a title="a > b" href="https://example.com/">x</a>`);
    expect(out.html).toBe(
      `<a title="a > b" href="https://mail.example.com/t/c/T0">x</a>`,
    );
  });
});

describe("what is never rewritten", () => {
  test.each([
    ["mailto", `<a href="mailto:a@example.com">mail</a>`],
    ["tel", `<a href="tel:+123">call</a>`],
    ["fragment", `<a href="#top">top</a>`],
    ["relative", `<a href="/path">rel</a>`],
    ["javascript", `<a href="javascript:alert(1)">js</a>`],
    ["data", `<a href="data:text/html,x">d</a>`],
    ["unquoted", `<a href=https://example.com/>bare</a>`],
    ["no href", `<a name="x">n</a>`],
    ["own unsubscribe link", `<a href="https://mail.example.com/u/abc">leave</a>`],
    ["already a tracking link", `<a href="https://mail.example.com/t/c/abc">t</a>`],
    [
      "the domain's unsubscribe_url",
      `<a href="https://example.com/unsubscribe?id=1">u</a>`,
    ],
    ["visible text is a URL", `<a href="https://evil.example/">https://example.com/</a>`],
    ["visible text is www.", `<a href="https://example.com/">www.example.com</a>`],
    ["visible text is a host", `<a href="https://example.com/x"><b>Example.com</b></a>`],
    [
      "over 2048 characters",
      `<a href="https://example.com/${"a".repeat(2100)}">long</a>`,
    ],
    ["in a comment", `<!-- <a href="https://example.com/">x</a> -->`],
    ["in a style", `<style>a[href="https://example.com/"] { color: red }</style>`],
    ["in a script", `<script>var s = '<a href="https://example.com/">x</a>';</script>`],
    ["in a title", `<title><a href="https://example.com/">x</a></title>`],
    ["in a textarea", `<textarea><a href="https://example.com/">x</a></textarea>`],
  ])("%s", (_name, html) => {
    const out = rewrite(html);
    expect(out.html).toBe(html);
    expect(out.rewritten).toBe(0);
  });

  test("data-bunmail-notrack keeps the link and removes the attribute", () => {
    expect(
      rewrite(`<a data-bunmail-notrack href="https://example.com/">x</a>`).html,
    ).toBe(`<a href="https://example.com/">x</a>`);
    expect(
      rewrite(
        `<a href="https://example.com/" DATA-BUNMAIL-NOTRACK="">x</a> <a href="https://example.com/b">y</a>`,
      ).html,
    ).toBe(
      `<a href="https://example.com/">x</a> <a href="https://mail.example.com/t/c/T0">y</a>`,
    );
  });

  test("links after the first 100 http(s) links are left alone", () => {
    const html = Array.from(
      { length: 120 },
      (_, i) => `<a href="https://example.com/${i}">l${i}</a>`,
    ).join("");
    const out = rewrite(html);
    expect(out.rewritten).toBe(100);
    expect(out.html).toContain(`<a href="https://example.com/100">l100</a>`);
    expect(out.html).toContain(`<a href="https://example.com/119">l119</a>`);
    expect(out.signed.at(-1)).toEqual(["https://example.com/99", 99]);
  });

  test("a refused mint leaves the link as it is", () => {
    const out = rewriteLinks(`<a href="https://example.com/">x</a>`, {
      ownHost: null,
      unsubscribeUrl: null,
      trackingUrl: () => null,
    });
    expect(out).toEqual({ html: `<a href="https://example.com/">x</a>`, rewritten: 0 });
  });
});

describe("adversarial input", () => {
  test.each([
    ["an unclosed tag", `<p>x <a href="https://example.com/"`],
    ["an unclosed quote", `<a href="https://example.com/>x</a> and the rest`],
    ["an unclosed comment", `<!-- <a href="https://example.com/">x</a>`],
    ["an unclosed script", `<script><a href="https://example.com/">x</a>`],
  ])("%s: the rest is kept as it is", (_name, html) => {
    expect(rewrite(html).html).toBe(html);
  });

  test("text before an unclosed construct is still rewritten, the rest kept", () => {
    const html = `<a href="https://example.com/a">a</a><!-- <a href="https://example.com/b">b</a>`;
    expect(rewrite(html).html).toBe(
      `<a href="https://mail.example.com/t/c/T0">a</a><!-- <a href="https://example.com/b">b</a>`,
    );
  });

  test("a quote that closes later reads like a browser: the whole quoted run is the value", () => {
    const out = rewrite(
      `<a href="https://example.com/>x</a> <a href="https://example.com/b">y</a>`,
    );
    expect(out.signed).toEqual([["https://example.com/%3Ex%3C/a%3E%20%3Ca%20href=", 0]]);
  });

  test("stray < and odd markup", () => {
    const html = `a < b <<a href="https://example.com/">x</a> <3 </ a> <a/>`;
    expect(rewrite(html).html).toBe(
      `a < b <<a href="https://mail.example.com/t/c/T0">x</a> <3 </ a> <a/>`,
    );
  });

  test("a tag inside another tag's quoted attribute is not a link", () => {
    const html = `<img alt='<a href="https://example.com/">x</a>' src="i.png">`;
    expect(rewrite(html).html).toBe(html);
  });

  test("tag names that look like Object properties are plain tags", () => {
    const html = `<constructor><__proto__><a href="https://example.com/">x</a>`;
    expect(rewrite(html).rewritten).toBe(1);
  });

  test("non-ASCII and astral characters around links are preserved", () => {
    const html = `<p>İstanbul 😀 <a href="https://example.com/ü">ü</a> İ</p>`;
    const out = rewrite(html);
    expect(out.html).toBe(
      `<p>İstanbul 😀 <a href="https://mail.example.com/t/c/T0">ü</a> İ</p>`,
    );
    expect(out.signed).toEqual([["https://example.com/%C3%BC", 0]]);
  });

  test("linear time on large and pathological inputs", () => {
    const cases = [
      "<a ".repeat(200_000),
      `<a href="`.repeat(100_000),
      "<!--".repeat(200_000),
      "<script>".repeat(100_000),
      `<a href="https://x.example/">https://y.example/`.repeat(20_000),
      `<a href="https://example.com/">x</a>`.repeat(50_000),
      "<".repeat(1_000_000),
      `<a b="c" `.repeat(100_000),
    ];
    for (const html of cases) {
      const started = performance.now();
      rewrite(html);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
});

describe("security review fixes", () => {
  test.each([
    ["any scheme to the own host", `<a href="http://mail.example.com/u/abc">x</a>`],
    [
      "percent-encoded /u/ on the own host",
      `<a href="https://mail.example.com/%75/abc">x</a>`,
    ],
    [
      "the dashboard on the own host",
      `<a href="https://MAIL.example.com/dashboard">x</a>`,
    ],
    ["an unknown named reference", `<a href="https://example.com/?a=1&foo;b">x</a>`],
    [
      "a legacy name a browser would decode",
      `<a href="https://example.com/?a=&copy-1">x</a>`,
    ],
    ["a numeric reference without ;", `<a href="https://example.com/&#65">x</a>`],
    [
      "a C1 code point (remapped by browsers)",
      `<a href="https://example.com/&#x80;">x</a>`,
    ],
    ["a NUL code point", `<a href="https://example.com/&#0;">x</a>`],
    ["in xmp", `<xmp><a href="https://example.com/">x</a></xmp>`],
    ["in noscript", `<noscript><a href="https://example.com/">x</a></noscript>`],
    ["in noembed", `<noembed><a href="https://example.com/">x</a></noembed>`],
    ["in noframes", `<noframes><a href="https://example.com/">x</a></noframes>`],
    ["in iframe", `<iframe><a href="https://example.com/">x</a></iframe>`],
    [
      "after plaintext",
      `<plaintext><a href="https://example.com/">x</a></plaintext><a href="https://example.com/b">y</a>`,
    ],
  ])("never rewritten: %s", (_name, html) => {
    const out = rewrite(html);
    expect(out.html).toBe(html);
    expect(out.rewritten).toBe(0);
  });

  test("an & a browser keeps as written is fine: raw query separators and legacy names before = or a letter", () => {
    const out = rewrite(
      `<a href="https://example.com/?a=1&utm_source=x&copy=2&regional=3&&=4">x</a>`,
    );
    expect(out.signed).toEqual([
      ["https://example.com/?a=1&utm_source=x&copy=2&regional=3&&=4", 0],
    ]);
  });

  test("decodeHref: strict references, URL-parser stripping only", () => {
    expect(decodeHref("a&amp;b&lt;&gt;&quot;&apos;&#65;&#x42;")).toBe(`a&b<>"'AB`);
    expect(decodeHref("\u0000 \t https://x/\n \u001f")).toBe("https://x/");
    /** NBSP and U+FEFF are not URL-parser whitespace: kept, so the URL fails to parse. */
    expect(decodeHref("\u00a0https://x/\ufeff")).toBe("\u00a0https://x/\ufeff");
    expect(decodeHref("&nbsp;")).toBeNull();
    expect(decodeHref("&#xD800;")).toBeNull();
    expect(decodeHref("&#x110000;")).toBeNull();
  });

  test("NBSP or BOM around an href leaves it untracked instead of trimming them away", () => {
    expect(rewrite(`<a href="\u00a0https://example.com/">x</a>`).rewritten).toBe(0);
    expect(rewrite(`<a href="https://example.com/\ufeff">x</a>`).signed).toEqual([
      ["https://example.com/%EF%BB%BF", 0],
    ]);
  });

  test("the unsubscribe URL matches exactly or under its path on a / boundary", () => {
    const own = "https://example.com/unsubscribe";
    expect(matchesUnsubscribeUrl("https://example.com/unsubscribe", own)).toBe(true);
    expect(matchesUnsubscribeUrl("https://example.com/unsubscribe?id=1", own)).toBe(true);
    expect(matchesUnsubscribeUrl("https://example.com/unsubscribe/x", own)).toBe(true);
    expect(matchesUnsubscribeUrl("https://example.com/unsubscribe-me", own)).toBe(false);
    expect(matchesUnsubscribeUrl("https://example.com/unsubscribed", own)).toBe(false);
    expect(matchesUnsubscribeUrl("http://example.com/unsubscribe", own)).toBe(false);
    expect(matchesUnsubscribeUrl("https://other.example/unsubscribe", own)).toBe(false);
  });

  test("a site-root unsubscribe URL matches only itself, never every link of the site", () => {
    const root = "https://example.com/";
    expect(matchesUnsubscribeUrl("https://example.com/", root)).toBe(true);
    expect(matchesUnsubscribeUrl("https://example.com/pricing", root)).toBe(false);
    expect(matchesUnsubscribeUrl("https://example.com/?x=1", root)).toBe(false);
    const out = rewrite(`<a href="https://example.com/pricing">p</a>`, root);
    expect(out.rewritten).toBe(1);
  });

  test("an unsubscribe URL with a query matches only exactly", () => {
    const own = "https://example.com/u?list=1";
    expect(matchesUnsubscribeUrl("https://example.com/u?list=1", own)).toBe(true);
    expect(matchesUnsubscribeUrl("https://example.com/u?list=2", own)).toBe(false);
  });

  test("lastBodyClose finds the last real </body>, not one in a comment, script or textarea", () => {
    const html = `<body><p>a</p></body><!-- </body> --><script>"</body>"</script><textarea></body></textarea>`;
    expect(lastBodyClose(html)).toBe(html.indexOf("</body>"));
    expect(lastBodyClose("<p>no body</p>")).toBe(-1);
    expect(lastBodyClose("<body>x</body><!-- unclosed </body>")).toBe(7);
  });
});
