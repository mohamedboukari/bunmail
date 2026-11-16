/**
 * Local sandbox only: sends sample messages into BunMail's inbound SMTP
 * server so the inbound pages have realistic content to test against.
 *
 * Run with: bun run scripts/seed-inbound.ts [host] [port] [domain]
 * Defaults: 127.0.0.1 2525 sandbox.test (the domain must be registered).
 */
import { createTransport, type SendMailOptions } from "nodemailer";

const host = process.argv[2] ?? "127.0.0.1";
const port = Number(process.argv[3] ?? "2525");
const domain = process.argv[4] ?? "sandbox.test";

/** A 1x1 red PNG, small enough to inline. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** Smallest valid one-page PDF, enough for a viewer to open. */
const PDF = [
  "%PDF-1.4",
  "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
  "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj",
  "trailer<</Root 1 0 R>>",
  "%%EOF",
].join("\n");

const transport = createTransport({
  host,
  port,
  secure: false,
  ignoreTLS: true,
});

type Sample = SendMailOptions & { label: string };

const samples: Sample[] = [
  {
    label: "plain text only",
    from: "Alice <alice@example.org>",
    subject: "Plain text message",
    text: "Hi,\n\nJust plain text, no HTML.\n\nAlice",
  },
  {
    label: "styled HTML + text",
    from: "Newsletter <news@example.org>",
    subject: "Styled HTML newsletter",
    text: "This week: three updates. View in HTML for the full layout.",
    html: `<table width="100%" style="background:#f4f4f7;font-family:sans-serif">
  <tr><td align="center"><table width="560" style="background:#fff;padding:24px;border-radius:8px">
    <tr><td><h1 style="color:#333">This week</h1>
      <p style="color:#555;line-height:1.5">Three updates, a <a href="https://example.org/a">link</a>, and a button.</p>
      <a href="https://example.org/cta" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Read more</a>
    </td></tr></table></td></tr></table>`,
  },
  {
    label: "remote images",
    from: "Shop <shop@example.org>",
    subject: "HTML with remote images",
    html: `<p>Remote image below (should be blocked by default):</p>
<img src="https://picsum.photos/400/150" alt="remote banner" width="400" height="150">
<p>Tracking pixel: <img src="https://example.org/pixel.gif" width="1" height="1"></p>`,
  },
  {
    label: "inline cid image",
    from: "Bob <bob@example.org>",
    subject: "Inline CID image",
    html: `<p>Inline image via cid:</p><img src="cid:dot@seed" width="40" height="40">`,
    attachments: [
      { filename: "dot.png", content: PNG_BASE64, encoding: "base64", cid: "dot@seed" },
    ],
  },
  {
    label: "attachments (pdf, png, txt, csv)",
    from: "Carol <carol@example.org>",
    subject: "Invoice and files attached",
    text: "Attached: invoice PDF, a picture, notes and a CSV.",
    html: "<p>Attached: <b>invoice PDF</b>, a picture, notes and a CSV.</p>",
    attachments: [
      { filename: "invoice-2026-11.pdf", content: PDF, contentType: "application/pdf" },
      { filename: "photo.png", content: PNG_BASE64, encoding: "base64" },
      { filename: "notes.txt", content: "line one\nline two\n" },
      {
        filename: "report.csv",
        content: "name,amount\nalpha,10\nbeta,20\n",
        contentType: "text/csv",
      },
    ],
  },
  {
    label: "unicode + long subject",
    from: "Dörte Ünal <doerte@example.org>",
    subject:
      "Ünïcödé subject with emoji 🎉 and a very long tail that keeps going on and on",
    text: "Grüße aus Köln. 日本語のテキスト. Ελληνικά.",
    attachments: [{ filename: "résumé ✓.txt", content: "unicode filename" }],
  },
  {
    label: "risky HTML (script, form, iframe)",
    from: "Mallory <mallory@example.org>",
    subject: "HTML with script and form (preview must neutralise)",
    html: `<p>Script below must not run.</p><script>alert("xss")</script>
<form action="https://example.org/steal"><input name="pw" type="password"><button>Login</button></form>
<iframe src="https://example.org"></iframe>`,
  },
];

for (const sample of samples) {
  const { label, ...mail } = sample;
  try {
    const info = await transport.sendMail({ to: `inbox@${domain}`, ...mail });
    process.stdout.write(`ok    ${label}: ${info.response}\n`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(`fail  ${label}: ${message}\n`);
  }
}
