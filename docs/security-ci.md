# Security CI

Five layers run on every push and pull request. Their job names below match the GitHub status checks; once a layer is "required" in branch protection it gates merges.

| Layer | Workflow | Job | What it catches |
|---|---|---|---|
| **CodeQL** | `codeql.yml` | `Analyze (javascript-typescript)` | Semantic SAST — taint flow, injection, unsafe deserialization, common vuln patterns in TS/JS source. |
| **Trivy fs** | `security.yml` | `Trivy filesystem scan` | CVEs in `bun.lock`, `package.json`, `Dockerfile` pins (transitive deps included). Fails on `HIGH`/`CRITICAL`. |
| **Trivy image** | `security.yml` | `Trivy image scan` | CVEs in the built Docker image — base layers (`oven/bun:1`) + OS packages + everything you installed. Builds the image without pushing. |
| **gitleaks** | `security.yml` | `gitleaks (secret scan)` | High-confidence secret patterns (AWS keys, GH tokens, private RSA keys, etc.) in the diff and full git history. |
| **bun pm untrusted** | `ci.yml` | `Audit untrusted lifecycle scripts` | npm/Bun packages with postinstall scripts that aren't on `trustedDependencies`. Stops a new compromised dep from running arbitrary code on every install. |

Plus **Dependabot** (out of CI but in the same security loop) opens grouped PRs every Monday for npm + GitHub Actions updates.

## Triaging a failure

### CodeQL
- Click the status link → "View alert details" in the PR.
- Real fixes go in code; false positives go in `.github/codeql/codeql-config.yml` with a `paths-ignore` or query-suppress comment + justification.

### Trivy (fs or image)
- Click the status link → scroll to the table of CVEs.
- For each finding:
  - **Has a fix?** Bump the dep (Dependabot will probably already have a PR open) or pick a patched base image tag.
  - **No fix yet?** Add an entry to `.trivyignore` at the repo root in this format:
    ```
    # CVE-YYYY-XXXXX  short justification + revisit date
    CVE-2025-12345
    ```
    Don't ignore `CRITICAL` without explicit approval.
  - **False positive (e.g. unused code path)?** Same `.trivyignore` entry + explanation.

### gitleaks
- The action posts a comment on the PR with the file/line/rule of every finding.
- **If it's a real secret:** rotate it immediately, then `git rebase` to remove the commit (don't just delete the line — git history still has it).
- **If it's a false positive:** add a per-rule allowlist entry to `.gitleaks.toml`. Example:
  ```toml
  [allowlist]
    description = "test fixtures with synthetic API keys"
    paths = [
      '''test/fixtures/.*''',
    ]
  ```

### bun pm untrusted
- Failure means a dep declared a postinstall script that isn't in `trustedDependencies`.
- Inspect the package — does it actually need the script?
  - **Yes (legit native build like `node-gyp`):** add to `trustedDependencies` in `package.json` with a one-line comment.
  - **No, or unknown:** investigate the package or replace it.

## Branch protection

After a workflow's first green run, add the job name to required checks:

```bash
# Example: require Trivy fs + image + gitleaks
gh api -X PUT repos/mohamedboukari/bunmail/branches/main/protection \
  -f required_status_checks.contexts[]="Trivy filesystem scan" \
  -f required_status_checks.contexts[]="Trivy image scan" \
  -f required_status_checks.contexts[]="gitleaks (secret scan)" \
  -f required_status_checks.strict=true
```

(In practice use the GitHub UI for the first time so you keep the existing required checks intact.)

## SHA-pinning

Every third-party action across `ci.yml`, `codeql.yml`, `docker.yml`, `release.yml`, and `security.yml` is pinned to a commit SHA — a moved tag from a compromised maintainer can't replace pinned code. Trailing `# vN` comments preserve the human-readable version. Dependabot's `github-actions` ecosystem updates both the SHA and the comment automatically (grouped into one weekly PR).

## What's intentionally NOT here

- **SonarCloud / SonarQube** — overlaps with CodeQL on JS/TS taint analysis, requires an external account/UI, and adds maintenance burden disproportionate to the marginal value for an OSS project this size. Revisit if BunMail moves to a multi-team org.
- **Snyk** — paid above trial volume; Trivy + CodeQL covers the same ground free.
- **License scan** — useful for enterprise buyers, low priority for OSS at this stage.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Use GitHub's private vulnerability reporting — don't open a public issue.
