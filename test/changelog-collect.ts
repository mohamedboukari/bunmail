/**
 * `bun run changelog:collect [version]` (#442).
 *
 * Moves the fragments in `docs/changes/` into `CHANGELOG.md` and deletes
 * them:
 *
 * - without an argument, under `## [Unreleased]`, merged into the
 *   existing `### <Type>` subsections;
 * - with a version (`bun run changelog:collect 0.13.0`), the whole
 *   `[Unreleased]` section, fragments included, becomes
 *   `## [0.13.0] - <today, UTC>` under a fresh empty `## [Unreleased]`.
 *   This is step 2 of the `/release` skill.
 *
 * Fails (exit 1) without touching anything on an invalid fragment name or
 * body. The logic lives in `test/changelog-fragments.ts`.
 */
/* oxlint-disable no-console -- standalone repo script: console IS its output, and the app logger pulls in config */
import { join } from "path";

import { ChangelogError, collectChangelog } from "./changelog-fragments.ts";

/** The repository root (this file lives in `test/`). */
const ROOT = join(import.meta.dir, "..");

/** Parse the arguments, run the collection and report it. */
function main(argv: readonly string[]): number {
  if (argv.length > 1) {
    console.error("Usage: bun run changelog:collect [X.Y.Z]");
    return 1;
  }
  const version = argv[0];
  try {
    const result = collectChangelog({
      changesDir: join(ROOT, "docs", "changes"),
      changelogPath: join(ROOT, "CHANGELOG.md"),
      ...(version === undefined ? {} : { version }),
    });
    const target = version === undefined ? "[Unreleased]" : `[${version}]`;
    if (result.collected.length === 0 && version === undefined) {
      console.info("No fragments in docs/changes/: CHANGELOG.md is unchanged.");
      return 0;
    }
    console.info(
      `Collected ${result.collected.length} fragment(s) into CHANGELOG.md under ${target}:`,
    );
    for (const name of result.collected) console.info(`  docs/changes/${name} (deleted)`);
    return 0;
  } catch (error) {
    if (!(error instanceof ChangelogError)) throw error;
    console.error(error.message);
    return 1;
  }
}

process.exit(main(process.argv.slice(2)));
