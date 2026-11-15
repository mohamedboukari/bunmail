/**
 * Test preload: runs before any test file imports the app code.
 *
 * Sets the small handful of required env vars to deterministic values
 * so config evaluation succeeds in any environment (CI, fresh checkout,
 * editor test runner). Real values come from `.env` outside of tests.
 *
 * Wired in via `bunfig.toml` → `[test] preload`.
 */

/**
 * 32 base64-encoded zero bytes. Fine for tests because we never decrypt
 * real production secrets here: the unit tests for `encryptSecret`
 * generate their own ephemeral keys, and the e2e tests don't touch the
 * encrypted-DKIM read path.
 */
process.env["DKIM_ENCRYPTION_KEY"] ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/** Falls back so tests don't need a real DB URL when not exercising it. */
process.env["DATABASE_URL"] ??= "postgres://test:test@localhost:5432/test";

/**
 * No public base URL in tests, as on CI (#420). Bun loads a developer's
 * `.env` before this preload, and an `APP_BASE_URL` there (say
 * `http://localhost:3000`) would make the dashboard same-origin check
 * compare every test POST's `Origin: http://localhost` with that origin
 * and refuse it. Tests that need a base URL set `config.appBaseUrl`
 * themselves.
 */
process.env["APP_BASE_URL"] = "";
