import { describe, test, expect } from "bun:test";
import { Elysia } from "elysia";
import {
  HtmlPreview,
  LiveHtmlPreview,
  hasRemoteImages,
  previewCsp,
  sanitizeEmailForPreview,
} from "../../src/pages/components/html-preview.tsx";
import { EmailDetailPage } from "../../src/pages/routes/email-detail.tsx";
import { InboundDetailPage } from "../../src/pages/routes/inbound-detail.tsx";
import {
  PAGE_CSP,
  securityHeadersPlugin,
} from "../../src/middleware/security-headers.ts";

/**
 * Remote images in email previews (#419).
 *
 * The preview is a `srcdoc` iframe that inherits the dashboard's page CSP
 * (`img-src 'self' data: https:`), so a remote image in an email used to
 * load as soon as someone opened it: a read receipt that also leaks the
 * viewer's IP. The srcdoc document now declares its own, stricter CSP in a
 * `<meta http-equiv>`; browsers enforce it on top of the inherited one, so
 * it only ever tightens. `?images=1` renders the preview allowing `https:`
 * images, and the page CSP itself never changes. Resource hints and
 * referrer overrides are not governed by CSP, so the email's `<link>`,
 * `<meta>`, `<base>` and `<noscript>` elements are removed first.
 */

/** The policy the preview declares by default. */
const BLOCKED_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
/** The policy after "Load remote images". */
const REMOTE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:";

/** The meta tag the preview document starts its `<head>` with. */
function cspMeta(policy: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
}

/**
 * Extracts the `srcdoc` attribute of the first iframe in `page` and decodes
 * it the way a browser does, returning the document the iframe parses.
 * `Bun.escapeHTML` produces exactly these five entities.
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

const PIXEL = '<p>Hi</p><img src="https://tracker.example/p.gif?id=42" alt="">';
const PAGE_HREF = "/dashboard/inbound/inb_x";

describe("previewCsp (#419)", () => {
  test("blocks remote images by default, and every other fetch", () => {
    expect(previewCsp(false)).toBe(BLOCKED_CSP);
  });

  test("with remote images allows https: images only, never http:", () => {
    expect(previewCsp(true)).toBe(REMOTE_CSP);
    expect(previewCsp(true)).not.toContain("http:");
    expect(previewCsp(true)).not.toContain("*");
  });
});

describe("hasRemoteImages (#419)", () => {
  test.each([
    ['<img src="https://a.example/x.png">'],
    ["<img src='http://a.example/x.png'>"],
    ["<img src=https://a.example/x.png>"],
    ['<img src = "//cdn.example/x.png">'],
    ['<img srcset="https://a.example/x.png 2x">'],
    ['<table background="https://a.example/bg.png">'],
    ['<video poster="https://a.example/p.png">'],
    ['<td style="background:url(https://a.example/bg.png)">'],
    ["<style>.x { background-image: url( '//a.example/bg.png' ) }</style>"],
    [
      '<div style="background-image: image-set(&quot;x&quot; 1x, url(https://a.example/y.png) 2x)">',
    ],
    ['<IMG SRC="HTTPS://A.EXAMPLE/X.PNG">'],
    ['<img srcset="data:image/png;base64,AA== 1x, https://a.example/x.png 2x">'],
    ["<img srcset='a.png 1x,//cdn.example/b.png 2x'>"],
    ['<img src=" https://a.example/x.png">'],
  ])("detects %p", (html) => {
    expect(hasRemoteImages(html)).toBe(true);
  });

  test.each([
    ['<a href="https://example.com/page">a link</a>'],
    ['<img src="data:image/png;base64,iVBORw0KGgo=">'],
    ['<img src="cid:logo@example.com">'],
    ['<img src="/relative/logo.png">'],
    ["<p>Visit https://example.com today</p>"],
    ['<img srcset="a.png 1x, b.png 2x">'],
    [""],
  ])("ignores %p", (html) => {
    expect(hasRemoteImages(html)).toBe(false);
  });

  test("runs in linear time on hostile input (5 MB payloads)", () => {
    const size = 5_000_000;
    const payloads = [
      `<img src=${" ".repeat(size)}`,
      `<img src="${" ".repeat(size)}`,
      `url(${" ".repeat(size)}`,
      `<img srcset="a,${" ".repeat(size)}`,
      `<img srcset="${", ".repeat(size / 2)}`,
      "src=".repeat(size / 4),
    ];
    for (const payload of payloads) {
      const started = performance.now();
      expect(hasRemoteImages(payload)).toBe(false);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });

  test("only the first 1,000,000 characters are scanned", () => {
    const late = `${" ".repeat(1_000_000)}<img src="https://a.example/x.png">`;
    expect(hasRemoteImages(late)).toBe(false);
  });
});

describe("sanitizeEmailForPreview (#419)", () => {
  test.each([
    ['<link rel="prerender" href="https://tracker.example/r/42">'],
    ['<link rel="preconnect" href="https://r42.tracker.example">'],
    ['<link rel="dns-prefetch" href="//r42.tracker.example">'],
    ['<link rel="preload" as="image" href="https://tracker.example/p.gif">'],
    ['<link rel="prefetch" href="https://tracker.example/p">'],
    ['<link rel="stylesheet" href="https://tracker.example/s.css">'],
    ["<LINK REL=prerender HREF=https://tracker.example/r>"],
    ["<link/rel=prerender/href=https://tracker.example/r>"],
    ['<meta name="referrer" content="unsafe-url">'],
    ['<meta http-equiv="refresh" content="0;url=https://tracker.example/r">'],
    ['<meta http-equiv="Content-Security-Policy" content="img-src *">'],
    ['<base href="https://tracker.example/">'],
    ['<noscript><link rel="preconnect" href="https://tracker.example"></noscript>'],
    [
      '<svg><style><meta http-equiv="refresh" content="0;url=https://t.example"></style></svg>',
    ],
  ])("removes %p", (element) => {
    const out = sanitizeEmailForPreview(`<p>before</p>${element}<p>after</p>`);
    expect(out).not.toBeNull();
    expect(out).not.toMatch(/<link|<meta|<base|<noscript|tracker\.example/i);
    expect(out).toContain("<p>before</p>");
    expect(out).toContain("<p>after</p>");
  });

  test("an unterminated hint at the very end is completed and removed too", () => {
    for (const tail of [
      "<link rel=prerender href=https://tracker.example/r ",
      '<link rel=prerender href="https://tracker.example/r"',
    ]) {
      const out = sanitizeEmailForPreview(`<p>x</p>${tail}`);
      expect(out).not.toBeNull();
      expect(out).not.toContain("tracker.example");
    }
  });

  test("text, inline styles, style blocks and images are unchanged", () => {
    const html =
      '<html><head><meta charset="iso-8859-1"><style>p{color:red}</style></head>' +
      '<body style="margin:0"><p class="a" style="color:#123">Hi &amp; &lt;b&gt; <b>bold</b></p>' +
      '<img src="https://a.example/x.png" alt="x"><a href="https://example.com">link</a></body></html>';
    const out = sanitizeEmailForPreview(html);
    expect(out).toBe(
      "<html><head><style>p{color:red}</style></head>" +
        '<body style="margin:0"><p class="a" style="color:#123">Hi &amp; &lt;b&gt; <b>bold</b></p>' +
        '<img src="https://a.example/x.png" alt="x"><a href="https://example.com">link</a></body></html>' +
        "</body></html>",
    );
  });

  test("runs in linear time on a large hostile email", () => {
    const html =
      `<div>${" ".repeat(2_000_000)}` +
      '<link rel="prerender" href="https://tracker.example/r">'.repeat(20_000) +
      "<div>".repeat(100_000);
    const started = performance.now();
    const out = sanitizeEmailForPreview(html);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(out).not.toBeNull();
    expect(out).not.toContain("<link");
  });

  test("fails safe: a rewriter error renders none of the email", async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "HTMLRewriter");
    /** A stand-in whose transform always throws. */
    class ThrowingRewriter {
      on(): this {
        return this;
      }
      transform(): string {
        throw new Error("boom");
      }
    }
    Object.defineProperty(globalThis, "HTMLRewriter", {
      value: ThrowingRewriter,
      configurable: true,
      writable: true,
    });
    try {
      expect(sanitizeEmailForPreview(PIXEL)).toBeNull();
      const doc = srcdocOf(await HtmlPreview({ html: PIXEL, pageHref: PAGE_HREF }));
      expect(doc).not.toContain("tracker.example");
      expect(doc).toContain("could not be prepared for a safe preview");
      expect(doc).toContain(cspMeta(BLOCKED_CSP));
    } finally {
      if (original) Object.defineProperty(globalThis, "HTMLRewriter", original);
    }
  });
});

describe("HtmlPreview (#419)", () => {
  test("default: the restrictive meta CSP is the first thing in <head>", async () => {
    const doc = srcdocOf(await HtmlPreview({ html: PIXEL, pageHref: PAGE_HREF }));
    expect(
      doc.startsWith(
        `<!DOCTYPE html><html><head><meta charset="UTF-8">${cspMeta(BLOCKED_CSP)}<style>`,
      ),
    ).toBe(true);
    /** The email comes after the policy, in <body>. */
    expect(doc.indexOf(cspMeta(BLOCKED_CSP))).toBeLessThan(doc.indexOf("<body>"));
    expect(doc).toContain(`<body>${PIXEL}</body>`);
    expect(doc).not.toContain("https:;");
  });

  test("default with a remote image: the notice links to ?images=1", async () => {
    const html = await HtmlPreview({ html: PIXEL, pageHref: PAGE_HREF });
    expect(html).toContain("Remote images are hidden to protect your privacy.");
    expect(html).toContain(`href="${PAGE_HREF}?images=1#html-preview"`);
    expect(html).toContain("Load remote images");
    expect(html).toContain('id="html-preview"');
    expect(html).not.toContain("Hide them");
  });

  test("default without a remote image: no notice", async () => {
    const html = await HtmlPreview({
      html: '<p>Hi <a href="https://example.com">there</a></p>',
      pageHref: PAGE_HREF,
    });
    expect(html).not.toContain("Remote images are hidden");
    expect(html).not.toContain("?images=1");
    /** Still blocked: the policy does not depend on the scan. */
    expect(srcdocOf(html)).toContain(cspMeta(BLOCKED_CSP));
  });

  test("with remoteImages: https images allowed, and a link to hide them again", async () => {
    const html = await HtmlPreview({
      html: PIXEL,
      pageHref: PAGE_HREF,
      remoteImages: true,
    });
    const doc = srcdocOf(html);
    expect(doc).toContain(cspMeta(REMOTE_CSP));
    expect(doc).not.toContain(cspMeta(BLOCKED_CSP));
    expect(html).not.toContain("Remote images are hidden");
    expect(html).toContain("Remote images are shown");
    expect(html).toContain(`href="${PAGE_HREF}#html-preview"`);
    expect(html).toContain("Hide them");
  });

  test("hostile HTML cannot leave the srcdoc attribute", async () => {
    const hostile =
      '"><script>alert(1)</script></iframe><img src=x onerror="alert(2)">' +
      "' onload='alert(3)' &quot;&gt;";
    const html = await HtmlPreview({ html: hostile, pageHref: PAGE_HREF });
    /** One iframe, and its srcdoc holds no quote or angle bracket at all. */
    expect(html.match(/<iframe/g)?.length).toBe(1);
    expect(html.match(/<\/iframe>/g)?.length).toBe(1);
    expect(html).not.toContain("<script");
    const attribute = /srcdoc="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(attribute).not.toMatch(/[<>"']/);
    /** Round trip: the iframe parses exactly the stored HTML, entities included. */
    expect(srcdocOf(html)).toContain(`<body>${hostile}</body>`);
  });

  test("escaped text in an email stays text (no decoding into markup)", async () => {
    const text = "<p>&lt;img src=https://tracker.example/p.gif&gt;</p>";
    const doc = srcdocOf(await HtmlPreview({ html: text, pageHref: PAGE_HREF }));
    expect(doc).toContain(text);
    expect(doc).not.toContain("<img src=https://tracker.example");
  });

  test("hints and metas in the email never reach the srcdoc; BunMail's head stays", async () => {
    const own =
      '<html><head><meta http-equiv="Content-Security-Policy" content="img-src *">' +
      '<meta name="referrer" content="unsafe-url">' +
      '<link rel="prerender" href="https://tracker.example/r"></head>' +
      PIXEL;
    for (const remoteImages of [false, true]) {
      const doc = srcdocOf(
        await HtmlPreview({ html: own, pageHref: PAGE_HREF, remoteImages }),
      );
      expect(doc).not.toContain('content="img-src *"');
      expect(doc).not.toContain("unsafe-url");
      expect(doc).not.toContain("prerender");
      /** Exactly BunMail's two metas, both in its own head. */
      expect(doc.match(/<meta /g)?.length).toBe(2);
      expect(doc.indexOf(cspMeta(previewCsp(remoteImages)))).toBeLessThan(
        doc.indexOf("</head>"),
      );
      expect(doc).toContain(PIXEL);
    }
  });
});

describe("LiveHtmlPreview keeps its template preview behaviour", () => {
  test("no meta CSP (its client-side twin builds none), srcdoc encoded", async () => {
    const html = await LiveHtmlPreview({
      textareaId: "html",
      initialHtml: '<p class="x">Hi {{name}} &amp; co</p>',
    });
    const doc = srcdocOf(html);
    expect(doc).not.toContain("Content-Security-Policy");
    expect(doc).toContain('<p class="x">Hi Alex Doe &amp; co</p>');
  });
});

const now = new Date("2026-05-08T00:00:00Z");

const email = {
  id: "msg_x",
  apiKeyId: "key_x",
  domainId: null,
  fromAddress: "hello@example.com",
  toAddress: "user@example.org",
  cc: null,
  bcc: null,
  replyTo: null,
  headers: null,
  subject: "test",
  html: PIXEL,
  textContent: null,
  status: "sent" as const,
  source: "api",
  fromName: null,
  category: null,
  tags: null,
  trackOpens: false,
  trackClicks: false,
  firstOpenedAt: null,
  firstClickedAt: null,
  attempts: 1,
  nextAttemptAt: now,
  lockedBy: null,
  leaseUntil: null,
  lastError: null,
  messageId: "<x@y>",
  sentAt: now,
  createdAt: now,
  updatedAt: now,
  createdByUserId: null,
  deletedAt: null,
  deliveryState: null,
};

const inboundEmail = {
  id: "inb_x",
  fromAddress: "user@example.org",
  toAddress: "hello@example.com",
  subject: "hello",
  html: PIXEL,
  textContent: null,
  rawMessage: null,
  receivedAt: now,
  deletedAt: null,
  deliveryState: null,
  messageId: null,
  inReplyTo: null,
  references: null,
  inReplyToEmailId: null,
};

describe("detail pages (#419)", () => {
  test("outbound detail blocks remote images and links to its own ?images=1", async () => {
    const page = await EmailDetailPage({ email, isTrashed: false, attachments: [] });
    expect(srcdocOf(page)).toContain(cspMeta(BLOCKED_CSP));
    expect(page).toContain('href="/dashboard/emails/msg_x?images=1#html-preview"');
  });

  test("outbound detail with remoteImages allows https images", async () => {
    const page = await EmailDetailPage({
      email,
      isTrashed: false,
      attachments: [],
      remoteImages: true,
    });
    expect(srcdocOf(page)).toContain(cspMeta(REMOTE_CSP));
    expect(page).toContain('href="/dashboard/emails/msg_x#html-preview"');
  });

  test("inbound detail blocks remote images and links to its own ?images=1", async () => {
    const page = await InboundDetailPage({ email: inboundEmail, isTrashed: false });
    expect(srcdocOf(page)).toContain(cspMeta(BLOCKED_CSP));
    expect(page).toContain('href="/dashboard/inbound/inb_x?images=1#html-preview"');
  });

  test("inbound detail with remoteImages allows https images", async () => {
    const page = await InboundDetailPage({
      email: inboundEmail,
      isTrashed: false,
      remoteImages: true,
    });
    expect(srcdocOf(page)).toContain(cspMeta(REMOTE_CSP));
  });

  test("the page CSP is unchanged in both modes", async () => {
    const app = new Elysia()
      .use(securityHeadersPlugin({ httpsBaseUrl: false }))
      .get("/dashboard/inbound/inb_x", async ({ request }) => {
        const remoteImages = new URL(request.url).searchParams.get("images") === "1";
        return new Response(
          "<!doctype html>" +
            (await InboundDetailPage({
              email: inboundEmail,
              isTrashed: false,
              remoteImages,
            })),
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      });
    for (const path of [
      "/dashboard/inbound/inb_x",
      "/dashboard/inbound/inb_x?images=1",
    ]) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.headers.get("content-security-policy")).toBe(PAGE_CSP);
    }
  });
});
