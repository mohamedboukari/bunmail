/**
 * Changelog fragments (#442): the shared logic behind
 * `bun run changelog:collect` and `bun run changelog:check`.
 *
 * Every PR used to add its entry right under `## [Unreleased]` in
 * `CHANGELOG.md`, so two PRs built in parallel always conflicted there.
 * Instead, each PR now adds its own file under `docs/changes/`:
 *
 *   docs/changes/<issue>.<type>.md          one entry
 *   docs/changes/<issue>.<type>.<slug>.md   another entry for the same issue
 *
 * `<type>` is a Keep a Changelog section (`added`, `changed`, `deprecated`,
 * `removed`, `fixed`, `security`) and the file holds the bullet exactly as
 * it should appear in `CHANGELOG.md`. Two PRs never write the same file,
 * so they never conflict.
 *
 * This module is dependency-free and does no process-level I/O of its own
 * beyond the paths it is given, so the unit tests drive it against a
 * temporary directory (`test/unit/changelog-fragments.test.ts`).
 */
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

/** The fragment types, in the order their sections appear in a release. */
export const FRAGMENT_TYPES = [
  "added",
  "changed",
  "deprecated",
  "removed",
  "fixed",
  "security",
] as const;

/** One Keep a Changelog section, as written in a fragment's file name. */
export type FragmentType = (typeof FRAGMENT_TYPES)[number];

/**
 * The `### <Title>` heading of each type. The order of `FRAGMENT_TYPES`
 * matches the sections of every release in `CHANGELOG.md` (Added, Changed,
 * Fixed, Security), with Keep a Changelog's Deprecated and Removed slotted
 * where the spec puts them.
 */
const SECTION_TITLES: Record<FragmentType, string> = {
  added: "Added",
  changed: "Changed",
  deprecated: "Deprecated",
  removed: "Removed",
  fixed: "Fixed",
  security: "Security",
};

/** The file in `docs/changes/` that explains the folder; never a fragment. */
export const FRAGMENTS_README = "README.md";

/** Finder's folder metadata; gitignored, so it is skipped rather than refused. */
const IGNORED_FILES = new Set([".DS_Store"]);

/**
 * `<issue>.<type>.md` or `<issue>.<type>.<slug>.md`. The issue number has
 * no leading zero, and the slug is lowercase letters and digits joined by
 * single hyphens (`2`, `api`, `upgrade-note`).
 */
const FRAGMENT_NAME_RE =
  /^([1-9]\d*)\.(added|changed|deprecated|removed|fixed|security)(?:\.([a-z0-9]+(?:-[a-z0-9]+)*))?\.md$/;

/** A release version as `bun pm version` writes it: `0.13.0`, `1.0.0-rc.1`. */
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** A `YYYY-MM-DD` date for the version heading. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The heading every changelog must carry. */
const UNRELEASED_HEADING = "## [Unreleased]";

/** A Markdown heading at the start of a line (would break the section layout). */
const HEADING_LINE_RE = /^#{1,6}(?:\s|$)/;

/** Thrown for anything the scripts refuse; the CLI prints its message and exits 1. */
export class ChangelogError extends Error {
  override name = "ChangelogError";
}

/** What a fragment's file name says about it. */
interface FragmentName {
  issue: number;
  type: FragmentType;
  /** The optional suffix that lets one issue have several fragments. */
  slug: string | null;
}

/** One fragment read from disk, its body validated and normalized. */
export interface Fragment extends FragmentName {
  fileName: string;
  /** The bullet (one or more lines, no trailing newline). */
  body: string;
}

/** Type guard from a matched string to the `FragmentType` union. */
function isFragmentType(value: string): value is FragmentType {
  return FRAGMENT_TYPES.some((type) => type === value);
}

/**
 * Parse a fragment file name, or return `null` when it does not follow
 * `<issue>.<type>[.<slug>].md`.
 */
export function parseFragmentName(fileName: string): FragmentName | null {
  const match = FRAGMENT_NAME_RE.exec(fileName);
  if (!match) return null;
  const [, issue, type, slug] = match;
  if (issue === undefined || type === undefined || !isFragmentType(type)) return null;
  return { issue: Number(issue), type, slug: slug ?? null };
}

/** The message for a file name that is not a fragment. */
function badNameMessage(fileName: string): string {
  return (
    `docs/changes/${fileName}: not a valid fragment name. ` +
    `Use <issue>.<type>.md or <issue>.<type>.<slug>.md, where <type> is one of ` +
    `${FRAGMENT_TYPES.join(", ")} and <slug> is lowercase letters, digits and hyphens.`
  );
}

/**
 * Validate a fragment's raw content and return the bullet to insert.
 *
 * CRLF becomes LF, and leading and trailing blank lines are dropped. The
 * rest is kept byte for byte, but it must read as list items in a
 * `### <Type>` subsection: it starts with `- `, has no blank line inside
 * (the changelog's lists are tight) and no Markdown heading.
 *
 * @throws ChangelogError naming the file and the rule it breaks.
 */
export function normalizeFragmentBody(fileName: string, raw: string): string {
  const where = `docs/changes/${fileName}`;
  const body = raw
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  if (body === "") {
    throw new ChangelogError(`${where}: the fragment is empty.`);
  }
  if (!body.startsWith("- ")) {
    throw new ChangelogError(
      `${where}: a fragment must start with "- " (the bullet as it appears in CHANGELOG.md).`,
    );
  }
  for (const line of body.split("\n")) {
    if (line.trim() === "") {
      throw new ChangelogError(
        `${where}: blank line inside the fragment; CHANGELOG.md lists have no blank lines between items.`,
      );
    }
    if (HEADING_LINE_RE.test(line)) {
      throw new ChangelogError(
        `${where}: headings are not allowed in a fragment; the type in the file name picks the section.`,
      );
    }
  }
  return body;
}

/**
 * Compare two slugs: no slug first, two numeric slugs by value (so `2`
 * sorts before `10`), anything else by code point. Locale-independent, so
 * the order is the same on every machine.
 */
function compareSlugs(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return Number(a) - Number(b);
  return a < b ? -1 : 1;
}

/** Fragments in collection order: issue number, then slug. */
export function sortFragments(fragments: readonly Fragment[]): Fragment[] {
  return fragments.toSorted((a, b) => a.issue - b.issue || compareSlugs(a.slug, b.slug));
}

/**
 * Read and validate every fragment in `dir`, sorted (issue, then slug).
 *
 * `README.md` and `.DS_Store` are skipped. Anything else that is not a
 * valid fragment (a bad name, a subfolder, an empty or malformed body)
 * fails the whole read, listing every problem at once, so nothing is
 * collected from a half-valid folder.
 *
 * @throws ChangelogError listing every invalid entry.
 */
export function readFragments(dir: string): Fragment[] {
  const problems: string[] = [];
  const fragments: Fragment[] = [];
  const entries = readdirSync(dir, { withFileTypes: true }).toSorted((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
  for (const entry of entries) {
    if (entry.name === FRAGMENTS_README || IGNORED_FILES.has(entry.name)) continue;
    const parsed = entry.isFile() ? parseFragmentName(entry.name) : null;
    if (!parsed) {
      problems.push(badNameMessage(entry.name));
      continue;
    }
    try {
      const body = normalizeFragmentBody(
        entry.name,
        readFileSync(join(dir, entry.name), "utf8"),
      );
      fragments.push({ ...parsed, fileName: entry.name, body });
    } catch (error) {
      if (!(error instanceof ChangelogError)) throw error;
      problems.push(error.message);
    }
  }
  if (problems.length > 0) {
    throw new ChangelogError(problems.join("\n"));
  }
  return sortFragments(fragments);
}

/* ─── Writing into CHANGELOG.md ─── */

/** True for a line with nothing but whitespace. */
function isBlank(line: string | undefined): boolean {
  return line === undefined || line.trim() === "";
}

/** Index of the next line at or after `from` that starts a `## ` section, or `lines.length`. */
function sectionEnd(lines: readonly string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i]?.startsWith("## ")) return i;
  }
  return lines.length;
}

/** Index of the `## [Unreleased]` heading. */
function findUnreleased(lines: readonly string[]): number {
  const index = lines.findIndex((line) => line.trimEnd() === UNRELEASED_HEADING);
  if (index === -1) {
    throw new ChangelogError(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading.`);
  }
  return index;
}

/** The rank of a `### <Title>` heading in `FRAGMENT_TYPES`, or -1 for any other heading. */
function headingRank(line: string): number {
  if (!line.startsWith("### ")) return -1;
  const title = line.slice(4).trimEnd();
  return FRAGMENT_TYPES.findIndex((type) => SECTION_TITLES[type] === title);
}

/**
 * Insert `block` at `at`, adding a blank line before it and after it
 * where the neighbouring line is not already blank, so a new subsection
 * is always separated the way the rest of the changelog is.
 */
function insertSeparated(lines: string[], at: number, block: readonly string[]): void {
  const before = at > 0 && !isBlank(lines[at - 1]) ? [""] : [];
  const after = at < lines.length && !isBlank(lines[at]) ? [""] : [];
  lines.splice(at, 0, ...before, ...block, ...after);
}

/**
 * Add one type's bullets to the `[Unreleased]` section starting at
 * `unreleased`.
 *
 * - An existing `### <Type>` subsection (the first one, if a merge left
 *   two) gets them after its last entry, keeping the existing entries.
 * - Otherwise a new subsection is inserted before the first known
 *   subsection that comes later in `FRAGMENT_TYPES`, or at the end of the
 *   section. Unknown headings (such as `### Upgrade guide`) stay put.
 */
function addToUnreleased(
  lines: string[],
  unreleased: number,
  type: FragmentType,
  bullets: readonly string[],
): void {
  const end = sectionEnd(lines, unreleased + 1);
  const heading = `### ${SECTION_TITLES[type]}`;
  const rank = FRAGMENT_TYPES.indexOf(type);

  const existing = lines.findIndex(
    (line, i) => i > unreleased && i < end && line.trimEnd() === heading,
  );
  if (existing !== -1) {
    // The subsection runs to the next heading of either level.
    let subEnd = existing + 1;
    while (subEnd < end && !lines[subEnd]?.startsWith("### ")) subEnd++;
    let last = subEnd - 1;
    while (last > existing && isBlank(lines[last])) last--;
    if (last === existing) {
      // An empty subsection: keep the blank line under the heading if there
      // is one, and let insertSeparated add whichever blank is missing.
      const at =
        existing + 1 < subEnd && isBlank(lines[existing + 1])
          ? existing + 2
          : existing + 1;
      insertSeparated(lines, at, bullets);
      return;
    }
    lines.splice(last + 1, 0, ...bullets);
    return;
  }

  const block = [heading, "", ...bullets];
  const later = lines.findIndex(
    (line, i) => i > unreleased && i < end && headingRank(line) > rank,
  );
  if (later !== -1) {
    insertSeparated(lines, later, block);
    return;
  }
  let last = end - 1;
  while (last > unreleased && isBlank(lines[last])) last--;
  insertSeparated(lines, last + 1, block);
}

/** Options for `applyFragments`. */
export interface ApplyOptions {
  /** Cut a release: move `[Unreleased]` under `## [<version>] - <date>`. */
  version?: string;
  /** The release date, `YYYY-MM-DD`; required with `version`. */
  date?: string;
}

/**
 * Return `changelog` with `fragments` written under `## [Unreleased]`,
 * grouped by type in `FRAGMENT_TYPES` order and, within a type, in the
 * order given (callers pass `sortFragments` output).
 *
 * With `version`, the resulting `[Unreleased]` section (the entries
 * already there plus the fragments) becomes `## [<version>] - <date>`,
 * under a fresh empty `## [Unreleased]`. Nothing outside the
 * `[Unreleased]` section is touched, and existing lines are never
 * rewritten, only added to.
 *
 * @throws ChangelogError when there is no `[Unreleased]` heading, the
 *   version or date is malformed, the version already has a section, or
 *   a release would be empty.
 */
export function applyFragments(
  changelog: string,
  fragments: readonly Fragment[],
  options: ApplyOptions = {},
): string {
  const lines = changelog.split("\n");
  const unreleased = findUnreleased(lines);

  for (const type of FRAGMENT_TYPES) {
    const bullets = fragments
      .filter((f) => f.type === type)
      .flatMap((f) => f.body.split("\n"));
    if (bullets.length > 0) addToUnreleased(lines, unreleased, type, bullets);
  }

  const { version, date } = options;
  if (version === undefined) return lines.join("\n");

  if (!VERSION_RE.test(version)) {
    throw new ChangelogError(
      `"${version}" is not a release version (expected X.Y.Z, without a leading "v").`,
    );
  }
  if (date === undefined || !DATE_RE.test(date)) {
    throw new ChangelogError(`"${date ?? ""}" is not a YYYY-MM-DD date.`);
  }
  if (lines.some((line) => line.startsWith(`## [${version}]`))) {
    throw new ChangelogError(`CHANGELOG.md already has a [${version}] section.`);
  }
  const end = sectionEnd(lines, unreleased + 1);
  if (lines.slice(unreleased + 1, end).every((line) => isBlank(line))) {
    throw new ChangelogError(
      `Nothing to release: [Unreleased] is empty and docs/changes/ has no fragments.`,
    );
  }
  lines.splice(unreleased, 1, UNRELEASED_HEADING, "", `## [${version}] - ${date}`);
  return lines.join("\n");
}

/** Today's date in UTC, `YYYY-MM-DD`. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Inputs of `collectChangelog`. */
export interface CollectOptions {
  /** The fragments folder (`docs/changes/`). */
  changesDir: string;
  /** The changelog to write (`CHANGELOG.md`). */
  changelogPath: string;
  /** Cut this release instead of filling `[Unreleased]`. */
  version?: string;
  /** The release date; defaults to today in UTC. */
  date?: string;
}

/** What `collectChangelog` did. */
export interface CollectResult {
  /** The fragment file names collected, in collection order. */
  collected: string[];
  /** False when the changelog was left byte-for-byte as it was. */
  changed: boolean;
}

/**
 * Read the fragments, write them into the changelog and delete them.
 *
 * Everything is validated before anything is written, and the fragments
 * are deleted only after the changelog was written, so a failure leaves
 * both as they were. With no fragments and no version it is a no-op.
 *
 * @throws ChangelogError on any invalid fragment or changelog state.
 */
export function collectChangelog(options: CollectOptions): CollectResult {
  const fragments = readFragments(options.changesDir);
  if (fragments.length === 0 && options.version === undefined) {
    return { collected: [], changed: false };
  }
  const before = readFileSync(options.changelogPath, "utf8");
  const after = applyFragments(
    before,
    fragments,
    options.version === undefined
      ? {}
      : { version: options.version, date: options.date ?? todayUtc() },
  );
  writeFileSync(options.changelogPath, after);
  for (const fragment of fragments) {
    unlinkSync(join(options.changesDir, fragment.fileName));
  }
  return { collected: fragments.map((f) => f.fileName), changed: after !== before };
}

/* ─── The PR check ─── */

/** One entry of `git diff --name-status`. */
export interface ChangedFile {
  /** The status letter: `A`dded, `M`odified, `D`eleted, `T`ype change... */
  status: string;
  path: string;
}

/** The label that opts a PR out of the fragment requirement. */
export const SKIP_LABEL = "skip-changelog";

/** Where fragments live, relative to the repo root. */
const CHANGES_PREFIX = "docs/changes/";

/**
 * Paths whose change needs a changelog entry: shipped code, migrations
 * and the deploy surface.
 */
function needsEntry(path: string): boolean {
  return (
    path.startsWith("src/") ||
    path.startsWith("drizzle/") ||
    path === "Dockerfile" ||
    path === ".env.example" ||
    /^docker-compose[^/]*\.yml$/.test(path)
  );
}

/**
 * Parse `git diff --name-status --no-renames -z` output: NUL-separated
 * status and path pairs (one path each, since renames are split into a
 * delete and an add).
 */
export function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0").filter((field) => field !== "");
  const files: ChangedFile[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i];
    const path = fields[i + 1];
    if (status !== undefined && path !== undefined)
      files.push({ status: status.charAt(0), path });
  }
  return files;
}

/** The outcome of `checkChangelogEntry`. */
export interface CheckResult {
  ok: boolean;
  /** Human-readable lines explaining the outcome. */
  messages: string[];
}

/**
 * Decide whether a PR's changes carry the changelog entry they need.
 *
 * - Every fragment the PR adds or edits must be valid (name and body),
 *   label or not: a bad fragment would otherwise only fail at release.
 * - A PR that touches `src/`, `drizzle/`, `Dockerfile`,
 *   `docker-compose*.yml` or `.env.example` must add a fragment under
 *   `docs/changes/` or change `CHANGELOG.md` (a release PR), unless it
 *   carries the `skip-changelog` label.
 *
 * @param files The PR's changed files (`parseNameStatus`).
 * @param labels The PR's label names.
 * @param readFile Reads a changed file's content, by repo-relative path.
 */
export function checkChangelogEntry(
  files: readonly ChangedFile[],
  labels: readonly string[],
  readFile: (path: string) => string,
): CheckResult {
  const problems: string[] = [];
  let addsFragment = false;
  for (const file of files) {
    if (!file.path.startsWith(CHANGES_PREFIX) || file.status === "D") continue;
    const name = file.path.slice(CHANGES_PREFIX.length);
    if (name === FRAGMENTS_README) continue;
    if (name.includes("/") || !parseFragmentName(name)) {
      problems.push(badNameMessage(name));
      continue;
    }
    try {
      normalizeFragmentBody(name, readFile(file.path));
    } catch (error) {
      if (!(error instanceof ChangelogError)) throw error;
      problems.push(error.message);
      continue;
    }
    if (file.status === "A") addsFragment = true;
  }
  if (problems.length > 0) return { ok: false, messages: problems };

  const touched = files.filter((file) => needsEntry(file.path)).map((file) => file.path);
  if (touched.length === 0) {
    return {
      ok: true,
      messages: ["No change under src/, drizzle/ or the deploy files: no entry needed."],
    };
  }
  if (addsFragment)
    return { ok: true, messages: ["A changelog fragment is added under docs/changes/."] };
  if (files.some((file) => file.path === "CHANGELOG.md")) {
    return {
      ok: true,
      messages: [
        "CHANGELOG.md is changed (a release PR, or an entry written there directly).",
      ],
    };
  }
  if (labels.includes(SKIP_LABEL)) {
    return { ok: true, messages: [`The "${SKIP_LABEL}" label is set: no entry needed.`] };
  }
  const shown = touched.slice(0, 10).map((path) => `  ${path}`);
  if (touched.length > shown.length)
    shown.push(`  ... and ${touched.length - shown.length} more`);
  return {
    ok: false,
    messages: [
      "This PR changes files that need a CHANGELOG entry:",
      ...shown,
      "Add a fragment: docs/changes/<issue>.<type>.md holding the bullet as it should appear in",
      `CHANGELOG.md (see docs/changes/README.md), or set the "${SKIP_LABEL}" label for an internal-only change and re-run the job.`,
    ],
  };
}
