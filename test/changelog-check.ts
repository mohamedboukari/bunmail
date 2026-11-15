/**
 * `bun run changelog:check <base-ref>` (#442): the CI gate that a PR
 * carries its changelog entry.
 *
 * Compares `<base-ref>...HEAD` and fails (exit 1) when the PR changes
 * `src/`, `drizzle/`, `Dockerfile`, `docker-compose*.yml` or
 * `.env.example` without adding a fragment under `docs/changes/` (or
 * changing `CHANGELOG.md`, for a release PR), unless the `skip-changelog`
 * label is set. Every fragment the PR adds must also be valid, label or
 * not. The rules live in `checkChangelogEntry` (`test/changelog-fragments.ts`).
 *
 * The PR's labels come from the `PR_LABELS` environment variable, one per
 * line. CI fills it from the GitHub API at run time rather than from the
 * event payload, so re-running the job after adding the label sees it.
 *
 * Locally: `bun run changelog:check origin/main`.
 */
/* oxlint-disable no-console -- standalone repo script: console IS its output, and the app logger pulls in config */
import { readFileSync } from "fs";
import { join } from "path";

import { checkChangelogEntry, parseNameStatus } from "./changelog-fragments.ts";

/** The repository root (this file lives in `test/`). */
const ROOT = join(import.meta.dir, "..");

/** Run git in the repo root and return its stdout, or exit on failure. */
function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    console.error(`git ${args.join(" ")} failed:\n${result.stderr.toString()}`);
    process.exit(1);
  }
  return result.stdout.toString();
}

/** Parse the arguments, diff against the base and print the verdict. */
function main(argv: readonly string[]): number {
  const base = argv[0];
  // A ref starting with "-" would be read by git as an option.
  if (argv.length !== 1 || base === undefined || base === "" || base.startsWith("-")) {
    console.error("Usage: bun run changelog:check <base-ref>   (e.g. origin/main)");
    return 1;
  }
  const files = parseNameStatus(
    git(["diff", "--name-status", "--no-renames", "-z", `${base}...HEAD`]),
  );
  const labels = (process.env["PR_LABELS"] ?? "")
    .split("\n")
    .map((label) => label.trim())
    .filter((label) => label !== "");
  const result = checkChangelogEntry(files, labels, (path) =>
    readFileSync(join(ROOT, path), "utf8"),
  );
  for (const message of result.messages) {
    if (result.ok) console.info(message);
    else console.error(message);
  }
  return result.ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
