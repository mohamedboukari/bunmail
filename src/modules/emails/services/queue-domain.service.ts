import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { logger } from "../../../utils/logger.ts";
import { decryptSecret, isEncryptedSecret } from "../../../utils/crypto.ts";
import { config } from "../../../config.ts";
import { domainNameIs } from "../../domains/services/domain.service.ts";

/**
 * Subset of the `domains` row used by the queue's DKIM + unsubscribe
 * resolution. Kept narrow so unit tests can build fixtures without
 * faking the full Drizzle row type.
 */
export interface DomainLookupRow {
  name: string;
  dkimSelector: string;
  dkimPrivateKey: string | null;
  /** A key is stored but does not decrypt with `DKIM_ENCRYPTION_KEY` (#244). */
  dkimKeyUnreadable: boolean;
  unsubscribeEmail: string | null;
  unsubscribeUrl: string | null;
}

/**
 * Resolves the `domains` row that should drive DKIM signing and
 * `List-Unsubscribe` overrides for an outbound email.
 *
 * Lookup order:
 *   1. **By `domainId` (canonical)**: the FK stamped on the email row
 *      at create-time. Survives sender renames and is the right answer
 *      even if a future schema allows non-unique names per API key.
 *   2. **By sender domain name (legacy fallback)**, only used when
 *      `domainId` is null, which only happens for rows created before
 *      the FK existed (schema 0001). New rows always carry `domainId`
 *      when the domain is registered.
 *
 * Exported for unit testing, see test/unit/resolve-domain-for-email.test.ts.
 */
export async function resolveDomainForEmail(
  email: { domainId: string | null; fromAddress: string },
  queries: {
    byId: (id: string) => Promise<DomainLookupRow | undefined>;
    byName: (name: string) => Promise<DomainLookupRow | undefined>;
  },
): Promise<DomainLookupRow | undefined> {
  /** Primary path: FK is the canonical pointer. */
  if (email.domainId !== null) {
    return queries.byId(email.domainId);
  }

  /** Legacy fallback: pre-FK rows. Skip if `fromAddress` is malformed. */
  const senderDomain = email.fromAddress.split("@")[1];
  if (!senderDomain) return undefined;
  return queries.byName(senderDomain);
}

/**
 * Decrypts a stored DKIM private key for use with nodemailer's signer.
 *
 * Three input shapes are tolerated:
 *   - `null`: no key on file; returned unchanged so the caller falls
 *     back to unsigned mail.
 *   - encrypted (`v1:...`): the normal post-migration path; AES-256-GCM
 *     decrypted with `config.dkimEncryptionKey`.
 *   - plaintext PEM: possible during the upgrade window before the
 *     boot-time encrypter runs, or if an operator inserted a row by
 *     hand. Logged as a warning so it shows up in incident review,
 *     then returned as-is so the email still signs.
 *
 * On decrypt failure (wrong key, tampered ciphertext) the key is reported
 * as unreadable (#244). The send path then holds the email in production
 * (see {@link holdForUnreadableDkimKey}) rather than sending it unsigned:
 * a wrong `DKIM_ENCRYPTION_KEY` would otherwise strip DKIM from every
 * domain at once while the dashboard still says "verified". Development
 * still sends unsigned.
 */
function readDkimPrivateKey(
  stored: string | null,
  domainName: string,
): { dkimPrivateKey: string | null; dkimKeyUnreadable: boolean } {
  if (stored === null) return { dkimPrivateKey: null, dkimKeyUnreadable: false };

  if (!isEncryptedSecret(stored)) {
    logger.warn("DKIM private key stored as plaintext: boot encrypter has not run", {
      domain: domainName,
    });
    return { dkimPrivateKey: stored, dkimKeyUnreadable: false };
  }

  try {
    return {
      dkimPrivateKey: decryptSecret(stored, config.dkimEncryptionKey),
      dkimKeyUnreadable: false,
    };
  } catch (err) {
    logger.error("Failed to decrypt DKIM private key", {
      domain: domainName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { dkimPrivateKey: null, dkimKeyUnreadable: true };
  }
}

/** Concrete `byId` query against the live Drizzle DB. */
export async function queryDomainById(id: string): Promise<DomainLookupRow | undefined> {
  const [row] = await db
    .select({
      name: domains.name,
      dkimSelector: domains.dkimSelector,
      dkimPrivateKey: domains.dkimPrivateKey,
      unsubscribeEmail: domains.unsubscribeEmail,
      unsubscribeUrl: domains.unsubscribeUrl,
    })
    .from(domains)
    .where(eq(domains.id, id));
  if (!row) return undefined;
  return { ...row, ...readDkimPrivateKey(row.dkimPrivateKey, row.name) };
}

/** Concrete `byName` query against the live Drizzle DB. */
export async function queryDomainByName(
  name: string,
): Promise<DomainLookupRow | undefined> {
  const [row] = await db
    .select({
      name: domains.name,
      dkimSelector: domains.dkimSelector,
      dkimPrivateKey: domains.dkimPrivateKey,
      unsubscribeEmail: domains.unsubscribeEmail,
      unsubscribeUrl: domains.unsubscribeUrl,
    })
    .from(domains)
    .where(domainNameIs(name));
  if (!row) return undefined;
  return { ...row, ...readDkimPrivateKey(row.dkimPrivateKey, row.name) };
}
