/**
 * One-shot setup for the integration test tier. Run via:
 *   `bun run test:integration:setup`
 *
 * Idempotent — safe to re-run after a schema change. Steps:
 *   1. Connect to the `postgres` admin database as the configured user
 *      (read from `.env`'s `POSTGRES_USER` / `POSTGRES_PASSWORD`).
 *   2. Create `bunmail_test` if it doesn't already exist.
 *   3. Apply every migration via the Bun-native runner (#56) so the
 *      test DB schema matches the application's exact expectation.
 *
 * CI doesn't need this script — the workflow's `services.postgres`
 * already provisions `bunmail_test` and the integration-tests step
 * runs `bun run db:migrate` directly. This script exists for local
 * dev convenience.
 */

/**
 * `config.ts` (loaded transitively by `runMigrations` and the project
 * logger) requires `DKIM_ENCRYPTION_KEY` at module load. The setup
 * script doesn't actually encrypt anything — it just runs DDL — but
 * we need to satisfy the config check. Set defaults BEFORE any other
 * module loads. Dynamic imports below keep this assignment effective
 * even though ESM imports are hoisted.
 */
process.env["DKIM_ENCRYPTION_KEY"] ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const POSTGRES_USER = process.env["POSTGRES_USER"] ?? "bunmail";
const POSTGRES_PASSWORD = process.env["POSTGRES_PASSWORD"] ?? "bunmail";
const POSTGRES_HOST = process.env["POSTGRES_HOST"] ?? "localhost";
const POSTGRES_PORT = process.env["POSTGRES_PORT"] ?? "5432";

const adminUrl = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/postgres`;
const testDbUrl = `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/bunmail_test`;

/** Lock DATABASE_URL to the test DB before the migrator's config loads. */
process.env["DATABASE_URL"] = testDbUrl;

const { logger } = await import("../../src/utils/logger.ts");

logger.info("Setup: connecting to admin DB", {
  url: adminUrl.replace(POSTGRES_PASSWORD, "***"),
});

const { SQL } = await import("bun");
const admin = new SQL(adminUrl);

const existing = await admin<{ datname: string }[]>`
  SELECT datname FROM pg_database WHERE datname = 'bunmail_test'
`;

if (existing.length === 0) {
  logger.info("Setup: creating database bunmail_test");
  /** CREATE DATABASE can't run inside a transaction. The Bun.SQL pool
   *  is auto-commit by default, so this works as-is. */
  await admin.unsafe("CREATE DATABASE bunmail_test");
} else {
  logger.info("Setup: database bunmail_test already exists — leaving in place");
}

await admin.close();

logger.info("Setup: applying migrations to bunmail_test");
const { runMigrations } = await import("../../src/db/migrate.ts");
const result = await runMigrations(testDbUrl);

logger.info("Setup: done", {
  applied: result.applied.length,
  baselined: result.baselined.length,
  alreadyApplied: result.alreadyApplied.length,
});
process.exit(0);

/** Top-level await requires the file be a module. No static imports/
 *  exports exist (we use dynamic import everywhere to control eval
 *  order), so add an empty export to satisfy the TS module check. */
export {};
