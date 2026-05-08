/**
 * Integration test preload. Wired in via the `--preload` flag on the
 * `test:integration` script in `package.json` — runs **after** the
 * global `test/setup.ts` preload from `bunfig.toml` and **before** any
 * test file imports the app code.
 *
 * Job: lock the DB connection to a dedicated `bunmail_test` database
 * so integration tests never trash dev or production data. The
 * application's `db` singleton at `src/db/index.ts` is constructed at
 * module load time from `process.env.DATABASE_URL`, so this override
 * MUST happen before any service module is touched.
 *
 * URL resolution order:
 *   1. `INTEGRATION_DATABASE_URL` if set — explicit override, wins
 *   2. Existing `DATABASE_URL` if it already points at a `*_test`
 *      database — CI sets it this way directly via the workflow env
 *   3. Construct from `POSTGRES_USER` / `POSTGRES_PASSWORD` (loaded
 *      from `.env`) targeting `bunmail_test` on localhost:5432
 *
 * The third path is the local-dev default. If a developer's `.env`
 * has `DATABASE_URL` pointing at their dev DB, we DELIBERATELY don't
 * use it — running integration tests against the dev DB would corrupt
 * the dev data on every TRUNCATE.
 */

const explicit = process.env["INTEGRATION_DATABASE_URL"];
if (explicit) {
  process.env["DATABASE_URL"] = explicit;
} else if (process.env["DATABASE_URL"]?.match(/\/bunmail_test(\?|$)/)) {
  /** Already pointing at the test DB (CI workflow sets this directly). */
} else {
  const user = process.env["POSTGRES_USER"] ?? "bunmail";
  const password = process.env["POSTGRES_PASSWORD"] ?? "bunmail";
  const host = process.env["POSTGRES_HOST"] ?? "localhost";
  const port = process.env["POSTGRES_PORT"] ?? "5432";
  process.env["DATABASE_URL"] =
    `postgres://${user}:${password}@${host}:${port}/bunmail_test`;
}
