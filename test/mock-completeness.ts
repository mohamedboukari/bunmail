/**
 * Mock completeness gate (`bun run lint:mocks`, #293).
 *
 * Bun's `mock.module` is process-wide: a mock registered by one test file
 * stays in place for every file that runs after it. A factory that omits
 * an export of its target leaves that export `undefined` for whichever
 * file imports the module next, so a test breaks or passes depending on
 * file order, which differs between macOS and CI Linux.
 *
 * This script reads every `mock.module("<spec>", factory)` under `test/`
 * and fails when the factory's object does not cover every runtime export
 * of the target:
 *
 * - The target's exports come from `Bun.Transpiler#scan` for a relative
 *   spec (type-only exports are erased, `export * from` is followed), and
 *   from the loaded namespace for a package or builtin (`dns/promises`).
 * - The factory must be an arrow returning an object literal, written
 *   inline or bound to a `const` in the same file. Keys may be plain,
 *   quoted, shorthand, methods or accessors. `...name` counts as every
 *   export when `name` is a namespace of the same target (`import * as
 *   name from` or `await import(...)`).
 * - Anything else (a computed key, a block body, a spread of something
 *   else) fails rather than passing unchecked, unless the `mock.module`
 *   line or the line above it carries `// mock-completeness: ignore
 *   <reason>`.
 *
 * Dependency-free: a small scanner that skips strings, template literals,
 * comments and regex literals, enough for the factories in this repo.
 */
/* oxlint-disable no-console -- standalone lint gate: console IS its output, and the app logger pulls in config */
import { dirname, isAbsolute, join, relative, resolve } from "path";

const ROOT = join(import.meta.dir, "..");
const TEST_DIR = join(ROOT, "test");
const SELF = import.meta.path;

/** The opt-out marker; a reason after `ignore` is required. */
const IGNORE_RE = /\/\/\s*mock-completeness:\s*ignore\s+\S/;

/** `export * from "x"` (not `export * as ns from`, which scan reports as a name). */
const EXPORT_STAR_RE = /export\s*\*\s*from\s*["']([^"']+)["']/g;

/** Characters after which a `/` starts a regex literal, not a division. */
const REGEX_PREFIX = new Set("(,=:[!&|?{};".split(""));

/** A `mock.module(` call, not a member of something else. */
const CALL_RE = /(?<![\w$.])mock\.module\(/g;
/** An identifier at the start of a string; `WHOLE_IDENT_RE`, the whole string. */
const IDENT_RE = /^[A-Za-z_$][\w$]*/;
const WHOLE_IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** One problem found in a test file. */
interface Finding {
  file: string;
  line: number;
  message: string;
}

/** Thrown when the scanner meets syntax it does not model. */
class ParseError extends Error {}

/* ─── Scanner ─── */

/** Index just past the string or template literal opening at `i`. */
function skipString(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === quote) return j + 1;
    if (quote === "`" && ch === "$" && src[j + 1] === "{") {
      j = skipBalanced(src, j + 1);
      continue;
    }
    j++;
  }
  throw new ParseError("unterminated string");
}

/** Index just past the comment opening at `i`, or `i` when there is none. */
function skipComment(src: string, i: number): number {
  if (src[i] !== "/") return i;
  if (src[i + 1] === "/") {
    const end = src.indexOf("\n", i);
    return end < 0 ? src.length : end;
  }
  if (src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2);
    if (end < 0) throw new ParseError("unterminated comment");
    return end + 2;
  }
  return i;
}

/** Index just past the regex literal opening at `i`, flags included. */
function skipRegex(src: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < src.length && src[j] !== "\n") {
    const ch = src[j];
    if (ch === "\\") {
      j += 2;
      continue;
    }
    if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      j++;
      while (j < src.length && /[a-z]/.test(src[j] ?? "")) j++;
      return j;
    }
    j++;
  }
  throw new ParseError("unterminated regex literal");
}

/** Index of the first non-whitespace, non-comment character at or after `i`. */
function skipTrivia(src: string, i: number): number {
  let j = i;
  while (j < src.length) {
    if (/\s/.test(src[j] ?? "")) {
      j++;
      continue;
    }
    const after = skipComment(src, j);
    if (after === j) return j;
    j = after;
  }
  return j;
}

/**
 * Walks code from `start` to `end`, skipping strings, comments, regex
 * literals and nested brackets, and calls `visit` on every character at
 * bracket depth 0. `visit` returns true to stop; the index is returned.
 */
function walk(
  src: string,
  start: number,
  end: number,
  visit: (index: number, char: string) => boolean,
): number {
  let depth = 0;
  let prev = "";
  let i = start;
  while (i < end) {
    const ch = src[i] ?? "";
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      prev = ch;
      continue;
    }
    if (ch === "/") {
      const after = skipComment(src, i);
      if (after !== i) {
        i = after;
        continue;
      }
      if (prev === "" || REGEX_PREFIX.has(prev)) {
        i = skipRegex(src, i);
        prev = "/";
        continue;
      }
    }
    if (depth === 0 && visit(i, ch)) return i;
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (depth < 0) return i;
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return i;
}

/** Index just past the bracket pair opening at `i`. */
function skipBalanced(src: string, i: number): number {
  const close = walk(src, i + 1, src.length, () => false);
  if (close >= src.length) throw new ParseError("unbalanced brackets");
  return close + 1;
}

/** `[start, end)` ranges of the comma-separated items between `start` and `end`. */
function splitTopLevel(src: string, start: number, end: number): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let from = start;
  walk(src, start, end, (index, ch) => {
    if (ch === ",") {
      parts.push([from, index]);
      from = index + 1;
    }
    return false;
  });
  parts.push([from, end]);
  return parts.filter(([s, e]) => skipTrivia(src, s) < e);
}

/** Reads a string literal at `i`: its value and the index after it. */
function readStringLiteral(src: string, i: number): { value: string; end: number } {
  const quote = src[i];
  if (quote !== '"' && quote !== "'") throw new ParseError("expected a string literal");
  const end = skipString(src, i);
  return { value: src.slice(i + 1, end - 1), end };
}

/* ─── Factories ─── */

/** What a factory's object literal covers. */
interface FactoryKeys {
  keys: Set<string>;
  /** Identifiers spread into the object (`...name`). */
  spreads: string[];
}

/** Reads the keys of the object literal whose `{` is at `open`. */
function readObjectKeys(src: string, open: number): FactoryKeys {
  const close = skipBalanced(src, open) - 1;
  const keys = new Set<string>();
  const spreads: string[] = [];
  for (const [s, e] of splitTopLevel(src, open + 1, close)) {
    let i = skipTrivia(src, s);
    if (src.startsWith("...", i)) {
      const name = src.slice(i + 3, e).trim();
      if (!WHOLE_IDENT_RE.test(name)) {
        throw new ParseError(`cannot follow the spread \`...${name}\``);
      }
      spreads.push(name);
      continue;
    }
    let key: string;
    if (src[i] === '"' || src[i] === "'") {
      const literal = readStringLiteral(src, i);
      key = literal.value;
      i = literal.end;
    } else {
      const ident = IDENT_RE.exec(src.slice(i, e))?.[0];
      if (!ident) throw new ParseError("unsupported key (computed or numeric)");
      i += ident.length;
      key = ident;
      /** `get name()`, `set name(v)`, `async name()`: the name follows. */
      const next = skipTrivia(src, i);
      const modified = IDENT_RE.exec(src.slice(next, e))?.[0];
      if ((ident === "get" || ident === "set" || ident === "async") && modified) {
        key = modified;
        i = next + modified.length;
      }
    }
    const after = skipTrivia(src, i);
    if (after < e && src[after] !== ":" && src[after] !== "(") {
      throw new ParseError(`cannot read the entry for \`${key}\``);
    }
    keys.add(key);
  }
  return { keys, spreads };
}

/**
 * Reads the factory expression at `i`: an arrow returning an object
 * literal, or the name of a `const` bound to one in the same file.
 */
function readFactory(src: string, i: number): FactoryKeys {
  let j = skipTrivia(src, i);
  const ident = IDENT_RE.exec(src.slice(j))?.[0];
  if (ident && ident !== "async") {
    const binding = new RegExp(`(?:const|let)\\s+${ident}\\b[^=]*=`).exec(src);
    if (!binding) throw new ParseError(`cannot find the factory \`${ident}\``);
    return readFactory(src, binding.index + binding[0].length);
  }
  if (ident === "async") j = skipTrivia(src, j + ident.length);
  if (src[j] !== "(") throw new ParseError("the factory is not an arrow function");
  j = skipTrivia(src, skipBalanced(src, j));
  /** Skip a return type annotation (`(): Record<string, unknown> =>`). */
  if (src[j] === ":") j = src.indexOf("=>", j);
  if (j < 0 || !src.startsWith("=>", j)) {
    throw new ParseError("the factory is not an arrow function");
  }
  j = skipTrivia(src, j + 2);
  if (src[j] !== "(")
    throw new ParseError("the factory does not return an object literal");
  j = skipTrivia(src, j + 1);
  if (src[j] !== "{")
    throw new ParseError("the factory does not return an object literal");
  return readObjectKeys(src, j);
}

/* ─── Targets ─── */

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};
const exportCache = new Map<string, string[]>();

/** Runtime export names of `target` (an absolute path or a bare specifier). */
async function exportsOf(target: string): Promise<string[]> {
  const cached = exportCache.get(target);
  if (cached) return cached;
  let names: string[];
  if (isAbsolute(target)) {
    const source = await Bun.file(target).text();
    const transpiler = target.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
    names = [...transpiler.scan(source).exports];
    for (const match of source.matchAll(EXPORT_STAR_RE)) {
      const from = resolveTarget(target, match[1] ?? "");
      names.push(...(await exportsOf(from)).filter((name) => name !== "default"));
    }
  } else {
    /** A package or builtin: loading it is side-effect free for the ones mocked here. */
    const namespace: unknown = await import(target);
    names =
      typeof namespace === "object" && namespace !== null ? Object.keys(namespace) : [];
  }
  exportCache.set(target, names);
  return names;
}

/** Absolute path for a relative spec, the spec itself for a bare one. */
function resolveTarget(fromFile: string, spec: string): string {
  return spec.startsWith(".") ? resolve(dirname(fromFile), spec) : spec;
}

/** Identifiers bound to a whole module namespace in `src`, by target. */
function namespaceBindings(file: string, src: string): Map<string, string> {
  const bindings = new Map<string, string>();
  const patterns = [
    /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g,
    /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of src.matchAll(pattern)) {
      bindings.set(match[1] ?? "", resolveTarget(file, match[2] ?? ""));
    }
  }
  return bindings;
}

/* ─── Main ─── */

/** 1-based line number of `index` in `src`. */
function lineOf(src: string, index: number): number {
  return src.slice(0, index).split("\n").length;
}

/** Checks every `mock.module` call in one test file. */
async function checkFile(file: string, findings: Finding[]): Promise<number> {
  const src = await Bun.file(file).text();
  const lines = src.split("\n");
  const shown = relative(ROOT, file);
  const bindings = namespaceBindings(file, src);
  let count = 0;

  /**
   * Find the calls with a plain search, dropping lines that are comments.
   * Scanning the whole file would have to tell JSX and divisions from
   * regex literals; the factories themselves are plain code.
   */
  const calls: number[] = [];
  for (const match of src.matchAll(CALL_RE)) {
    const text = (lines[lineOf(src, match.index) - 1] ?? "").trim();
    if (!text.startsWith("//") && !text.startsWith("*") && !text.startsWith("/*")) {
      calls.push(match.index);
    }
  }

  for (const at of calls) {
    count++;
    const line = lineOf(src, at);
    const ignored =
      IGNORE_RE.test(lines[line - 1] ?? "") || IGNORE_RE.test(lines[line - 2] ?? "");
    try {
      const spec = readStringLiteral(src, skipTrivia(src, at + "mock.module(".length));
      const comma = skipTrivia(src, spec.end);
      if (src[comma] !== ",") throw new ParseError("expected a factory argument");
      const target = resolveTarget(file, spec.value);
      if (isAbsolute(target) && !(await Bun.file(target).exists())) {
        throw new ParseError(`cannot resolve "${spec.value}"`);
      }
      const factory = readFactory(src, comma + 1);
      for (const name of factory.spreads) {
        if (bindings.get(name) !== target) {
          throw new ParseError(`\`...${name}\` is not a namespace of "${spec.value}"`);
        }
      }
      if (factory.spreads.length > 0 || ignored) continue;
      const missing = (await exportsOf(target)).filter((name) => !factory.keys.has(name));
      if (missing.length > 0) {
        findings.push({
          file: shown,
          line,
          message: `mock.module("${spec.value}") is missing: ${missing.join(", ")}`,
        });
      }
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      if (ignored) continue;
      findings.push({
        file: shown,
        line,
        message: `cannot check this mock.module: ${error.message} (add \`// mock-completeness: ignore <reason>\` if intended)`,
      });
    }
  }
  return count;
}

const findings: Finding[] = [];
let calls = 0;
let files = 0;
for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan(TEST_DIR)) {
  const file = join(TEST_DIR, path);
  if (file === SELF) continue;
  const found = await checkFile(file, findings);
  calls += found;
  if (found > 0) files++;
}

for (const finding of findings) {
  console.error(`mock-completeness: ${finding.file}:${finding.line}: ${finding.message}`);
}
if (findings.length > 0) {
  console.error(`mock-completeness: ${findings.length} incomplete or unreadable mock(s)`);
  process.exit(1);
}
console.info(
  `mock-completeness: ok (${calls} mock.module calls in ${files} files cover every export)`,
);
