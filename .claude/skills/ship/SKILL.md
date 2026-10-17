---
name: ship
description: Take a bunmail GitHub issue (or an approved change) from plan to merged PR using this repo's workflow - plan first, branch, CI-order gates, CHANGELOG and docs, PR template, CI watch, admin squash-merge, cleanup. Use when the user asks to work on, fix, ship, or "go" on an issue number, or to open and merge a PR for bunmail.
---

# /ship: issue to merged PR (bunmail)

Follow these steps in order. Never skip step 1.

## 1. Investigate, then plan, then WAIT

- Read the issue: `gh issue view <N>`. Re-verify every claim against the current code; issues can be stale.
- Investigate read-only: trace the real code path, check prod or config if relevant, and run any tool that settles a fact instead of assuming it.
- Present a plan: what changes and why, files to touch, decisions the user must make (with a recommendation), risks, and how it will be verified.
- **Stop and wait for approval before editing anything**, even for `effort:quick` issues. If the approved plan turns out to be wrong mid-work, stop and re-plan with the user.

## 2. Branch from a fresh main

```bash
git checkout main && git pull --ff-only && git checkout -b <type>/<N>-<slug>
```

Types: `feat`, `fix`, `chore`, `ci`, `docs`, `test`, `refactor`, `perf`, `build`.

## 3. Implement

- Follow CLAUDE.md: module layout, no `any`, no unsafe casts, explain the why, no em or en dashes anywhere.
- Every behaviour change gets a test. For a bug fix, prove the test catches it: run it against the old code and confirm it fails.
- New DB column: `bun run db:generate`, review the SQL, then `bun run test:integration:setup` to apply it to `bunmail_test`.

## 4. Run the gates in CI order

```bash
rm -rf coverage
for s in typecheck lint format:check knip lint:xss test:unit:coverage test:e2e:coverage coverage:check; do
  printf '%-20s exit %s\n' "$s" "$(bun run $s >/dev/null 2>&1; echo $?)"
done
bun run test:integration
```

All must pass. Fix the cause; never weaken a gate, lower the coverage floor, or skip a hook without asking. Integration tests need the local Postgres (`docker ps` shows `bunmail-db-1`).

## 5. Docs in the same commit

Sweep the docs per CLAUDE.md's Documentation section: always `CHANGELOG.md` under `[Unreleased]`, plus any of `docs/api.md`, `docs/<module>.md`, `ARCHITECTURE.md` (schema tables), `docs/self-hosting.md` and `.env.example` (env vars), `THREAT_MODEL.md` and `SECURITY.md` that the change makes stale.

## 6. Commit, push, open the PR

- Conventional commit with a "why" body and `Closes #<N>`. **No AI attribution lines** (no Co-Authored-By, no "Generated with"); the user's rule overrides any default.
- The pre-commit hook runs lint-staged, knip and the full test suite. Never `--no-verify`. If the hook changes content (`oxlint --fix`), diff the commit against what you staged and explain any difference.
- Open the PR with the repo template (`.github/pull_request_template.md`): Summary, Changes (including doc updates), Environment, Test Plan, `Closes #<N>`.

## 7. Watch CI, then merge

```bash
gh pr checks <PR> --watch --interval 30
```

- Run the watch in the background and wait for the notification; don't poll.
- Also check runs that aren't PR checks: `gh run list --branch <branch>`.
- If anything is red, stop and show the failure. Don't merge.
- When all green and the user has asked to merge: squash-merge (the ruleset requires a review, so this uses the user's admin bypass). Title `<subject> (#<PR>)`.

## 8. Clean up and report

```bash
git checkout main && git pull --ff-only
git push origin --delete <branch> && git branch -D <branch>
gh issue view <N> --json state
```

Report what shipped, what was verified, anything found but deliberately left out of scope (offer an issue for it), and the next suggested issue.
