import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { decryptSecret, isEncryptedSecret } from "../../../utils/crypto.ts";
import type { DkimOptions } from "../../emails/services/mailer.service.ts";
import type { Domain } from "../types/domain.types.ts";

/**
 * DKIM signing options for mail BunMail sends on its own behalf, outside
 * the queue: inbound notifications (#106) and invitation emails (#217).
 * Extracted from the inbound notifier so both use one implementation.
 *
 * Mirrors the queue's fail-open handling of the stored key: null stays
 * null, plaintext (boot encrypter not yet run) is used as-is with a
 * warning, and a decrypt failure is logged and yields no key. Each caller
 * decides what a missing key means: the notifier sends unsigned, the
 * invite mailer does not send.
 */

/**
 * Decrypts a domain's stored DKIM private key. Never logs the key: only
 * the domain name and the decrypt error.
 */
function decryptDkimPrivateKey(stored: string | null, domainName: string): string | null {
  if (stored === null) return null;
  if (!isEncryptedSecret(stored)) {
    logger.warn("DKIM private key stored as plaintext: boot encrypter has not run", {
      domain: domainName,
    });
    return stored;
  }
  try {
    return decryptSecret(stored, config.dkimEncryptionKey);
  } catch (err) {
    logger.error("Failed to decrypt DKIM private key: no signing key for this message", {
      domain: domainName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Builds DKIM options from a domain row, or `undefined` when it has no usable key. */
export function resolveDomainDkim(domain: Domain): DkimOptions | undefined {
  const privateKey = decryptDkimPrivateKey(domain.dkimPrivateKey, domain.name);
  if (!privateKey) return undefined;
  return {
    domainName: domain.name,
    keySelector: domain.dkimSelector,
    privateKey,
  };
}
