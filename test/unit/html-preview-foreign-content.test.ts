import { describe, test, expect } from "bun:test";
import {
  HtmlPreview,
  previewCsp,
  sanitizeEmailForPreview,
} from "../../src/pages/components/html-preview.tsx";

/** The meta tag the preview document starts its `<head>` with. */
function cspMeta(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

/**
 * Extracts the `srcdoc` attribute of the first iframe in `page` and decodes
 * it the way a browser does (`Bun.escapeHTML` produces exactly these five
 * entities), returning the document the iframe parses.
 */
function srcdocOf(page: string): string {
  const match = /srcdoc="([^"]*)"/.exec(page);
  if (!match?.[1]) throw new Error("no srcdoc attribute found");
  return match[1]
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

const PAGE_HREF = "/dashboard/inbound/inb_x";

/**
 * Foreign content and nested documents (#454).
 *
 * Inside `<math>` or `<svg>`, Bun's `HTMLRewriter` and a browser can
 * disagree on which elements are raw text: the rewriter reads a `<style>`
 * after `<mtext><mglyph>` as raw text, while the browser keeps that
 * `<style>` a MathML element, breaks out at `<p>` and creates the `<link>`
 * after it. The sanitizer now removes `math`, `svg` and `iframe` (a
 * `srcdoc` is a nested, entity-encoded document) with their content, and
 * turns any `<link`, `<meta` or `<base` start tag left in its output into
 * text.
 */
describe("sanitizeEmailForPreview: foreign content (#454)", () => {
  /** A start tag a browser would read as one of the three elements. */
  const RESIDUAL_TAG = /<(?:link|meta|base)[\t\n\f\r />]/i;
  const HOST = "https://r123.attacker.example";
  const LINK = `<link rel=preconnect href=${HOST}>`;
  const META = "<meta name=referrer content=unsafe-url>";
  const BASE = `<base href=${HOST}/>`;
  /** Every container after `<math><mtext><mglyph>` the rewriter reads as raw text. */
  const RAW_TEXT = [
    "style",
    "xmp",
    "textarea",
    "title",
    "iframe",
    "noembed",
    "noframes",
    "plaintext",
    "script",
    "noscript",
  ];

  test.each([
    [`<math><mtext><mglyph><style><p>${LINK}`],
    [`<math><mtext><malignmark><style><p>${LINK}`],
    [`<math><mtext><mglyph><style><p>${META}`],
    [`<math><mtext><malignmark><style><p>${META}`],
    [`<math><mtext><mglyph><style><p><meta http-equiv=refresh content="0;url=${HOST}">`],
    [
      `<math><mtext><mglyph><style><p><meta http-equiv=x-dns-prefetch-control content=on>`,
    ],
    [`<math><mtext><mglyph><style><p>${BASE}`],
    ...RAW_TEXT.map((tag) => [`<math><mtext><mglyph><${tag}><p>${LINK}`]),
    [`<MATH><MTEXT><MGLYPH><STYLE><P><LINK REL=preconnect HREF=${HOST}>`],
    [`<math><mtext><mglyph><style><p><link/rel=preconnect/href=${HOST}>`],
    [`<math><mtext><mglyph><style><p><link\trel=preconnect\nhref=${HOST}>`],
    [`<math><mtext><mglyph><style><p><link\rrel=preconnect href=${HOST}>`],
    [`<math><mtext><mglyph><style><p><meta\fhttp-equiv=refresh content=0>`],
    [`<math><math><mtext><mglyph><style><p>${LINK}`],
    [`<table><math><mtext><mglyph><style><p>${LINK}`],
    [`<select><math><mtext><mglyph><style><p>${LINK}`],
    [`<math><annotation-xml encoding="text/html"><style><p>${LINK}`],
    [`<math><mi><style><p>${LINK}`],
    [`<svg><foreignObject><style><p>${LINK}`],
    [`<svg><desc><style><p>${LINK}`],
    [`<svg><title><style><p>${META}`],
    [`<SvG><ForeignObject><style><p>${LINK}`],
    [`<svg><font color=red><style><p>${LINK}`],
    [`<iframe srcdoc="&lt;link rel=preconnect href=${HOST}&gt;"></iframe>`],
    [`<iframe srcdoc="${LINK}"></iframe>`],
    [`<math><mtext><mglyph><style><p><link`],
  ])("leaves no element for the browser to create: %p", (payload) => {
    const out = sanitizeEmailForPreview(`<p>before</p>${payload}<p>after</p>`);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(RESIDUAL_TAG);
    expect(out).not.toContain("attacker.example");
    expect(out).toContain("<p>before</p>");
  });

  test.each([
    [`<style>p{color:red}${LINK}</style>`],
    [`<textarea>${META}</textarea>`],
    [`<title>${BASE}</title>`],
    [`<xmp>${LINK}</xmp>`],
    [`<noembed>${LINK}</noembed>`],
    [`<noframes>${LINK}</noframes>`],
    [`<plaintext>${LINK}`],
    [`<template>${LINK}</template>`],
  ])("backstop: a tag left in raw text becomes text: %p", (payload) => {
    const out = sanitizeEmailForPreview(`<p>before</p>${payload}`);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(RESIDUAL_TAG);
    expect(out).not.toMatch(/<(?:link|meta|base)$/i);
  });

  test("backstop: the `<` is entity-encoded, the rest of the text is kept", () => {
    expect(sanitizeEmailForPreview(`<style>a{}${LINK}</style>`)).toBe(
      `<style>a{}&lt;${LINK.slice(1)}</style></body></html>`,
    );
    expect(sanitizeEmailForPreview("<xmp><LINK/x><Meta\ty><base\rz></xmp>")).toBe(
      "<xmp>&lt;LINK/x>&lt;Meta\ty>&lt;base\rz></xmp></body></html>",
    );
  });

  test("backstop: other tag names and escaped text are untouched", () => {
    /** `<link"` is a tag named `link"` to a browser, not a link. */
    const html =
      '<linked-card>a</linked-card><basefont size=2><p>&lt;link rel=x&gt; "<link" x</p>';
    expect(sanitizeEmailForPreview(html)).toBe(`${html}</body></html>`);
  });

  test("a normal email loses only its svg, math and iframe elements", () => {
    const keep =
      "<html><head><style>.btn{background:#0a0;color:#fff}</style></head>" +
      '<body style="margin:0"><table role="presentation" width="100%"><tr>' +
      '<td align="center"><h1>Your order</h1><p>Hi Alex, thanks &amp; welcome.</p>' +
      '<a class="btn" href="https://shop.example/o/1">View order</a></td></tr></table>';
    const removed = [
      '<svg width="16" height="16" viewBox="0 0 16 16"><title>icon</title><path d="M0 0h16v16H0z"/></svg>',
      "<math><mi>x</mi><mo>=</mo><mn>2</mn></math>",
      '<iframe src="https://video.example/embed/1" width="560"></iframe>',
    ];
    const tail = '<img src="https://shop.example/logo.png" alt="Shop"></body></html>';
    const out = sanitizeEmailForPreview(`${keep}${removed.join("<br>")}${tail}`);
    expect(out).toBe(`${keep}<br><br>${tail}</body></html>`);
  });

  test("runs in linear time on large hostile foreign content", () => {
    const payloads = [
      `<math><mtext><mglyph><style>${"<link ".repeat(400_000)}`,
      `<style>${"<link ".repeat(400_000)}</style>`,
      `<xmp>${"<meta/<base\t".repeat(200_000)}</xmp>`,
      "<math><mtext><mglyph>".repeat(50_000),
      "<svg><foreignObject>".repeat(50_000),
      `${"<iframe>".repeat(100_000)}${LINK}`,
    ];
    for (const html of payloads) {
      const started = performance.now();
      const out = sanitizeEmailForPreview(html);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(out).not.toBeNull();
      expect(out).not.toMatch(RESIDUAL_TAG);
    }
  });

  test("the preview document keeps only BunMail's metas, in its head", async () => {
    const payload = `<p>Hi</p><math><mtext><mglyph><style><p>${LINK}${META}`;
    for (const remoteImages of [false, true]) {
      const doc = srcdocOf(
        await HtmlPreview({ html: payload, pageHref: PAGE_HREF, remoteImages }),
      );
      expect(doc.match(/<meta[\t\n\f\r />]/gi)?.length).toBe(2);
      expect(doc).not.toMatch(/<(?:link|base)[\t\n\f\r />]/i);
      expect(doc).toContain(cspMeta(previewCsp(remoteImages)));
      expect(doc).not.toContain("attacker.example");
      expect(doc).toContain("<p>Hi</p>");
    }
  });
});
