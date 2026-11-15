/**
 * Concurrent migration runs (#175), against real Postgres.
 *
 * Every app container runs the migrator on start, so `--scale app=2` or a
 * rolling deploy starts two runs at once. Without the advisory lock, one of
 * them crashed (a duplicate-key error in pg_type from the racy bootstrap
 * CREATE TABLE IF NOT EXISTS). Each test uses a throwaway database.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { SQL } from "bun";
import { runMigrations } from "../../src/db/migrate.ts";

const base = new URL(process.env["DATABASE_URL"] ?? "");

/**
 * Every test here creates databases and runs the whole migration chain,
 * often twice at once; that outgrew Bun's 5 s default as migrations were
 * added (0016, 0017) and timed out intermittently. Per test, not global.
 */
const MIGRATION_TEST_TIMEOUT_MS = 60_000;

/**
 * Dropping the seven throwaway databases: each DROP DATABASE waits for a
 * cluster-wide checkpoint, which is slow while other runs write to the
 * same Postgres server (#443: parallel runs), and overran 60 s there.
 */
const CLEANUP_TIMEOUT_MS = 300_000;

/** URL for another database on the same server. */
function dbUrl(name: string): string {
  const u = new URL(base.href);
  u.pathname = `/${name}`;
  return u.href;
}

/**
 * The throwaway databases are named after this run's own database, the
 * last path segment of the integration URL (`bunmail_test_ml_1`,
 * `bunmail_x_scratch_ml_ok`), so two runs on one Postgres server against
 * two databases at once never drop each other's (#443); the cleanup drops
 * only the names this run created. The name goes into DDL unquoted, so it
 * must be lowercase letters, digits and underscores, within Postgres's
 * 63-character identifier limit, or the test fails loudly.
 *
 * @param suffix - What the database is for, e.g. `1` or `ok`
 */
function throwawayName(suffix: string): string {
  const name = `${base.pathname.slice(1)}_ml_${suffix}`;
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) {
    throw new Error(`unusable throwaway database name "${name}"`);
  }
  return name;
}

const admin = new SQL({ url: dbUrl("postgres"), max: 1 });
const created: string[] = [];

/** Creates an empty throwaway database and returns its URL. */
async function freshDb(name: string): Promise<string> {
  await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  created.push(name);
  return dbUrl(name);
}

/** True if a NEW session can take the migration lock right now. */
async function lockIsFree(url: string): Promise<boolean> {
  const probe = new SQL({ url, max: 1 });
  try {
    const [row] = await probe<{ got: boolean }[]>`
      SELECT pg_try_advisory_lock(hashtext('bunmail:migrations')) AS got
    `;
    if (row?.got) await probe`SELECT pg_advisory_unlock(hashtext('bunmail:migrations'))`;
    return row?.got === true;
  } finally {
    await probe.close();
  }
}

afterAll(async () => {
  for (const name of created)
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.close();
}, CLEANUP_TIMEOUT_MS);

describe("migration advisory lock (#175)", () => {
  test(
    "two concurrent runs both succeed; exactly one applies everything",
    async () => {
      for (let trial = 1; trial <= 5; trial++) {
        const url = await freshDb(throwawayName(String(trial)));
        const [a, b] = await Promise.all([runMigrations(url), runMigrations(url)]);
        const winner = Math.max(a.applied.length, b.applied.length);
        const loser = Math.min(a.applied.length, b.applied.length);

        expect(loser).toBe(0);
        expect(winner).toBeGreaterThan(0);
        /** The loser saw every migration as already applied. */
        expect(Math.max(a.alreadyApplied.length, b.alreadyApplied.length)).toBe(winner);
      }
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the lock is released after a successful run",
    async () => {
      const url = await freshDb(throwawayName("ok"));
      await runMigrations(url);
      expect(await lockIsFree(url)).toBe(true);
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );

  test(
    "the lock is released after a failed run, and a fixed database then migrates",
    async () => {
      const url = await freshDb(throwawayName("fail"));
      /** Pre-create a table migration 0000 also creates (not api_keys, which
       *  would trigger the legacy-schema baseline), so the run fails mid-way. */
      const db = new SQL({ url, max: 1 });
      await db.unsafe(`CREATE TABLE "domains" (id text)`);

      /** Bun's .rejects blocks until the promise settles, so the run is over here. */
      expect(runMigrations(url)).rejects.toThrow();
      expect(await lockIsFree(url)).toBe(true);

      await db.unsafe(`DROP TABLE "domains"`);
      await db.close();
      const result = await runMigrations(url);
      expect(result.applied.length).toBeGreaterThan(0);
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );
});
