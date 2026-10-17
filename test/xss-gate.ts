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
 *    string with a `'`. Dynamic event-handler attributes are therefore
 *    forbidden under `src/pages`: use static text, or a `data-` attribute
 *    read by a static script.
 *
 * Fails closed: `xss-scan` exits 0 even when it crashes, so the run only
 * passes when the scanner printed its success sentinel and the attribute
 * sweep found nothing.
 */
/* oxlint-disable no-console -- standalone lint gate: console IS its output, and the app logger pulls in config */
import { join } from "path";

const TOOLCHAIN = join(import.meta.dir, "..", "node_modules", ".cache", "xss-toolchain");
const SCANNER_UTIL = join(TOOLCHAIN, "node_modules", "@kitajs", "ts-html-plugin", "dist", "util.js");
const SCANNER_BIN = join(TOOLCHAIN, "node_modules", ".bin", "xss-scan");
const PAGES_DIR = join(import.meta.dir, "..", "src", "pages");

const UNPATCHED = "return [node.whenFalse, node.whenFalse];";
const PATCHED = "return [node.whenTrue, node.whenFalse];";

/** A dynamic JSX event-handler attribute: `onclick={`, `onsubmit={`, ... */
const DYNAMIC_HANDLER_RE = /\bon[a-z]+=\{/;

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

/** Rejects dynamic event-handler attributes under src/pages. */
async function sweepEventHandlers(): Promise<void> {
  const hits: string[] = [];
  for await (const relative of new Bun.Glob("**/*.tsx").scan(PAGES_DIR)) {
    const lines = (await Bun.file(join(PAGES_DIR, relative)).text()).split("\n");
    lines.forEach((line, index) => {
      if (DYNAMIC_HANDLER_RE.test(line)) hits.push(`src/pages/${relative}:${index + 1}`);
    });
  }
  for (const hit of hits) {
    fail(`${hit}: dynamic event-handler attribute; attribute escaping does not cover quotes`);
  }
}

await patchScanner();
if (!failed) runScanner();
await sweepEventHandlers();

if (failed) process.exit(1);
console.info("xss-gate: ok (scanner clean, no dynamic event handlers under src/pages)");
