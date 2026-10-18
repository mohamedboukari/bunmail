# Testing

BunMail's test suite has three tiers, each catching a different class of bug. Pre-commit runs the fast tiers; CI runs all three.

## Tiers at a glance

| Tier | Location | What it catches | Speed | Mocked? |
|---|---|---|---|---|
| **Unit** | [test/unit/](../test/unit/) | Pure-function correctness: parsers, helpers, validators, serializers, classification logic with injected dependencies. | ~400ms for 240+ tests | DB, network, time |
| **E2E plugin** | [test/e2e/](../test/e2e/) | Elysia plugin routing, auth flow, request/response shapes, error handling. Services and DB are mocked at the import boundary. | ~150ms for 70 tests | DB, services |
| **Integration** | [test/integration/](../test/integration/) | Real Drizzle SQL execution, FK / `ON DELETE` behaviour, `ON CONFLICT DO UPDATE` upserts, transaction semantics, schema drift between TS models and the live DB. End-to-end DSN flow (DSN bytes → suppression + `email.bounced` webhook), atomic queue claim under concurrency, etc. | ~2s for 55+ tests | Outbound HTTP only |

Run all three together: `bun run test:all`.

## Running

```bash
bun run test                          # unit + e2e (fast)
bun run test:unit                     # unit only
bun run test:e2e                      # e2e only
bun run test:integration              # integration only (needs Postgres)
bun run test:integration:setup        # one-shot: create bunmail_test + migrate
bun run test:all                      # all three tiers (this is what pre-commit + CI run)
bun run test:coverage                 # unit + e2e with coverage table + floor check (CI runs this)
```

## Pre-commit runs `test:all`

The `.husky/pre-commit` hook runs `bun run test:all`: same suite CI runs. **First-time on a fresh checkout you need:**

```bash
bun run test:integration:setup
```

That creates `bunmail_test` on your local Postgres and applies all migrations. After that, every commit re-runs unit + e2e + integration in ~3 seconds. If integration fails because Postgres isn't running, the hook errors clearly and points you at the setup script.

The pre-commit + CI parity is deliberate: cross-platform / cross-tier regressions should fail at commit time, not after a CI cycle.

## How the integration tier works

### Required: Postgres reachable on localhost:5432

The integration tier runs against a **real Postgres** in a dedicated `bunmail_test` database. Tests never touch your dev or prod DB.

**One-shot local setup** (run once, or after a schema change):

```bash
bun run test:integration:setup
```

This script reads `POSTGRES_USER` / `POSTGRES_PASSWORD` from `.env`, connects to the `postgres` admin DB, creates `bunmail_test` if missing, and applies every migration in `drizzle/` via the Bun-native runner.

### What the tier does at runtime

1. **`test/integration/_preload.ts`** runs first (via the `--preload` flag in the `test:integration` script). It overrides `process.env.DATABASE_URL` to point at `bunmail_test` **before** any service module loads, so the application's `db` singleton (`src/db/index.ts`) connects to the test DB.
2. **`test/integration/_helpers.ts`** exposes `truncateAll()` and seed factories (`seed.apiKey`, `seed.domain`, `seed.email`, `seed.suppression`, `seed.webhook`, `seed.template`, `seed.owner`, plus `seed.user` and `seed.session` for dashboard accounts and sessions, #216).
3. Each test file calls `await truncateAll()` in `beforeEach`. Tables are wiped in dependency order (`suppressions, emails, webhooks, templates, domains, api_keys`) with `CASCADE` and `RESTART IDENTITY`.
4. Tests execute the real service functions against the real DB. No mocking unless we're stubbing **outbound HTTP** (the webhook-dispatch test stubs `globalThis.fetch`).

### Authorization matrix (#228)

`test/integration/authz-matrix.integration.test.ts` mounts exactly the API plugins production mounts (`apiPlugins` in `src/modules/api-plugins.ts`), with the real auth, admin and rate-limit middleware, and checks every route:

- no key, an invalid key and a revoked key get `401`;
- a restricted key gets `403` on admin-only routes;
- another tenant's key gets `404` on tenant-owned resources (emails, tombstones, templates, webhooks, deliveries, suppressions), and those resources are left untouched;
- an allowed key passes the auth layer.

Every route needs an entry in the test's `ROUTES` table (access level, a minimal valid body for write routes, and the kind of owned resource in its path). A route without an entry, or an entry without a route, fails the test, so **a new endpoint must be added there**. Request bodies are validated before the auth hooks run, which is why write routes need a valid body to reach the auth checks.

### What the integration tier doesn't cover

- **`mailer.service.ts`**: Nodemailer wrapper. Would need `mailcatcher` / `maildev` in compose. Skipped.
- **`dns-verification.service.ts`**: DNS resolver, flaky in CI. Mock at the `resolve()` boundary if needed.
- **Dashboard JSX rendering**: server-rendered HTML, snapshot-tested via `dashboard.test.ts` at the e2e tier already. Snapshots have low value-to-maintenance ratio for our scope.

## CI configuration

[.github/workflows/ci.yml](../.github/workflows/ci.yml) provisions a `postgres:16` service container with `POSTGRES_DB: bunmail_test`. The CI job runs:

```yaml
- bun test test/unit
- bun test test/e2e
- bun run db:migrate                  # apply schema to bunmail_test
- bun run test:integration            # 40 tests against real Postgres
```

Total CI test time: ~2-3 seconds across all three tiers.

## Coverage

`bun run test:coverage` runs the unit and e2e tiers **in separate processes**, each with coverage (`test:unit:coverage` writes `coverage/unit/`, `test:e2e:coverage` writes `coverage/e2e/`), prints a per-file table for each, then runs `bun run coverage:check`. **CI runs the same scripts and fails the build if coverage drops below the floor.**

| Measure (unit + e2e merged) | Baseline (#171) | Floor |
|---|---|---|
| Lines, weighted by line count | 65.27% (7,011 / 10,742) | **64%** |
| Functions, weighted | 74.67% (395 / 529) | **73%** |

Things that are easy to get wrong:

- **Why separate processes:** running unit + e2e in one `bun test` lets `mock.module` mocks leak between files. On Linux CI that breaks tests outright (file order differs from macOS), so each tier runs alone and `coverage:check` merges the two LCOV files: lines by union, exact; functions by per-file max, a conservative lower bound because Bun's LCOV has no per-function records. A missing or empty tier fails the check.
- **The table's `All files` row is a per-file average** and reads much higher. Many small, fully-covered files inflate it, so the gate uses line-weighted LCOV totals instead.
- **Bun's native `coverageThreshold` isn't used.** Bun applies it per file (every file must clear it), not to the total, and silently ignores singular keys like `line`. That combination meant the old `bunfig.toml` gate never fired. The floor lives in the `coverage:check` script in `package.json`; raise it there as coverage grows.

**The integration tier isn't gated**; measure it separately:

```bash
# Unit + e2e, gated (what CI runs):
bun run test:coverage

# Integration tier (typically 80-100% on targeted services):
bun test --preload ./test/integration/_preload.ts --coverage test/integration
```

## Adding tests

| When you... | Add a test in... |
|---|---|
| Write a pure function (parser, classifier, helper) | `test/unit/<name>.test.ts`: feed in fixtures, assert output |
| Add a route or change a request/response shape | `test/e2e/<feature>-api.test.ts`: exercise via `app.handle(new Request(...))` with services mocked |
| Add a service method that touches the DB | `test/integration/<service>.integration.test.ts`: run the real method against the real DB, use seed factories from `_helpers.ts` |

When adding a service unit test, prefer the **dependency-injection pattern**: extract a pure orchestration function that takes its dependencies as callbacks (see `resolveDomainForEmail`, `handleBounce`, `handleSendFailure`). Then the unit test feeds fake callbacks; the production wrapper wires real implementations.

## Test data conventions

- Use `@example.com` / `@example.org` / `@example.net` in test fixtures (RFC 2606 reserved).
- Use unique `from` and `to` per test to avoid accidental cross-test interference.
- Don't rely on row counts surviving across tests: `truncateAll` runs between every test.
- Don't import production secrets into tests: `test/setup.ts` and `test/integration/_preload.ts` set deterministic dummy values.

## Parser time budgets (#232)

Everything that parses untrusted input has a unit test that feeds it generated input at the size the server accepts (10 MB for inbound and submitted messages, 25 MB after DMARC decompression) and asserts completion inside a generous budget, so a super-linear regression fails CI instead of being found by the first crafted message:

- `test/unit/parser-time-budgets.test.ts`: the DMARC heuristic and parser, mailparser (`simpleParser`), and the inbound notification builder.
- `test/unit/bounce-parser.test.ts`: the DSN parser (#235).
- `test/unit/recipients.test.ts`: `parseRecipients`, including the adversarial shapes that made the previous address regex backtrack quadratically.

Inputs are generated in the test, never stored as fixtures. Budgets are deliberately loose (hundreds of ms to a few seconds) to stay stable on CI; each was checked to fail against a quadratic implementation.

