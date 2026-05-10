/**
 * Shared utilities for integration tests. Each test file imports the
 * helpers it needs:
 *
 *   - `truncateAll()`  — wipe every test-scoped table; call from `beforeEach`
 *   - `seed.*`          — factory functions returning fully-formed rows
 *   - `closeDb()`       — close the SQL pool; call from `afterAll`
 *
 * The helpers use the **same `db` singleton** the production code uses —
 * `_preload.ts` has already pointed it at `bunmail_test`. That means
 * service-layer code under test runs against real Postgres with real
 * Drizzle queries; tests catch SQL bugs, FK behaviour, constraint
 * violations, and transactional semantics that mocked-DB tests can't.
 */

import { sql as drizzleSql } from "drizzle-orm";
import { hashApiKey, generateApiKey, encryptSecret } from "../../src/utils/crypto.ts";
import { generateId } from "../../src/utils/id.ts";
import { db } from "../../src/db/index.ts";
import { apiKeys } from "../../src/modules/api-keys/models/api-key.schema.ts";
import { domains } from "../../src/modules/domains/models/domain.schema.ts";
import { emails } from "../../src/modules/emails/models/email.schema.ts";
import { suppressions } from "../../src/modules/suppressions/models/suppression.schema.ts";
import { templates } from "../../src/modules/templates/models/template.schema.ts";
import { webhooks } from "../../src/modules/webhooks/models/webhook.schema.ts";
import { config } from "../../src/config.ts";

/**
 * Wipe every test-relevant table in dependency order. Inbound emails,
 * trash purge state, and the migrations bookkeeping table are
 * intentionally NOT truncated — the schema is set up by
 * `scripts/test-integration-setup.ts` (or `db:migrate` in CI) and
 * persists across test runs to keep the suite fast.
 *
 * `CASCADE` ensures that if any test row picks up an unexpected FK
 * dependency, the truncate still completes; better than a flaky failure
 * later that's hard to attribute.
 */
export async function truncateAll(): Promise<void> {
  await db.execute(
    drizzleSql`TRUNCATE TABLE
      suppressions,
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
  async apiKey(opts: { name?: string } = {}): Promise<{
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
    });
    return { id, name };
  },

  /** Insert an email row in `queued` status. */
  async email(opts: {
    apiKeyId: string;
    domainId?: string | null;
    fromAddress?: string;
    toAddress?: string;
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
      subject: opts.subject ?? "test",
      html: "<p>test</p>",
      textContent: "test",
      status: opts.status ?? "queued",
      messageId: opts.messageId ?? null,
    });
    return { id };
  },

  /**
   * Insert a webhook subscription. Used by the dispatch integration
   * test so the lookup query (`findWebhooksForEvent`) finds something.
   */
  async webhook(opts: {
    apiKeyId: string;
    url: string;
    events: string[];
    secret?: string;
  }): Promise<{ id: string; secret: string }> {
    const id = generateId("whk");
    const secret = opts.secret ?? "test-secret-32-bytes-of-padding-here";
    await db.insert(webhooks).values({
      id,
      apiKeyId: opts.apiKeyId,
      url: opts.url,
      events: opts.events,
      secret,
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
};

/**
 * Re-export the `db` instance and the schema tables so tests can read
 * back state for assertions without re-importing from src/.
 */
export { db, apiKeys, domains, emails, suppressions, templates, webhooks };
export { hashApiKey };
