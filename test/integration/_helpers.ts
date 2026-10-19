/**
 * Shared utilities for integration tests. Each test file imports the
 * helpers it needs:
 *
 *   - `truncateAll()`: wipe every test-scoped table; call from `beforeEach`
 *   - `seed.*`: factory functions returning fully-formed rows
 *   - `closeDb()`: close the SQL pool; call from `afterAll`
 *
 * The helpers use the **same `db` singleton** the production code uses:
 * `_preload.ts` has already pointed it at `bunmail_test`. That means
 * service-layer code under test runs against real Postgres with real
 * Drizzle queries; tests catch SQL bugs, FK behaviour, constraint
 * violations, and transactional semantics that mocked-DB tests can't.
 */

import { sql as drizzleSql, type SQL } from "drizzle-orm";
import { hashApiKey, generateApiKey, encryptSecret } from "../../src/utils/crypto.ts";
import { generateId } from "../../src/utils/id.ts";
import { db } from "../../src/db/index.ts";
import { apiKeys } from "../../src/modules/api-keys/models/api-key.schema.ts";
import { domains } from "../../src/modules/domains/models/domain.schema.ts";
import { emails } from "../../src/modules/emails/models/email.schema.ts";
import { suppressions } from "../../src/modules/suppressions/models/suppression.schema.ts";
import { templates } from "../../src/modules/templates/models/template.schema.ts";
import { webhooks } from "../../src/modules/webhooks/models/webhook.schema.ts";
import { webhookDeliveries } from "../../src/modules/webhooks/models/webhook-delivery.schema.ts";
import { users } from "../../src/modules/users/models/user.schema.ts";
import { userCredentials } from "../../src/modules/users/models/user-credential.schema.ts";
import { sessions } from "../../src/modules/users/models/session.schema.ts";
import { hashPassword } from "../../src/modules/users/services/password.service.ts";
import { hashToken, mintToken } from "../../src/modules/users/services/token.service.ts";
import type {
  SessionAssurance,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";
import { config } from "../../src/config.ts";

/** Database names the integration helpers may wipe. */
const WIPEABLE_DATABASE_RE = /_(test|scratch)$/;

/**
 * Refuses to wipe anything but a `*_test` or `*_scratch` database. The
 * preload points `db` at one, but a test file run without it (a bare
 * `bun test test/integration/x.test.ts` in a shell that loaded `.env`)
 * would reach the dev database, and `truncateAll` would erase it. This
 * check sits where the damage happens, so no entry point can skip it.
 */
function assertWipeableDatabase(): void {
  const name = new URL(config.database.url).pathname.replace(/^\//, "");
  if (!WIPEABLE_DATABASE_RE.test(name)) {
    throw new Error(
      `Refusing to truncate database "${name}": integration tests only run against a *_test or *_scratch database. Use bun run test:integration.`,
    );
  }
}

/**
 * Wipe every test-relevant table in dependency order. Trash purge state
 * and the migrations bookkeeping table are intentionally NOT truncated:
 * the schema is set up by
 * `scripts/test-integration-setup.ts` (or `db:migrate` in CI) and
 * persists across test runs to keep the suite fast.
 *
 * `CASCADE` ensures that if any test row picks up an unexpected FK
 * dependency, the truncate still completes; better than a flaky failure
 * later that's hard to attribute.
 *
 * `inbound_emails` is listed before `emails` on purpose (#192): it
 * references `emails`, and Postgres locks the listed tables in order. An
 * inbound insert still finishing from the previous test holds
 * `inbound_emails` and then needs `emails` for its foreign key check, so
 * locking `emails` first (as a bare `CASCADE` from `emails` would) can
 * deadlock; this order makes the truncate wait for it instead.
 */
export async function truncateAll(): Promise<void> {
  assertWipeableDatabase();
  await db.execute(
    drizzleSql`TRUNCATE TABLE
      audit_events,
      user_devices,
      user_recovery_codes,
      user_tokens,
      sessions,
      user_credentials,
      users,
      suppressions,
      idempotency_keys,
      inbound_emails,
      emails,
      email_tombstones,
      webhooks,
      templates,
      domains,
      api_keys
    RESTART IDENTITY CASCADE`,
  );
}

/** Closes the SQL pool. Call from `afterAll` to keep test runs clean. */
export async function closeDb(): Promise<void> {
  /**
   * `drizzle/bun-sql` doesn't expose the underlying client directly via
   * the `db` export. The pool will close at process exit. We don't need
   * to do anything per-test; this stub is here to make tests' intent
   * explicit and make a future close-helper easy to add.
   */
}

/* ─── Factories ─── */

export const seed = {
  /**
   * Insert a real api_keys row. Returns the row plus the raw key string
   * (only available at creation time, never stored). Tests that need
   * an authenticated key fixture pull this; the FK from emails /
   * suppressions / webhooks / templates → api_keys is a real one in
   * the test DB.
   */
  async apiKey(
    opts: {
      name?: string;
      isAdmin?: boolean;
      /** The dashboard user it belongs to (#219); null (default) = the owner. */
      createdByUserId?: string | null;
      isActive?: boolean;
      disabledReason?: "revoked" | "creator_deactivated" | "creator_removed" | null;
    } = {},
  ): Promise<{
    id: string;
    rawKey: string;
    keyPrefix: string;
  }> {
    const { raw, hash, prefix } = generateApiKey();
    const id = generateId("key");
    await db.insert(apiKeys).values({
      id,
      name: opts.name ?? "test-key",
      keyHash: hash,
      keyPrefix: prefix,
      isAdmin: opts.isAdmin ?? false,
      createdByUserId: opts.createdByUserId ?? null,
      isActive: opts.isActive ?? true,
      disabledReason: opts.disabledReason ?? null,
    });
    return { id, rawKey: raw, keyPrefix: prefix };
  },

  /**
   * Insert a domain row with a freshly generated DKIM keypair. The
   * private key is encrypted with the test's `DKIM_ENCRYPTION_KEY`
   * exactly the way the production `createDomain` does it, so tests
   * exercising the decrypt path see realistic ciphertext.
   */
  async domain(
    opts: {
      name?: string;
      privateKeyPem?: string;
      publicKeyPem?: string;
      selector?: string;
      unsubscribeEmail?: string | null;
      unsubscribeUrl?: string | null;
      /** Who added it (#219); null (default) = the owner. */
      createdByUserId?: string | null;
    } = {},
  ): Promise<{ id: string; name: string }> {
    const id = generateId("dom");
    const name = opts.name ?? `example-${Date.now()}.com`;
    const privateKeyPem =
      opts.privateKeyPem ??
      "-----BEGIN PRIVATE KEY-----\nFAKE-FOR-TEST-DO-NOT-USE\n-----END PRIVATE KEY-----";
    const publicKeyPem =
      opts.publicKeyPem ?? "-----BEGIN PUBLIC KEY-----\nFAKE\n-----END PUBLIC KEY-----";
    const encryptedPrivate = encryptSecret(privateKeyPem, config.dkimEncryptionKey);
    await db.insert(domains).values({
      id,
      name,
      dkimPrivateKey: encryptedPrivate,
      dkimPublicKey: publicKeyPem,
      dkimSelector: opts.selector ?? "bunmail",
      unsubscribeEmail: opts.unsubscribeEmail ?? null,
      unsubscribeUrl: opts.unsubscribeUrl ?? null,
      createdByUserId: opts.createdByUserId ?? null,
    });
    return { id, name };
  },

  /** Insert an email row in `queued` status. */
  async email(opts: {
    apiKeyId: string;
    domainId?: string | null;
    fromAddress?: string;
    toAddress?: string;
    cc?: string | null;
    bcc?: string | null;
    subject?: string;
    status?: "queued" | "sending" | "sent" | "failed" | "bounced";
    messageId?: string | null;
  }): Promise<{ id: string }> {
    const id = generateId("msg");
    await db.insert(emails).values({
      id,
      apiKeyId: opts.apiKeyId,
      domainId: opts.domainId ?? null,
      fromAddress: opts.fromAddress ?? "hello@example.com",
      toAddress: opts.toAddress ?? "user@example.com",
      cc: opts.cc ?? null,
      bcc: opts.bcc ?? null,
      subject: opts.subject ?? "test",
      html: "<p>test</p>",
      textContent: "test",
      status: opts.status ?? "queued",
      messageId: opts.messageId ?? null,
    });
    return { id };
  },

  /**
   * Insert a webhook subscription, so `enqueueEvent` (the outbox insert,
   * #184) has a webhook to fan an event out to.
   */
  async webhook(opts: {
    apiKeyId: string;
    url: string;
    events: string[];
    secret?: string;
    /** Who created it (#219); null (default) = the owner. */
    createdByUserId?: string | null;
    /** Store the secret in plaintext, like a row from before #259. */
    storePlaintext?: boolean;
  }): Promise<{ id: string; secret: string }> {
    const id = generateId("whk");
    const secret = opts.secret ?? "test-secret-32-bytes-of-padding-here";
    await db.insert(webhooks).values({
      id,
      apiKeyId: opts.apiKeyId,
      url: opts.url,
      events: opts.events,
      /** Encrypted at rest like `createWebhook` (#259); the plaintext is returned. */
      secret: opts.storePlaintext
        ? secret
        : encryptSecret(secret, config.dkimEncryptionKey),
      createdByUserId: opts.createdByUserId ?? null,
    });
    return { id, secret };
  },

  /**
   * Insert a template row.
   */
  async template(opts: {
    apiKeyId: string;
    name?: string;
    subject?: string;
    html?: string;
    text?: string;
    variables?: string[];
    /** Who created it (#219); null (default) = the owner. */
    createdByUserId?: string | null;
  }): Promise<{ id: string }> {
    const id = generateId("tpl");
    await db.insert(templates).values({
      id,
      apiKeyId: opts.apiKeyId,
      name: opts.name ?? "test-template",
      subject: opts.subject ?? "Hi {{name}}",
      html: opts.html ?? "<p>Hi {{name}}</p>",
      textContent: opts.text ?? "Hi {{name}}",
      variables: opts.variables ?? ["name"],
      createdByUserId: opts.createdByUserId ?? null,
    });
    return { id };
  },

  /**
   * Insert a suppression directly. Useful when seeding state for the
   * email-create gate test without going through the addFromBounce
   * upsert path.
   */
  async suppression(opts: {
    apiKeyId: string;
    email: string;
    reason?: "bounce" | "complaint" | "manual" | "unsubscribe";
    bounceType?: "hard" | "soft" | null;
    expiresAt?: Date | null;
  }): Promise<{ id: string }> {
    const id = generateId("sup");
    await db.insert(suppressions).values({
      id,
      apiKeyId: opts.apiKeyId,
      email: opts.email.trim().toLowerCase(),
      reason: opts.reason ?? "manual",
      bounceType: opts.bounceType ?? null,
      expiresAt: opts.expiresAt ?? null,
    });
    return { id };
  },

  /**
   * Insert the dashboard owner (#215), optionally with a `password`
   * credential (argon2id, like owner setup writes it), i.e. setup already
   * completed. The email is lower-cased as `users.email` requires.
   */
  async owner(opts: { email: string; password?: string }): Promise<{ id: string }> {
    return seed.user({ ...opts, role: "owner" });
  },

  /**
   * Insert a dashboard user (#216) of any role, optionally with a
   * `password` credential (argon2id) and optionally disabled.
   */
  async user(opts: {
    email: string;
    role?: UserRole;
    password?: string;
    disabledAt?: Date;
  }): Promise<{ id: string }> {
    const id = generateId("usr");
    await db.insert(users).values({
      id,
      email: opts.email.trim().toLowerCase(),
      role: opts.role ?? "member",
      disabledAt: opts.disabledAt ?? null,
    });
    if (opts.password !== undefined) {
      await db.insert(userCredentials).values({
        id: generateId("crd"),
        userId: id,
        type: "password",
        secretHash: await hashPassword(opts.password),
      });
    }
    return { id };
  },

  /**
   * Insert a dashboard session (#216) and return its raw cookie token
   * (only the hash is stored). Times default to a fresh, live session;
   * pass SQL such as `sql\`now() - interval '2 minutes'\`` to age one.
   */
  async session(opts: {
    userId: string;
    assurance?: SessionAssurance;
    expiresAt?: SQL | Date;
    lastSeenAt?: SQL | Date;
    createdAt?: SQL | Date;
    rotatedAt?: SQL | Date | null;
    previousToken?: string | null;
    /** `user_credentials.id` the session is bound to (#277); none by default. */
    credentialId?: string | null;
  }): Promise<{ id: string; token: string }> {
    const { token, hash } = mintToken();
    const id = generateId("ses");
    await db.insert(sessions).values({
      id,
      userId: opts.userId,
      tokenHash: hash,
      assurance: opts.assurance ?? "password",
      authMethod: "password",
      expiresAt: opts.expiresAt ?? drizzleSql`now() + interval '1 day'`,
      lastSeenAt: opts.lastSeenAt ?? drizzleSql`now()`,
      createdAt: opts.createdAt ?? drizzleSql`now()`,
      rotatedAt: opts.rotatedAt ?? null,
      credentialId: opts.credentialId ?? null,
      previousTokenHash:
        opts.previousToken === undefined || opts.previousToken === null
          ? null
          : hashToken(opts.previousToken),
    });
    return { id, token };
  },
};

/**
 * Insert one `pending` delivery row for `webhookId` directly, the shape
 * `enqueueEvent` writes (#184): the worker, replay and retention tests
 * need a delivery without going through an event's transaction.
 */
export async function enqueueDelivery(opts: {
  webhookId: string;
  envelope: { event: string; timestamp: string; data: Record<string, unknown> };
}): Promise<{ id: string }> {
  const id = generateId("wdl");
  await db.insert(webhookDeliveries).values({
    id,
    webhookId: opts.webhookId,
    event: opts.envelope.event,
    payload: JSON.stringify(opts.envelope),
  });
  return { id };
}

/** Tables a test may make a write fail on, and the column it matches. */
type FailableTable = "webhook_deliveries" | "emails" | "suppressions" | "inbound_emails";

/** Triggers installed by {@link failWritesWhere} and not removed yet. */
const injectedTriggers: Array<{ table: FailableTable; name: string }> = [];

/**
 * Test seam for the webhook outbox (#184): makes every INSERT or UPDATE of
 * a `table` row whose columns equal all of `match` fail with SQLSTATE
 * `P0001` (`injected failure`).
 *
 * - default: a `BEFORE` row trigger, so the statement itself throws (an
 *   outbox insert, or the state change, fails mid-transaction);
 * - `deferred`: a constraint trigger `INITIALLY DEFERRED`, so every
 *   statement succeeds and the transaction fails at COMMIT, the last
 *   moment before the state change and its events would be durable.
 *
 * Matching one row's values keeps other rows unaffected. Remove the
 * triggers with {@link removeInjectedFailures} (in `afterEach`).
 */
export async function failWritesWhere(
  table: FailableTable,
  match: Record<string, string>,
  opts: { deferred?: boolean } = {},
): Promise<void> {
  assertWipeableDatabase();
  const conditions = Object.entries(match).map(([column, value]) => {
    if (!/^[a-z_]+$/.test(column)) throw new Error(`bad column name ${column}`);
    return `NEW.${column} = '${value.replaceAll("'", "''")}'`;
  });
  if (conditions.length === 0) throw new Error("failWritesWhere needs a match");
  const name = `test_fail_${generateId("wdl").slice(4)}`;
  await db.execute(
    drizzleSql.raw(`CREATE OR REPLACE FUNCTION bunmail_test_injected_failure() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected failure'; END $$`),
  );
  const timing = opts.deferred
    ? `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT OR UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED`
    : `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${table}`;
  await db.execute(
    drizzleSql.raw(
      `${timing} FOR EACH ROW WHEN (${conditions.join(" AND ")}) EXECUTE FUNCTION bunmail_test_injected_failure()`,
    ),
  );
  injectedTriggers.push({ table, name });
}

/** Drops every trigger {@link failWritesWhere} installed. */
export async function removeInjectedFailures(): Promise<void> {
  for (const { table, name } of injectedTriggers.splice(0)) {
    await db.execute(drizzleSql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}`));
  }
}

/**
 * Re-export the `db` instance and the schema tables so tests can read
 * back state for assertions without re-importing from src/.
 */
export { db, apiKeys, domains, emails, suppressions, templates, webhooks, sessions };
export { hashApiKey };
