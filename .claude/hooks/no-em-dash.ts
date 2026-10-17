/**
 * Claude Code hook: enforces the CLAUDE.md "No em dashes" rule.
 *
 * - PostToolUse (Write / Edit / MultiEdit): checks the file just written.
 * - Stop: checks lines ADDED in the working tree (`git diff` plus untracked
 *   files), which also catches edits made through Bash scripts that
 *   PostToolUse never sees.
 *
 * On a hit it exits 2 with the offending lines on stderr; Claude Code feeds
 * that back to the model so it fixes them. Anything unexpected (bad input,
 * no git) exits 0: a broken guard must never block work.
 */
import { existsSync, readFileSync } from "node:fs";

/** U+2014 (em) and U+2013 (en), written as escapes so this file passes its own check. */
const DASH = /[\u2014\u2013]/;

/** Third-party files rewritten on upgrade, plus the rule line that must name the character. */
const EXEMPT_PATHS = [".claude/skills/graphify/"];
const EXEMPT_LINE = /No em dashes/;

/** Subset of the hook input Claude Code sends on stdin. */
interface HookInput {
  hook_event_name?: string;
  stop_hook_active?: boolean;
  tool_input?: { file_path?: string };
}

/** Narrows the parsed stdin JSON without an unsafe cast. */
function isHookInput(value: unknown): value is HookInput {
  return typeof value === "object" && value !== null;
}

/** True when a path is exempt from the check. */
function isExempt(path: string): boolean {
  return EXEMPT_PATHS.some((p) => path.includes(p));
}

/** Returns "path:line: text" for each offending line. */
function scanLines(path: string, lines: Array<{ n: number; text: string }>): string[] {
  return lines
    .filter(({ text }) => DASH.test(text) && !EXEMPT_LINE.test(text))
    .map(({ n, text }) => `${path}:${n}: ${text.trim().slice(0, 140)}`);
}

/** PostToolUse: scan the whole file that was just written. */
function checkFile(path: string): string[] {
  if (isExempt(path) || !existsSync(path)) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }));
  return scanLines(path, lines);
}

/** Runs git and returns stdout, or "" if git fails. */
function git(args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString() : "";
}

/** Stop: scan only lines added since HEAD, plus whole untracked files. */
function checkWorkingTree(): string[] {
  const hits: string[] = [];
  let file = "";
  let lineNo = 0;
  for (const line of git(["diff", "-U0", "--no-color", "HEAD"]).split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.replace(/^\+\+\+ (b\/)?/, "");
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      lineNo = Number(hunk[1]);
      continue;
    }
    if (line.startsWith("+") && file && file !== "/dev/null" && !isExempt(file)) {
      hits.push(...scanLines(file, [{ n: lineNo, text: line.slice(1) }]));
      lineNo++;
    }
  }
  for (const path of git(["ls-files", "--others", "--exclude-standard"]).split("\n")) {
    if (path) hits.push(...checkFile(path));
  }
  return hits;
}

async function main(): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Bun.stdin.text());
  } catch {
    return;
  }
  if (!isHookInput(parsed)) return;

  let hits: string[] = [];
  if (parsed.hook_event_name === "Stop") {
    /** Already blocked once this turn: don't loop forever. */
    if (parsed.stop_hook_active) return;
    hits = checkWorkingTree();
  } else if (parsed.tool_input?.file_path) {
    hits = checkFile(parsed.tool_input.file_path);
  }

  if (hits.length > 0) {
    /** stderr is the hook's output channel: Claude Code shows it to the model on exit 2. */
    process.stderr.write(
      [
        "Em/en dashes found. CLAUDE.md forbids them: rewrite each with a comma, colon, or full stop (no hyphen substitute).",
        ...hits.slice(0, 20),
        hits.length > 20 ? `...and ${hits.length - 20} more` : "",
      ]
        .filter(Boolean)
        .join("\n") + "\n",
    );
    process.exit(2);
  }
}

await main();
