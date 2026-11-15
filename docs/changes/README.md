# Changelog fragments

A PR does not edit `CHANGELOG.md`. It adds its entry here as its own file, so two PRs built from the same `main` never conflict on the changelog (#442). The release collects the fragments into `CHANGELOG.md`.

## Adding a fragment

Name the file `<issue>.<type>.md`:

- `<issue>`: the GitHub issue number the PR closes (no leading zero).
- `<type>`: the Keep a Changelog section, one of `added`, `changed`, `deprecated`, `removed`, `fixed`, `security`.

The content is the bullet exactly as it should appear in `CHANGELOG.md`, in the usual style: one `- **Bold summary (#N).** Explanation.` item, nested `  - ` sub-items allowed, no blank lines and no headings.

```markdown
- **The dashboard webhook form lists every event (#425).** The create form had its own hand-written list...
```

One PR can add several fragments: give the extra ones a slug, `<issue>.<type>.<slug>.md` (lowercase letters, digits and hyphens), for example `425.fixed.md` plus `425.security.md`, or `380.changed.md` plus `380.changed.2.md`.

## The CI check

On a pull request, CI runs `bun run changelog:check <base>` and fails when the PR changes `src/`, `drizzle/`, `Dockerfile`, `docker-compose*.yml` or `.env.example` without adding a fragment here (or changing `CHANGELOG.md`, for a release PR). For an internal-only change, set the `skip-changelog` label and re-run the job. Every fragment a PR adds must be valid, label or not.

## Collecting (releases)

```bash
bun run changelog:collect          # into ## [Unreleased]
bun run changelog:collect 0.13.0   # cut ## [0.13.0] - <today, UTC> under a fresh [Unreleased]
```

It groups the fragments by type in the changelog's section order (Added, Changed, Deprecated, Removed, Fixed, Security), appends them to the matching `### <Type>` subsection after the entries already there (creating the subsection where missing), orders them by issue number then slug, and deletes them. A bad file name or body fails the run without changing anything. This folder stays in the repo through this README.
