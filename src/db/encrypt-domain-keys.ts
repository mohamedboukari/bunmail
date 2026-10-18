/**
 * Boot-time pass that encrypts any `domains.dkim_private_key` values
 * still stored as plaintext PEM. Idempotent: rows whose key matches the
 * `v1:...` encrypted-secret format are skipped.
 *
 * Why a TS hook rather than a SQL migration:
 *   The encryption needs `config.dkimEncryptionKey`, which is read from
 *   the environment at process start. SQL migrations have no access to
 *   it. Running this at startup (before the queue picks up traffic)
 *   means an operator who upgrades to this version with a fresh
 *   `DKIM_ENCRYPTION_KEY` set sees their existing rows re-keyed
 *   automatically: no separate command, no manual step.
 *
 * Safety:
 *   Each row is wrapped in its own UPDATE; a failure on one row logs
 *   and continues, so a single corrupt row can't block the whole boot.
 *   Encryption is in-place: the plaintext PEM is overwritten with the
 *   `v1:` ciphertext.
 */

import { eq, isNotNull } from "drizzle-orm";
import { db } from "./index.ts";
import { domains } from "../modules/domains/models/domain.schema.ts";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../utils/crypto.ts";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";

export async function encryptDomainKeys(): Promise<{
  encrypted: number;
  skipped: number;
}> {
  const rows = await db
    .select({
      id: domains.id,
      name: domains.name,
      dkimPrivateKey: domains.dkimPrivateKey,
    })
    .from(domains)
    .where(isNotNull(domains.dkimPrivateKey));

  let encrypted = 0;
  let skipped = 0;

  for (const row of rows) {
    const key = row.dkimPrivateKey;
    if (key === null) {
      skipped += 1;
      continue;
    }

    if (isEncryptedSecret(key)) {
      skipped += 1;
      continue;
    }

    try {
      const ciphertext = encryptSecret(key, config.dkimEncryptionKey);
      await db
        .update(domains)
        .set({ dkimPrivateKey: ciphertext })
        .where(eq(domains.id, row.id));
      encrypted += 1;
      logger.info("Encrypted DKIM private key at rest", {
        domainId: row.id,
        name: row.name,
      });
    } catch (err) {
      /**
       * Log and continue rather than throw: one row's failure shouldn't
       * block the rest of the boot. The next start will retry it.
       */
      logger.error("Failed to encrypt DKIM private key", {
        domainId: row.id,
        name: row.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (encrypted > 0) {
    logger.info("DKIM private keys encrypted at rest", { encrypted, skipped });
  } else {
    logger.debug("No DKIM keys needed encryption", { skipped });
  }

  return { encrypted, skipped };
}

/**
 * Names of the domains whose stored DKIM key does not decrypt with the
 * current `DKIM_ENCRYPTION_KEY` (#244): a regenerated `.env`, or a key
 * rotation that skipped re-encryption. Run at boot after
 * {@link encryptDomainKeys}; production refuses to start on any (see
 * `src/index.ts`), since every send from those domains would otherwise be
 * held rather than signed. Never logs or returns key material.
 */
export async function findUndecryptableDomainKeys(): Promise<string[]> {
  const rows = await db
    .select({ name: domains.name, dkimPrivateKey: domains.dkimPrivateKey })
    .from(domains)
    .where(isNotNull(domains.dkimPrivateKey));

  const unreadable: string[] = [];
  for (const row of rows) {
    if (row.dkimPrivateKey === null || !isEncryptedSecret(row.dkimPrivateKey)) continue;
    try {
      decryptSecret(row.dkimPrivateKey, config.dkimEncryptionKey);
    } catch {
      unreadable.push(row.name);
    }
  }
  return unreadable;
}

/**
 * Direct entry-point: `bun run src/db/encrypt-domain-keys.ts`: useful
 * for manual re-runs (e.g. after a key rotation when re-encrypting in
 * place from a known plaintext snapshot, or for verification).
 */
if (import.meta.main) {
  await encryptDomainKeys();
  process.exit(0);
}
