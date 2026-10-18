/**
 * Boot-time pass that encrypts any `webhooks.secret` values still stored
 * as plaintext (#259), the webhook counterpart of `encrypt-domain-keys.ts`.
 * Idempotent: rows already in the `v1:...` encrypted-secret format are
 * skipped.
 *
 * Why: a webhook signing secret lets anyone sign requests that every
 * receiver accepts as genuine (fake `email.bounced`, `email.received`).
 * Encrypted with `DKIM_ENCRYPTION_KEY`, a database dump or backup without
 * the `.env` no longer yields them. Runs at startup, before the webhook
 * worker, for the same reason as the DKIM pass: the key comes from the
 * environment, which SQL migrations cannot read.
 *
 * Safety: each row is its own UPDATE, guarded on the plaintext it read,
 * so a concurrent replica's pass cannot encrypt a row twice; a failure on
 * one row logs and continues, and the next start retries it.
 */

import { and, eq } from "drizzle-orm";
import { db } from "./index.ts";
import { webhooks } from "../modules/webhooks/models/webhook.schema.ts";
import { encryptSecret, isEncryptedSecret } from "../utils/crypto.ts";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";

export async function encryptWebhookSecrets(): Promise<{
  encrypted: number;
  skipped: number;
}> {
  const rows = await db
    .select({ id: webhooks.id, secret: webhooks.secret })
    .from(webhooks);

  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    if (isEncryptedSecret(row.secret)) {
      skipped += 1;
      continue;
    }

    try {
      const ciphertext = encryptSecret(row.secret, config.dkimEncryptionKey);
      const updated = await db
        .update(webhooks)
        .set({ secret: ciphertext })
        .where(and(eq(webhooks.id, row.id), eq(webhooks.secret, row.secret)))
        .returning({ id: webhooks.id });
      if (updated.length === 0) {
        /** Encrypted (or removed) by another replica meanwhile. */
        skipped += 1;
        continue;
      }
      encrypted += 1;
      logger.info("Encrypted webhook signing secret at rest", { webhookId: row.id });
    } catch (err) {
      /**
       * Log and continue rather than throw: one row's failure shouldn't
       * block the rest of the boot. The next start will retry it.
       */
      logger.error("Failed to encrypt webhook signing secret", {
        webhookId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (encrypted > 0) {
    logger.info("Webhook signing secrets encrypted at rest", { encrypted, skipped });
  } else {
    logger.debug("No webhook signing secrets needed encryption", { skipped });
  }

  return { encrypted, skipped };
}

/** Direct entry point: `bun run src/db/encrypt-webhook-secrets.ts`, e.g. after a key rotation. */
if (import.meta.main) {
  await encryptWebhookSecrets();
  process.exit(0);
}
