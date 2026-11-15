/**
 * Integration test preload. Wired in via the `--preload` flag on the
 * `test:integration` script in `package.json`: runs **after** the
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
 *   1. `INTEGRATION_DATABASE_URL` if set: explicit override, wins
 *   2. Existing `DATABASE_URL` if it already points at a `*_test`
 *      database: CI sets it this way directly via the workflow env
 *   3. Construct from `POSTGRES_USER` / `POSTGRES_PASSWORD` (loaded
 *      from `.env`) targeting `bunmail_test` on localhost:5432
 *
 * The third path is the local-dev default. If a developer's `.env`
 * has `DATABASE_URL` pointing at their dev DB, we DELIBERATELY don't
 * use it: running integration tests against the dev DB would corrupt
 * the dev data on every TRUNCATE.
 */

/**
 * Integration tests exercise the SMTP submission server over plaintext
 * (no TLS material), which the service now refuses by default (#133). Opt
 * in here, set before the app's `config` module loads, so the tests can
 * bind the submission server without a cert. Real deployments set TLS or
 * this flag deliberately; the test env is a trusted loopback.
 */
process.env["SMTP_SUBMISSION_ALLOW_INSECURE"] = "true";

/**
 * A pool larger than any test's peak of concurrent queries (#423). It was
 * added for a Bun 1.3.14 bug: a burst of more concurrent queries than the
 * pool had connections could stall the pool (oven-sh/bun#32004, #33627),
 * and the ownership transfer burst (15 requests at once, each reading two
 * accounts in parallel: up to 30 queries in flight) hung now and then on
 * the default pool of 10. Bun 1.4.4 fixed the stall (#447); 32 stays so
 * the parallel bursts run as wide as they were written, without queueing.
 * Set unconditionally, before `config` loads, so every run gets the same
 * pool whatever a developer's `.env` says. Not more than needed: Bun never
 * closes an idle connection, so a run holds up to 32 of Postgres's
 * `max_connections` (100 by default) for its whole length, and several
 * runs often share one local server.
 */
process.env["DATABASE_POOL_MAX"] = "32";

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

/**
 * No real DNS in integration tests (#250): the domains module's DNS seam
 * (DMARC, MX status, and the TXT lookups of Verify) answers NXDOMAIN at
 * once, the outbound MTA-STS lookups find no policy, and the DNSBL
 * self-check finds no sending IP and no listing. Imported only
 * now, after `DATABASE_URL` is final: the module loads `config`. The queue's return-path MX check (#236) needs no stub:
 * it returns before DNS while inbound SMTP is off, and the tests that turn
 * it on inject `signedReturnPath`.
 */
const { installHermeticDnsbl, installHermeticDomainDns, installHermeticMtaSts } =
  await import("./_dns-stub.ts");
installHermeticDomainDns();
installHermeticMtaSts();
installHermeticDnsbl();
