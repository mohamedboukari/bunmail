/**
 * No test listener on a fixed port (#443).
 *
 * Every listener a test starts binds port `0` and reads the real port back
 * (see `test/listen-port.ts`), so two test runs on one machine never
 * collide with EADDRINUSE. This test scans the test tree for a hard-coded
 * port and fails on one, so a fixed port cannot come back.
 *
 * Two rules, on source text (comments included, which is fine: a comment
 * naming a port is rare and easy to reword):
 *
 * 1. Everywhere under `test/`: a listener started on a literal port other
 *    than 0. `.listen(N`, `Bun.serve({ port: N })`, `Bun.listen({ port: N })`
 *    and a service's `.start(N)`.
 * 2. In the integration and e2e suites, the shared helpers and the
 *    fixtures (where the real servers run): any port-named constant, field
 *    or env var given a literal other than 0 (`const TEST_PORT = 12587`,
 *    `{ port: 12591 }`, `PORT: "4000"`). The unit suite is exempt from this
 *    one: its config tests parse port values (`port: 465`) that no server
 *    ever binds. A Postgres URL (`localhost:5432`) is not a port-named
 *    field, so it never matches.
 */
import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** The repository's `test/` directory. */
const TEST_ROOT = join(import.meta.dir, "..");

/** This file: its own samples below would match. */
const SELF = relative(TEST_ROOT, import.meta.path);

/** The source files the scan reads. */
const SOURCE = /\.(ts|tsx|mjs|js)$/;

/** Suites where rule 2 applies too: everything outside `test/unit/`. */
function strictScope(path: string): boolean {
  return !path.startsWith("unit/");
}

/**
 * Text rule 2 skips, each with why it is not a listener port. The match is
 * removed from the line before the rule runs.
 */
const ALLOWED: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\.\.\.realConfig\.config\.server, port: \d+/,
    reason: "a config stub for app.handle(): no HTTP server listens",
  },
  {
    pattern: /MIN_TEST_PORT = 10_000/,
    reason: "the lowest port a test listener may end up on, not a port",
  },
];

/** A literal port number: 1 or more, digit separators allowed. */
const NONZERO = String.raw`[1-9][\d_]*(?![\d_])`;

/** Rule 2: a port-named identifier (`port`, `fooPort`, `FOO_PORT`) set to a literal. */
const PORT_NAMED = new RegExp(
  String.raw`(?<![\w$])(port|[A-Za-z_$][\w$]*Port|(?:[A-Z][A-Z0-9]*_)*PORT)\s*[:=]\s*["'\x60]?(${NONZERO})`,
  "g",
);

/** Rule 1: the openings of a listener call whose arguments are checked. */
const LISTENER_CALL = /(Bun\.serve|Bun\.listen|\.listen)\(/g;

/** Rule 1: a service started on a literal port, `smtpSubmission.start(12587)`. */
const START_CALL = new RegExp(String.raw`\.start\(\s*(${NONZERO})\s*[,)]`, "g");

/** A port field inside a listener's options object. */
const PORT_FIELD = new RegExp(String.raw`(?<![\w$])port\s*:\s*(${NONZERO})`);

/** A literal port as the first argument of `.listen(`. */
const FIRST_ARG = new RegExp(String.raw`^\s*(${NONZERO})`);

/**
 * The text between the parenthesis at `open` and its match, or the rest of
 * the source when it never closes. Parentheses inside strings are rare in
 * listener calls; a miscount only widens the text that is checked.
 */
function argumentsAt(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

/** The 1-based line of `index` in `source`. */
function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

/**
 * Every fixed listener port in `source`, as `path:line: text` findings.
 *
 * @param path   - The file's path under `test/`, which picks the rules
 * @param source - The file's text
 */
function fixedPortFindings(path: string, source: string): string[] {
  const findings: string[] = [];
  const report = (index: number, what: string): void => {
    findings.push(`${path}:${lineOf(source, index)}: ${what}`);
  };

  /** Rule 1: listener calls. */
  for (const call of source.matchAll(LISTENER_CALL)) {
    const open = call.index + call[0].length - 1;
    const args = argumentsAt(source, open);
    const literal =
      (call[1] === ".listen" ? FIRST_ARG.exec(args) : null) ?? PORT_FIELD.exec(args);
    if (literal) report(call.index, `${call[1]}( on port ${literal[1]}`);
  }
  for (const call of source.matchAll(START_CALL)) {
    report(call.index, `.start(${call[1]})`);
  }

  /** Rule 2: port-named values, outside the unit suite. */
  if (strictScope(path)) {
    source.split("\n").forEach((raw, i) => {
      let line = raw;
      for (const { pattern } of ALLOWED) line = line.replace(pattern, "");
      for (const match of line.matchAll(PORT_NAMED)) {
        findings.push(`${path}:${i + 1}: ${match[1]} set to ${match[2]}`);
      }
    });
  }
  return findings;
}

/** Every source file under `test/`, as paths relative to it. */
function testSources(): string[] {
  return readdirSync(TEST_ROOT, { recursive: true, encoding: "utf8" })
    .filter((path) => SOURCE.test(path) && !path.includes("node_modules"))
    .map((path) => path.split("\\").join("/"))
    .filter((path) => path !== SELF);
}

describe("test listeners bind port 0 (#443)", () => {
  test("no fixed listener port anywhere under test/", () => {
    const sources = testSources();
    /** The scan must see the suites, or it proves nothing. */
    expect(sources.some((path) => path.startsWith("integration/"))).toBe(true);
    expect(sources.some((path) => path.startsWith("e2e/"))).toBe(true);
    const findings = sources.flatMap((path) =>
      fixedPortFindings(path, readFileSync(join(TEST_ROOT, path), "utf8")),
    );
    expect(findings).toEqual([]);
  });
});

describe("fixedPortFindings", () => {
  test("flags port constants, fields and env vars in the integration suite", () => {
    const flagged = [
      "const TEST_PORT = 12587;",
      "const INBOUND_PORT = 12_465;",
      "let submissionPort = 2525;",
      "Object.assign(config.smtp, { port: 12591 });",
      'env: { PORT: "4000" },',
      "createTransport({ host: '127.0.0.1', port: 587 })",
    ];
    for (const line of flagged) {
      expect(fixedPortFindings("integration/x.integration.test.ts", line)).toHaveLength(
        1,
      );
    }
  });

  test("flags a listener on a literal port anywhere, the unit suite included", () => {
    const flagged = [
      "server.listen(2525, () => {});",
      "Bun.serve({ hostname: '127.0.0.1', port: 8080, fetch() { return new Response(); } });",
      "Bun.listen({\n  hostname: '127.0.0.1',\n  port: 53,\n  socket: {},\n});",
      "smtpSubmission.start(12587);",
    ];
    for (const source of flagged) {
      expect(fixedPortFindings("unit/x.test.ts", source)).toHaveLength(1);
    }
  });

  test("passes port 0, ports read back, and numbers that are not listener ports", () => {
    const clean = [
      "let inboundPort = 0;",
      "Object.assign(config.smtp, { port: 0 });",
      "server.listen(0, '127.0.0.1', () => resolve());",
      "Bun.serve({ port: 0, fetch() { return new Response(); } });",
      "smtpSubmission.start(0);",
      "createTransport({ port: submissionPort });",
      "const url = 'postgres://user:pw@localhost:5432/bunmail_test';",
      "server: { ...realConfig.config.server, port: 3000, host: '0.0.0.0' },",
      "expect(summary).toMatchObject({ reports: 1, sent: 2 });",
      "const transport = createTransport({ streamTransport: true });",
    ];
    for (const source of clean) {
      expect(fixedPortFindings("integration/x.integration.test.ts", source)).toEqual([]);
    }
  });

  test("leaves the unit suite's config values alone (rule 2 only)", () => {
    expect(
      fixedPortFindings(
        "unit/x.test.ts",
        "expect(read({ port: '2587' }).port).toBe(2587);",
      ),
    ).toEqual([]);
  });
});
