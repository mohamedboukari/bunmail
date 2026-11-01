# Testing

BunMail's test suite has three tiers, each catching a different class of bug. Pre-commit runs the fast tiers; CI runs all three.

## Tiers at a glance

| Tier | Location | What it catches | Speed | Mocked? |
|---|---|---|---|---|
| **Unit** | [test/unit/](../test/unit/) | Pure-function correctness: parsers, helpers, validators, serializers, classification logic with injected dependencies. | ~10s for 700+ tests | DB, network, time |
| **E2E plugin** | [test/e2e/](../test/e2e/) | Elysia plugin routing, auth flow, request/response shapes, error handling. Services and DB are mocked at the import boundary. | ~200ms for 180 tests | DB, services |
| **Integration** | [test/integration/](../test/integration/) | Real Drizzle SQL execution, FK / `ON DELETE` behaviour, `ON CONFLICT DO UPDATE` upserts, transaction semantics, schema drift between TS models and the live DB. End-to-end DSN flow (DSN bytes → suppression + `email.bounced` webhook), atomic queue claim under concurrency, etc. | ~80-95s for 600+ tests | Outbound HTTP only |

Run all three together: `bun run test:all`.

The files that start a receiving MX need `node` on `PATH`: `test/unit/mx-transport.test.ts` and the MX integration files (`mx-session`, `mx-failover`, `mta-sts`, #250) run a real receiving MX under Node (`test/smtp-fixture.ts` starts `test/fixtures/smtp-tls-server.mjs`: `smtp-server` for STARTTLS, plaintext, TLS 1.1 and a stall after DATA, a raw server for one that never answers or stops after STARTTLS), because Bun cannot upgrade an accepted socket to TLS and so cannot serve STARTTLS. The client side, the code under test, still runs under Bun. GitHub's `ubuntu-latest` runners ship Node. `test/integration/mta-sts.integration.test.ts` (#250) uses the same fixture for verified STARTTLS: the certificates for `mx1.example.test`, `mx2.example.test` and `mta-sts.example.org` under `test/fixtures/tls/` are signed by a test-only CA (`test-ca.cert.pem`, its key not kept), which the tests trust only through the MTA-STS seam (`setMtaStsDeps({ ca })`), never globally; the policy is served by a local `Bun.serve` HTTPS server. The integration preload installs a stub so no test reaches real DNS or HTTPS for MTA-STS. The submission TLS tests (`smtp-submission-tls`, #349) also need `node`: the BunMail submission server runs under Bun in the test process and every client is a Node child process (`test/fixtures/smtp-submission-client.mjs`), so the client is never the thing under test. Its hang-up tests (#351) read the server's socket states from `/proc/net/tcp` on Linux or `lsof` on macOS, and sample the process's CPU time. The MX fixture's counters arrive on the child's stdout and can trail the SMTP reply the client already saw, so assert a message count with `await server.waitForMessages(n)`, not `server.messages()` (a zero check can read `messages()` directly).

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

### Dashboard route table (#222)

`test/integration/dashboard-route-access.integration.test.ts` does the same for the dashboard: it reads every route from `pagesPlugin` and requires an entry in its `ROUTES` table (`public`, `member`, `admin` or `owner`, plus a minimal valid body for write routes). It fails on a route missing from the table, a stale entry, a public route that runs the session guard, or a protected route that does not carry exactly the role guard its entry names. Then every protected route is called with no cookie (`302` to the login page) and with a member, an admin and an owner session (`403` when the role is too low, neither `403` nor a bounce to the login page otherwise). **A new dashboard route must be added there.**

### What the integration tier doesn't cover

- **`mailer.service.ts`**: Nodemailer wrapper. Would need `mailcatcher` / `maildev` in compose. Skipped.
- **`dns-verification.service.ts`**: DNS resolver, flaky in CI. Mock at the `resolve()` boundary if needed.
- **Dashboard JSX rendering**: server-rendered HTML, snapshot-tested via the `dashboard-*.test.ts` files at the e2e tier already. Snapshots have low value-to-maintenance ratio for our scope.

## CI configuration

[.github/workflows/ci.yml](../.github/workflows/ci.yml) provisions a `postgres:16` service container with `POSTGRES_DB: bunmail_test`. The CI job runs:

```yaml
- bun run lint:mocks                  # every mock.module covers every export (#293)
- bun run test:unit:coverage
- bun run test:e2e:coverage
- bun test test/unit --randomize --seed=N   # and test/e2e, for N = 1, 42, 1337
- bun run db:migrate                  # apply schema to bunmail_test
- bun run test:integration            # 600+ tests against real Postgres
```

Total CI test time: about a minute and a half across all three tiers, almost all of it the integration tier (argon2id and real Postgres).

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

### `mock.module` rules (#293)

Bun's `mock.module` is process-wide: a mock registered by one file stays in place for every file that runs after it in the same `bun test` process, so which mock a file sees depends on file order, and that order differs between machines.

- **Cover every export of the mocked module.** An export the factory omits is `undefined` for the next file that imports the module. Either stub each export, or spread the real module under the stubs (`const realConfig = await import("../../src/config.ts")` before the mock, then `() => ({ ...realConfig, config: { ... } })`), which is what the `config.ts`, `logger.ts` and `dns/promises` mocks do.
- **A `config` stub starts from the real `config` object**, top level and nested: `config: { ...realConfig.config, mail: { ...realConfig.config.mail, hostname: "localhost" } }`. A field the stub leaves out is `undefined` for every later file that reads it (a missing `dkimEncryptionKey` broke the unsubscribe-token tests under some file orders). `lint:mocks` checks exports, not fields, so this one is on the author; the random-order CI step catches a slip. Keep `database.url` set: `src/db/index.ts` reads it at import.
- **`bun run lint:mocks`** ([test/mock-completeness.ts](../test/mock-completeness.ts)) fails on any `mock.module` in `test/` whose factory misses an export, so adding an export to a mocked module fails the PR that adds it. It reads factories written as an arrow returning an object literal (inline or bound to a `const`); anything else fails unless the call carries `// mock-completeness: ignore <reason>`. It runs in CI and in lint-staged.
- **Don't mock the logger in unit tests**; spy on it (`spyOn(logger, "warn")`). A complete logger mock is still a no-op logger, and `log-context.test.ts` checks real log lines.
- **CI runs unit and e2e in random order with three fixed seeds** (1, 42, 1337), so an order-dependent failure is reproducible: `bun test test/unit --randomize --seed=42`.
- **A shared setup module must re-register its mocks per file.** The dashboard e2e tests are split per area (`dashboard-<area>.test.ts`, #291) over one setup module, `dashboard-setup.ts`, which loads once per run. A dashboard file that runs after another e2e file mocking the same services would otherwise see that file's mocks, so every dashboard file calls `useDashboardMocks()`, which runs `registerDashboardMocks()` in its `beforeAll`. Without it, 11 to 21 tests fail per random seed. A new dashboard area file starts with that call; a value a test changes (an imported `let` is read-only) gets a setter in the setup (`setIssueResult`).

When adding a service unit test, prefer the **dependency-injection pattern**: extract a pure orchestration function that takes its dependencies as callbacks (see `resolveDomainForEmail`, `handleBounce`, `handleSendFailure`). Then the unit test feeds fake callbacks; the production wrapper wires real implementations.

## Test data conventions

- Use `@example.com` / `@example.org` / `@example.net` in test fixtures (RFC 2606 reserved).
- Use unique `from` and `to` per test to avoid accidental cross-test interference.
- Don't rely on row counts surviving across tests: `truncateAll` runs between every test.
- Don't import production secrets into tests: `test/setup.ts` and `test/integration/_preload.ts` set deterministic dummy values.

## Parser time budgets (#232)

Everything that parses untrusted input has a unit test that feeds it generated input at the size the server accepts (10 MB for inbound and submitted messages, 25 MB after DMARC decompression) and asserts completion inside a generous budget, so a super-linear regression fails CI instead of being found by the first crafted message:

- `test/unit/parser-time-budgets.test.ts`: the DMARC heuristic and parser, mailparser (`simpleParser`), the inbound notification builder, and the DKIM verifier (#373).
- `test/unit/bounce-parser.test.ts`: the DSN parser (#235).
- `test/unit/recipients.test.ts`: `parseRecipients`, including the adversarial shapes that made the previous address regex backtrack quadratically.

Inputs are generated in the test, never stored as fixtures. Budgets are deliberately loose (hundreds of ms to a few seconds) to stay stable on CI; each was checked to fail against a quadratic implementation.

## DKIM verifier vectors (#373)

`test/dkim-vectors.ts` builds signed messages (nodemailer's own signer for relaxed/relaxed RSA, a plain RFC 6376 signer for simple, `l=`, `i=`, `x=` and ed25519-sha256), each with the DNS answers it needs and the expected verdict; `test/unit/dkim-verifier.test.ts` runs them with fresh keys over an injected `resolveTxt`, no `mock.module`. `test/fixtures/dkim-differential.json` is one run of the same vectors with mailauth's verdicts (default and strict mode), written by `test/fixtures/generate-dkim-differential.ts` while mailauth was still installed; `test/unit/dkim-differential.test.ts` checks the verifier against it and lists every intended difference with its reason.

