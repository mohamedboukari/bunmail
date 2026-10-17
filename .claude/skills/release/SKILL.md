---
name: release
description: Cut a bunmail release with bumpp - CHANGELOG prep commit first, version bump and tag, then verify the GitHub Release and the signed GHCR image. Use when the user asks to release, cut, tag, or publish a new bunmail version.
---

# /release: cut a bunmail release

A release is outward-facing and hard to reverse (a public tag, a GitHub Release and a published container image). **Confirm the exact version with the user before step 3**, and stop on anything unexpected.

## 1. Pre-flight

```bash
git checkout main && git pull --ff-only
git status --short          # must be empty
gh pr list --state open     # anything that should land first?
gh run list --branch main --limit 5   # CI and Security green on main?
```

- Read `CHANGELOG.md` `[Unreleased]` and propose the version: breaking changes mean a minor bump while pre-1.0 (0.x), features mean minor, fixes only mean patch.
- Flag **breaking config or deploy changes** prominently (new required env vars, port changes, migrations that need a manual step). They must be at the top of the release notes.

## 2. CHANGELOG prep commit (bumpp does NOT touch the changelog)

- Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today's date).
- Add a fresh empty `## [Unreleased]` above it.
- Optionally add a one-line `> **Theme: ...**` summary under the new heading, matching earlier releases.
- Commit: `docs: cut CHANGELOG [X.Y.Z] section ahead of release` (no AI attribution lines).

## 3. Bump, tag and push (after the user confirms X.Y.Z)

```bash
bunx bumpp X.Y.Z --yes
```

With no bumpp config, this updates `package.json`, commits `chore: release vX.Y.Z`, tags `vX.Y.Z` and pushes to `main`. That push bypasses the ruleset through the owner's admin rights; that's expected.

## 4. Verify the release pipeline

The `v*` tag triggers `release.yml` (GitHub Release) and `docker.yml` (GHCR image plus build-provenance attestation).

```bash
gh run list --limit 5            # both workflows green?
gh release view vX.Y.Z
gh attestation verify oci://ghcr.io/mohamedboukari/bunmail:X.Y.Z --owner mohamedboukari
```

## 5. Report

Version, release URL, image tag, attestation result, and any breaking or deploy notes the operator must act on. Production deploy is `git pull && docker compose up -d --build`; migrations run on container start.
