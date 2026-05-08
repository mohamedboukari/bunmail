# Testing

BunMail's test suite has three tiers, each catching a different class of bug. Pre-commit runs the fast tiers; CI runs all three.

## Tiers at a glance

| Tier | Location | What it catches | Speed | Mocked? |
|---|---|---|---|---|
| **Unit** | [test/unit/](../test/unit/) | Pure-function correctness — parsers, helpers, validators, serializers, classification logic with injected dependencies. | ~300ms for 130+ tests | DB, network, time |
| **E2E plugin** | [test/e2e/](../test/e2e/) | Elysia plugin routing, auth flow, request/response shapes, error handling. Services and DB are mocked at the import boundary. | ~150ms for 70 tests | DB, services |
| **Integration** | [test/integration/](../test/integration/) | Real Drizzle SQL execution, FK / `ON DELETE` behaviour, `ON CONFLICT DO UPDATE` upserts, transaction semantics, schema drift between TS models and the live DB. | ~1.5s for 40 tests | Outbound HTTP only |

Run all three together: `bun run test:all`.

## Running

```bash
bun run test                          # unit + e2e (fast — pre-commit hook)
bun run test:unit                     # unit only
bun run test:e2e                      # e2e only
bun run test:integration              # integration only (needs Postgres)
bun run test:integration:setup        # one-shot: create bunmail_test + migrate
bun run test:all                      # all three tiers in sequence
bun run test:coverage                 # unit + e2e with coverage table
```

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
2. **`test/integration/_helpers.ts`** exposes `truncateAll()` and seed factories (`seed.apiKey`, `seed.domain`, `seed.email`, `seed.suppression`, `seed.webhook`, `seed.template`).
3. Each test file calls `await truncateAll()` in `beforeEach`. Tables are wiped in dependency order (`suppressions, emails, webhooks, templates, domains, api_keys`) with `CASCADE` and `RESTART IDENTITY`.
4. Tests execute the real service functions against the real DB. No mocking unless we're stubbing **outbound HTTP** (the webhook-dispatch test stubs `globalThis.fetch`).

### What the integration tier doesn't cover

- **`mailer.service.ts`** — Nodemailer wrapper. Would need `mailcatcher` / `maildev` in compose. Skipped.
- **`dns-verification.service.ts`** — DNS resolver, flaky in CI. Mock at the `resolve()` boundary if needed.
- **Dashboard JSX rendering** — server-rendered HTML, snapshot-tested via `dashboard.test.ts` at the e2e tier already. Snapshots have low value-to-maintenance ratio for our scope.

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

`bun run test:coverage` produces a per-file table for the unit + e2e tiers. **Integration tests run separately for coverage** because Bun's `mock.module` calls in unit/e2e tests shadow real modules when fused into one run, giving misleadingly low integration-tier coverage:

```bash
# Unit + e2e coverage (current baseline ~62%):
bun run test:coverage

# Integration tier coverage (typically 80-100% on targeted services):
bun test --preload ./test/integration/_preload.ts --coverage test/integration
```

The threshold in [bunfig.toml](../bunfig.toml) (`line = 0.65, function = 0.60`) gates the unit + e2e run. CI fails the build if coverage drops below.

## Adding tests

| When you... | Add a test in... |
|---|---|
| Write a pure function (parser, classifier, helper) | `test/unit/<name>.test.ts` — feed in fixtures, assert output |
| Add a route or change a request/response shape | `test/e2e/<feature>-api.test.ts` — exercise via `app.handle(new Request(...))` with services mocked |
| Add a service method that touches the DB | `test/integration/<service>.integration.test.ts` — run the real method against the real DB, use seed factories from `_helpers.ts` |

When adding a service unit test, prefer the **dependency-injection pattern**: extract a pure orchestration function that takes its dependencies as callbacks (see `resolveDomainForEmail`, `handleBounce`, `handleSendFailure`). Then the unit test feeds fake callbacks; the production wrapper wires real implementations.

## Test data conventions

- Use `@example.com` / `@example.org` / `@example.net` in test fixtures (RFC 2606 reserved).
- Use unique `from` and `to` per test to avoid accidental cross-test interference.
- Don't rely on row counts surviving across tests — `truncateAll` runs between every test.
- Don't import production secrets into tests — `test/setup.ts` and `test/integration/_preload.ts` set deterministic dummy values.
