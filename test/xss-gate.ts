/**
 * Dashboard XSS gate (`bun run lint:xss`), closing two blind spots of
 * `@kitajs/ts-html-plugin` 4.1.4's `xss-scan` (#229):
 *
 * 1. For a conditional expression `cond ? a : b` the scanner only checks
 *    `b` (`getNodeExpressions` returns `[whenFalse, whenFalse]`), so an
 *    unescaped value in the true branch passes. That is how the template
 *    variables XSS fixed in #227 got past CI. No fixed stable release
 *    exists (4.1.4 is the latest), so the installed copy is patched here,
 *    idempotently, before every scan. The patch fails loudly if the
 *    scanner source ever changes, rather than silently scanning less.
 * 2. The scanner only checks JSX children, never attribute values, and
 *    `@kitajs/html` escapes only `"` in attributes. A stored value inside
 *    an inline event handler (`onclick={...}`) can end the JavaScript
 *    string with a `'`.
 *
 * Since #255 (part 2) the pages run under `script-src 'self'`, so inline
 * code would not even run: every event-handler attribute (`onclick="..."`
 * as well as `onclick={...}`) and every inline `<script>` (one without
 * `src=`, other than a `type="application/json"` data block) is forbidden
 * under `src/pages`, and so is the Tailwind CDN. Behaviour goes in
 * `src/pages/assets/dashboard.js`, wired by a `data-` attribute.
 *
 * Fails closed: `xss-scan` exits 0 even when it crashes, so the run only
 * passes when the scanner printed its success sentinel and the attribute
 * sweep found nothing.
 */
/* oxlint-disable no-console -- standalone lint gate: console IS its output, and the app logger pulls in config */
import { join } from "path";

const TOOLCHAIN = join(import.meta.dir, "..", "node_modules", ".cache", "xss-toolchain");
const SCANNER_UTIL = join(
  TOOLCHAIN,
  "node_modules",
  "@kitajs",
  "ts-html-plugin",
  "dist",
  "util.js",
);
const SCANNER_BIN = join(TOOLCHAIN, "node_modules", ".bin", "xss-scan");
const PAGES_DIR = join(import.meta.dir, "..", "src", "pages");

const UNPATCHED = "return [node.whenFalse, node.whenFalse];";
const PATCHED = "return [node.whenTrue, node.whenFalse];";

/** A JSX event-handler attribute: `onclick="`, `onsubmit={`, ... */
const HANDLER_RE = /\son[a-z]+=["'{]/;

/** An inline `<script>`: no `src=`, and not a `type="application/json"` data block. */
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[\s>]/;

/** The Tailwind Play CDN host the pages loaded before #255 (a plain substring check). */
const TAILWIND_CDN_HOST = "cdn.tailwindcss.com";

let failed = false;
function fail(message: string): void {
  failed = true;
  console.error(`xss-gate: ${message}`);
}

/** Makes the scanner check both branches of a conditional expression. */
async function patchScanner(): Promise<void> {
  const file = Bun.file(SCANNER_UTIL);
  if (!(await file.exists())) {
    fail(`scanner not found at ${SCANNER_UTIL}; run \`bun run xss:toolchain\``);
    return;
  }
  const source = await file.text();
  if (source.includes(PATCHED)) return;
  if (!source.includes(UNPATCHED)) {
    fail("scanner source changed: the ternary patch no longer applies, re-check #229");
    return;
  }
  await Bun.write(SCANNER_UTIL, source.replace(UNPATCHED, PATCHED));
  console.info("xss-gate: patched the scanner to check both branches of conditionals");
}

/** Runs `xss-scan` and requires its success sentinel. */
function runScanner(): void {
  const result = Bun.spawnSync([SCANNER_BIN], { stdout: "pipe", stderr: "pipe" });
  const output = result.stdout.toString() + result.stderr.toString();
  process.stdout.write(output);
  if (!output.includes("No XSS vulnerabilities found")) {
    fail("xss-scan did not report success");
  }
}

/** Rejects event-handler attributes, inline scripts and the Tailwind CDN under src/pages. */
async function sweepInlineCode(): Promise<void> {
  const rules: Array<[(line: string) => boolean, string]> = [
    [
      (line) => HANDLER_RE.test(line),
      "event-handler attribute; wire it in assets/dashboard.js with a data- attribute",
    ],
    [
      (line) => INLINE_SCRIPT_RE.test(line),
      "inline <script>; the CSP only runs /dashboard/assets/dashboard.js",
    ],
    [
      (line) => line.includes(TAILWIND_CDN_HOST),
      "Tailwind CDN; the pages use the self-hosted dashboard.css",
    ],
  ];
  for await (const relative of new Bun.Glob("**/*.{ts,tsx}").scan(PAGES_DIR)) {
    const lines = (await Bun.file(join(PAGES_DIR, relative)).text()).split("\n");
    lines.forEach((line, index) => {
      for (const [matches, why] of rules) {
        if (matches(line)) fail(`src/pages/${relative}:${index + 1}: ${why}`);
      }
    });
  }
}

await patchScanner();
if (!failed) runScanner();
await sweepInlineCode();

if (failed) process.exit(1);
console.info(
  "xss-gate: ok (scanner clean, no inline handlers or scripts under src/pages)",
);
