import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  ChangelogError,
  applyFragments,
  checkChangelogEntry,
  collectChangelog,
  normalizeFragmentBody,
  parseFragmentName,
  parseNameStatus,
  readFragments,
  todayUtc,
} from "../changelog-fragments.ts";
import type { ChangedFile } from "../changelog-fragments.ts";

/**
 * Unit tests for the changelog fragments (#442): `changelog:collect`
 * writes `docs/changes/*.md` into CHANGELOG.md, and `changelog:check`
 * is the CI gate that a PR carries one. Everything runs against a
 * temporary folder; the repo's own CHANGELOG.md is never read or written.
 */

/** A temporary repo-like folder per test: `changes/` and `CHANGELOG.md`. */
let root: string;
let changesDir: string;
let changelogPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bunmail-changelog-"));
  changesDir = join(root, "changes");
  changelogPath = join(root, "CHANGELOG.md");
  mkdirSync(changesDir);
  writeFileSync(join(changesDir, "README.md"), "# Fragments\n");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Write fragments (file name to content) into the temporary folder. */
function writeFragments(files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(changesDir, name), content);
  }
}

/** The changelog head every sample shares. */
const HEAD = [
  "# Changelog",
  "",
  "All notable changes to this project will be documented in this file.",
  "",
].join("\n");

/** A released section below `[Unreleased]`, which collection must never touch. */
const RELEASED = [
  "## [0.1.0] - 2026-01-01",
  "",
  "### Added",
  "",
  "- First release.",
  "",
].join("\n");

/** A changelog whose `[Unreleased]` section is `unreleased` (lines). */
function changelogWith(unreleased: readonly string[]): string {
  return [HEAD, "## [Unreleased]", "", ...unreleased, RELEASED].join("\n");
}

describe("parseFragmentName", () => {
  test("reads the issue, type and optional slug", () => {
    expect(parseFragmentName("442.changed.md")).toEqual({
      issue: 442,
      type: "changed",
      slug: null,
    });
    expect(parseFragmentName("12.fixed.2.md")).toEqual({
      issue: 12,
      type: "fixed",
      slug: "2",
    });
    expect(parseFragmentName("7.security.upgrade-note.md")).toEqual({
      issue: 7,
      type: "security",
      slug: "upgrade-note",
    });
  });

  test("refuses names that do not follow <issue>.<type>[.<slug>].md", () => {
    const bad = [
      "442.md",
      "442.fix.md",
      "442.Fixed.md",
      "fixed.md",
      "0.added.md",
      "042.added.md",
      "442.added.txt",
      "442.added.Slug.md",
      "442.added.two words.md",
      "442.added..md",
      "442.added.-x.md",
      "#442.added.md",
    ];
    for (const name of bad) expect(parseFragmentName(name)).toBeNull();
  });
});

describe("normalizeFragmentBody", () => {
  test("keeps the bullet byte for byte, dropping CRLF and outer blank lines", () => {
    expect(
      normalizeFragmentBody(
        "1.added.md",
        "\n- **A (#1).** Text.\r\n  - Docs: `x`.\r\n\n",
      ),
    ).toBe("- **A (#1).** Text.\n  - Docs: `x`.");
  });

  test("refuses an empty body, a missing bullet, an inner blank line and a heading", () => {
    const cases: [string, RegExp][] = [
      [" \n\n", /empty/],
      ["Text without a bullet.", /must start with "- "/],
      ["- One.\n\n- Two.", /blank line/],
      ["- One.\n### Fixed", /headings are not allowed/],
    ];
    for (const [raw, message] of cases) {
      expect(() => normalizeFragmentBody("1.added.md", raw)).toThrow(message);
    }
  });
});

describe("readFragments", () => {
  test("sorts by issue number, then slug (numeric slugs by value)", () => {
    writeFragments({
      "10.fixed.md": "- ten",
      "9.added.b.md": "- nine b",
      "9.added.10.md": "- nine 10",
      "9.added.2.md": "- nine 2",
      "9.added.md": "- nine",
      "9.added.a.md": "- nine a",
    });
    expect(readFragments(changesDir).map((f) => f.fileName)).toEqual([
      "9.added.md",
      "9.added.2.md",
      "9.added.10.md",
      "9.added.a.md",
      "9.added.b.md",
      "10.fixed.md",
    ]);
  });

  test("skips README.md and an empty folder yields nothing", () => {
    expect(readFragments(changesDir)).toEqual([]);
  });

  test("refuses bad names and subfolders, listing every problem", () => {
    writeFragments({ "1.added.md": "- fine", "2.fix.md": "- typo", "notes.txt": "x" });
    mkdirSync(join(changesDir, "3.added.md"));
    let message = "";
    try {
      readFragments(changesDir);
    } catch (error) {
      expect(error).toBeInstanceOf(ChangelogError);
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toContain("docs/changes/2.fix.md: not a valid fragment name");
    expect(message).toContain("docs/changes/3.added.md: not a valid fragment name");
    expect(message).toContain("docs/changes/notes.txt: not a valid fragment name");
    expect(message).not.toContain("1.added.md");
  });
});

describe("applyFragments", () => {
  test("groups by type in Keep a Changelog order into an empty [Unreleased]", () => {
    writeFragments({
      "5.security.md": "- sec 5",
      "4.fixed.md": "- fix 4",
      "3.removed.md": "- rem 3",
      "2.deprecated.md": "- dep 2",
      "1.changed.md": "- chg 1",
      "6.added.md": "- add 6",
    });
    const result = applyFragments(changelogWith([]), readFragments(changesDir));
    expect(result).toBe(
      changelogWith([
        "### Added",
        "",
        "- add 6",
        "",
        "### Changed",
        "",
        "- chg 1",
        "",
        "### Deprecated",
        "",
        "- dep 2",
        "",
        "### Removed",
        "",
        "- rem 3",
        "",
        "### Fixed",
        "",
        "- fix 4",
        "",
        "### Security",
        "",
        "- sec 5",
        "",
      ]),
    );
  });

  test("merges into existing subsections after their entries, and inserts missing ones in order", () => {
    const before = changelogWith([
      "### Upgrade guide (from 0.0.x)",
      "",
      "- Nothing is required.",
      "",
      "### Changed",
      "",
      "- **Old change (#1).** Kept.",
      "  - Nested detail.",
      "",
      "### Security",
      "",
      "- **Old fix (#2).** Kept.",
      "",
    ]);
    writeFragments({
      "8.security.md": "- sec 8",
      "7.changed.md": "- chg 7",
      "9.added.md": "- add 9",
      "6.fixed.md": "- fix 6",
    });
    expect(applyFragments(before, readFragments(changesDir))).toBe(
      changelogWith([
        "### Upgrade guide (from 0.0.x)",
        "",
        "- Nothing is required.",
        "",
        "### Added",
        "",
        "- add 9",
        "",
        "### Changed",
        "",
        "- **Old change (#1).** Kept.",
        "  - Nested detail.",
        "- chg 7",
        "",
        "### Fixed",
        "",
        "- fix 6",
        "",
        "### Security",
        "",
        "- **Old fix (#2).** Kept.",
        "- sec 8",
        "",
      ]),
    );
  });

  test("adds to the first of two same-type subsections and leaves a cramped layout as it is", () => {
    // What a merge conflict resolved by hand left on main on 2026-11-15.
    const before = changelogWith([
      "### Security",
      "",
      "- a",
      "### Fixed",
      "",
      "- b",
      "### Security",
      "",
      "- c",
      "",
    ]);
    writeFragments({ "9.security.md": "- d", "9.fixed.x.md": "- e" });
    expect(applyFragments(before, readFragments(changesDir))).toBe(
      changelogWith([
        "### Security",
        "",
        "- a",
        "- d",
        "### Fixed",
        "",
        "- b",
        "- e",
        "### Security",
        "",
        "- c",
        "",
      ]),
    );
  });

  test("fills an existing empty subsection", () => {
    const before = changelogWith(["### Fixed", "", "### Security", "", "- s", ""]);
    writeFragments({ "3.fixed.md": "- f" });
    expect(applyFragments(before, readFragments(changesDir))).toBe(
      changelogWith(["### Fixed", "", "- f", "", "### Security", "", "- s", ""]),
    );
  });

  test("never touches a released section, even one with the same subsection", () => {
    writeFragments({ "3.added.md": "- new" });
    const result = applyFragments(changelogWith([]), readFragments(changesDir));
    expect(result.endsWith(RELEASED)).toBe(true);
    expect(result.split("- new").length).toBe(2);
  });

  test("refuses a changelog without [Unreleased]", () => {
    writeFragments({ "3.added.md": "- new" });
    expect(() => applyFragments(`${HEAD}${RELEASED}`, readFragments(changesDir))).toThrow(
      /no "## \[Unreleased\]" heading/,
    );
  });

  describe("version mode", () => {
    test("cuts [Unreleased], fragments included, under the version below a fresh [Unreleased]", () => {
      const before = changelogWith(["### Fixed", "", "- old fix", ""]);
      writeFragments({ "4.added.md": "- add 4", "5.fixed.md": "- fix 5" });
      const result = applyFragments(before, readFragments(changesDir), {
        version: "0.2.0",
        date: "2026-11-15",
      });
      expect(result).toBe(
        [
          HEAD,
          "## [Unreleased]",
          "",
          "## [0.2.0] - 2026-11-15",
          "",
          "### Added",
          "",
          "- add 4",
          "",
          "### Fixed",
          "",
          "- old fix",
          "- fix 5",
          "",
          RELEASED,
        ].join("\n"),
      );
    });

    test("releases existing [Unreleased] entries when there are no fragments", () => {
      const result = applyFragments(
        changelogWith(["### Fixed", "", "- old fix", ""]),
        [],
        {
          version: "0.2.0",
          date: "2026-11-15",
        },
      );
      expect(result).toBe(
        [
          HEAD,
          "## [Unreleased]",
          "",
          "## [0.2.0] - 2026-11-15",
          "",
          "### Fixed",
          "",
          "- old fix",
          "",
          RELEASED,
        ].join("\n"),
      );
    });

    test("refuses an empty release, a malformed version or date, and a version already released", () => {
      const options = { date: "2026-11-15" };
      expect(() =>
        applyFragments(changelogWith([]), [], { ...options, version: "0.2.0" }),
      ).toThrow(/Nothing to release/);
      const filled = changelogWith(["### Fixed", "", "- x", ""]);
      expect(() => applyFragments(filled, [], { ...options, version: "v0.2.0" })).toThrow(
        /not a release version/,
      );
      expect(() => applyFragments(filled, [], { ...options, version: "0.2" })).toThrow(
        /not a release version/,
      );
      expect(() =>
        applyFragments(filled, [], { version: "0.2.0", date: "15/11/2026" }),
      ).toThrow(/YYYY-MM-DD/);
      expect(() => applyFragments(filled, [], { ...options, version: "0.1.0" })).toThrow(
        /already has a \[0\.1\.0\]/,
      );
    });
  });
});

describe("collectChangelog", () => {
  /** The sample changelog of the byte-for-byte test, in the repo's real style. */
  const SAMPLE_BEFORE = [
    "# Changelog",
    "",
    "All notable changes to this project will be documented in this file.",
    "",
    "The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),",
    "and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).",
    "",
    "## [Unreleased]",
    "",
    "### Security",
    "",
    "- **The dashboard same-origin check compares the scheme and port (#420).** It compared only the host.",
    "",
    "## [0.12.0] - 2026-11-08",
    "",
    "> **Theme: security fixes.**",
    "",
    "### Added",
    "",
    "- **CSV export (#430).** An **Export** button.",
    "",
  ].join("\n");

  test("writes the sample byte for byte and deletes the collected fragments, keeping README.md", () => {
    writeFileSync(changelogPath, SAMPLE_BEFORE);
    writeFragments({
      "442.changed.md":
        "- **Changelog fragments (#442).** Each PR adds `docs/changes/<issue>.<type>.md`.\n",
      "425.fixed.md":
        "- **The dashboard webhook form lists every event (#425).** It had its own list.\n",
      "422.security.md":
        "- **More custom header names are reserved (#422).** `Errors-To` is refused.\n  - Docs: `docs/emails.md`.\n",
    });
    const result = collectChangelog({ changesDir, changelogPath });
    expect(result).toEqual({
      collected: ["422.security.md", "425.fixed.md", "442.changed.md"],
      changed: true,
    });
    expect(readFileSync(changelogPath, "utf8")).toBe(
      [
        "# Changelog",
        "",
        "All notable changes to this project will be documented in this file.",
        "",
        "The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),",
        "and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).",
        "",
        "## [Unreleased]",
        "",
        "### Changed",
        "",
        "- **Changelog fragments (#442).** Each PR adds `docs/changes/<issue>.<type>.md`.",
        "",
        "### Fixed",
        "",
        "- **The dashboard webhook form lists every event (#425).** It had its own list.",
        "",
        "### Security",
        "",
        "- **The dashboard same-origin check compares the scheme and port (#420).** It compared only the host.",
        "- **More custom header names are reserved (#422).** `Errors-To` is refused.",
        "  - Docs: `docs/emails.md`.",
        "",
        "## [0.12.0] - 2026-11-08",
        "",
        "> **Theme: security fixes.**",
        "",
        "### Added",
        "",
        "- **CSV export (#430).** An **Export** button.",
        "",
      ].join("\n"),
    );
    expect(readdirSync(changesDir)).toEqual(["README.md"]);
  });

  test("is a no-op on an empty folder, and running it again changes nothing", () => {
    writeFileSync(changelogPath, SAMPLE_BEFORE);
    expect(collectChangelog({ changesDir, changelogPath })).toEqual({
      collected: [],
      changed: false,
    });
    expect(readFileSync(changelogPath, "utf8")).toBe(SAMPLE_BEFORE);

    writeFragments({ "1.added.md": "- one" });
    collectChangelog({ changesDir, changelogPath });
    const once = readFileSync(changelogPath, "utf8");
    expect(collectChangelog({ changesDir, changelogPath })).toEqual({
      collected: [],
      changed: false,
    });
    expect(readFileSync(changelogPath, "utf8")).toBe(once);
  });

  test("cuts a version dated today in UTC by default", () => {
    writeFileSync(changelogPath, SAMPLE_BEFORE);
    writeFragments({ "1.added.md": "- one" });
    collectChangelog({ changesDir, changelogPath, version: "0.13.0" });
    expect(readFileSync(changelogPath, "utf8")).toContain(
      `## [Unreleased]\n\n## [0.13.0] - ${todayUtc()}\n\n### Added\n\n- one\n\n### Security\n`,
    );
    expect(existsSync(join(changesDir, "1.added.md"))).toBe(false);
  });

  test("a bad fragment name leaves both the changelog and the fragments untouched", () => {
    writeFileSync(changelogPath, SAMPLE_BEFORE);
    writeFragments({ "1.added.md": "- one", "2.bugfix.md": "- two" });
    expect(() => collectChangelog({ changesDir, changelogPath })).toThrow(
      /2\.bugfix\.md: not a valid fragment name/,
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(SAMPLE_BEFORE);
    expect(readdirSync(changesDir).toSorted()).toEqual([
      "1.added.md",
      "2.bugfix.md",
      "README.md",
    ]);
  });
});

describe("todayUtc", () => {
  test("formats the UTC date, not the local one", () => {
    expect(todayUtc(new Date("2026-11-15T23:59:59-05:00"))).toBe("2026-11-16");
  });
});

describe("parseNameStatus", () => {
  test("reads NUL-separated status and path pairs", () => {
    expect(
      parseNameStatus("M\0src/app.ts\0A\0docs/changes/1.added.md\0D\0old file.md\0"),
    ).toEqual([
      { status: "M", path: "src/app.ts" },
      { status: "A", path: "docs/changes/1.added.md" },
      { status: "D", path: "old file.md" },
    ]);
    expect(parseNameStatus("")).toEqual([]);
  });
});

describe("checkChangelogEntry", () => {
  /** Fragment contents the check reads, by path. */
  const contents: Record<string, string> = {
    "docs/changes/442.changed.md": "- **Fragments (#442).** Text.\n",
    "docs/changes/9.fixed.md": "no bullet",
  };
  const read = (path: string): string => contents[path] ?? "";
  const changed = (...entries: [string, string][]): ChangedFile[] =>
    entries.map(([status, path]) => ({ status, path }));

  test("passes when only docs, tests or CI change", () => {
    const result = checkChangelogEntry(
      changed(
        ["M", "docs/api.md"],
        ["A", "test/unit/x.test.ts"],
        ["M", ".github/workflows/ci.yml"],
      ),
      [],
      read,
    );
    expect(result.ok).toBe(true);
  });

  test("requires an entry for src/, drizzle/, the Dockerfile, compose files and .env.example", () => {
    for (const path of [
      "src/app.ts",
      "drizzle/0045_x.sql",
      "Dockerfile",
      "docker-compose.yml",
      "docker-compose.override.example.yml",
      ".env.example",
    ]) {
      const result = checkChangelogEntry(changed(["M", path]), [], read);
      expect(result.ok).toBe(false);
      expect(result.messages.join("\n")).toContain(`  ${path}`);
    }
    // Similar names elsewhere do not count.
    expect(
      checkChangelogEntry(
        changed(["M", "test/src/x.ts"], ["M", "docs/Dockerfile.md"]),
        [],
        read,
      ).ok,
    ).toBe(true);
  });

  test("is satisfied by an added fragment, a CHANGELOG.md change or the skip-changelog label", () => {
    const code: [string, string] = ["M", "src/app.ts"];
    expect(
      checkChangelogEntry(changed(code, ["A", "docs/changes/442.changed.md"]), [], read)
        .ok,
    ).toBe(true);
    expect(checkChangelogEntry(changed(code, ["M", "CHANGELOG.md"]), [], read).ok).toBe(
      true,
    );
    expect(checkChangelogEntry(changed(code), ["ci", "skip-changelog"], read).ok).toBe(
      true,
    );
    // Editing another PR's fragment, or only the README, is not this PR's entry.
    expect(
      checkChangelogEntry(changed(code, ["M", "docs/changes/442.changed.md"]), [], read)
        .ok,
    ).toBe(false);
    expect(
      checkChangelogEntry(changed(code, ["A", "docs/changes/README.md"]), [], read).ok,
    ).toBe(false);
  });

  test("fails on an invalid fragment even with the label, and ignores deleted ones", () => {
    const badName = checkChangelogEntry(
      changed(["A", "docs/changes/442.change.md"]),
      ["skip-changelog"],
      read,
    );
    expect(badName.ok).toBe(false);
    expect(badName.messages[0]).toContain("442.change.md: not a valid fragment name");

    const nested = checkChangelogEntry(
      changed(["A", "docs/changes/sub/1.added.md"]),
      [],
      read,
    );
    expect(nested.ok).toBe(false);

    const badBody = checkChangelogEntry(
      changed(["A", "docs/changes/9.fixed.md"]),
      [],
      read,
    );
    expect(badBody.ok).toBe(false);
    expect(badBody.messages[0]).toContain('must start with "- "');

    // A release PR deletes the collected fragments.
    expect(
      checkChangelogEntry(
        changed(
          ["D", "docs/changes/1.bad name"],
          ["M", "CHANGELOG.md"],
          ["M", "src/x.ts"],
        ),
        [],
        read,
      ).ok,
    ).toBe(true);
  });
});
