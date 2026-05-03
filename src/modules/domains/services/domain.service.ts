import { generateKeyPair } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { domains } from "../models/domain.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { encryptSecret } from "../../../utils/crypto.ts";
import { config } from "../../../config.ts";
import type { Domain, CreateDomainInput } from "../types/domain.types.ts";

/**
 * Generates a 2048-bit RSA keypair for DKIM signing.
 * Returns PEM-encoded private and public keys.
 */
function generateDkimKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  return new Promise((resolve, reject) => {
    generateKeyPair(
      "rsa",
      {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      },
      (err, publicKey, privateKey) => {
        if (err) return reject(err);
        resolve({ privateKey, publicKey });
      },
    );
  });
}

/**
 * Extracts the raw base64 key material from a PEM-encoded public key.
 * This is what goes into the DNS TXT record (`p=...`).
 */
function extractPublicKeyBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s/g, "");
}

/**
 * Creates a new domain record with auto-generated DKIM keys.
 *
 * Generates a 2048-bit RSA keypair for DKIM signing and stores it
 * alongside the domain name. The user must add a DNS TXT record
 * with the public key before DKIM verification can pass.
 *
 * @param input - The domain name to register
 * @returns The newly created domain row
 */
export async function createDomain(input: CreateDomainInput): Promise<Domain> {
  const id = generateId("dom");

  logger.info("Creating domain with DKIM keys", { id, name: input.name });

  const { privateKey, publicKey } = await generateDkimKeyPair();

  /**
   * Encrypt the PEM-encoded private key with AES-256-GCM before it ever
   * touches the database. The plaintext PEM only lives in memory inside
   * this function and is never logged. Public key stays plaintext — it's
   * literally published in DNS, no threat in storing it raw.
   */
  const encryptedPrivateKey = encryptSecret(privateKey, config.dkimEncryptionKey);

  const [domain] = await db
    .insert(domains)
    .values({
      id,
      name: input.name,
      dkimPrivateKey: encryptedPrivateKey,
      dkimPublicKey: publicKey,
      dkimSelector: "bunmail",
      unsubscribeEmail: input.unsubscribeEmail ?? null,
      unsubscribeUrl: input.unsubscribeUrl ?? null,
    })
    .returning();

  logger.info("Domain created with DKIM keys", { id: domain!.id, name: domain!.name });

  return domain!;
}

/**
 * Returns the raw base64 public key for DNS TXT record setup.
 * Format: `v=DKIM1; k=rsa; p=<base64>`
 */
export function getDkimDnsRecord(domain: Domain): string | null {
  if (!domain.dkimPublicKey) return null;
  const b64 = extractPublicKeyBase64(domain.dkimPublicKey);
  return `v=DKIM1; k=rsa; p=${b64}`;
}

/**
 * Lists all registered domains.
 *
 * @returns Array of all domain rows
 */
export async function listDomains(): Promise<Domain[]> {
  logger.debug("Listing all domains");

  const result = await db.select().from(domains);

  logger.debug("Domains listed", { count: result.length });

  return result;
}

/**
 * Retrieves a single domain by its ID.
 *
 * @param id - The domain ID (e.g. "dom_a1b2c3...")
 * @returns The domain row, or undefined if not found
 */
export async function getDomainById(id: string): Promise<Domain | undefined> {
  logger.debug("Fetching domain by ID", { id });

  const [domain] = await db.select().from(domains).where(eq(domains.id, id));

  if (!domain) {
    logger.debug("Domain not found", { id });
  }

  return domain;
}

/**
 * Checks whether a domain name is registered in BunMail.
 * Used by inbound SMTP spam protection to reject mail to unknown domains.
 *
 * @param name - The domain name to check (e.g. "example.com")
 * @returns true if the domain exists in the database
 */
export async function domainExistsByName(name: string): Promise<boolean> {
  const [domain] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(eq(domains.name, name))
    .limit(1);
  return !!domain;
}

/**
 * Deletes a domain by its ID (hard delete).
 *
 * Removes the domain row entirely from the database.
 *
 * @param id - The domain ID to delete
 * @returns The deleted domain row, or undefined if not found
 */
export async function deleteDomain(id: string): Promise<Domain | undefined> {
  logger.info("Deleting domain", { id });

  const [domain] = await db.delete(domains).where(eq(domains.id, id)).returning();

  if (!domain) {
    logger.warn("Domain not found for deletion", { id });
    return undefined;
  }

  logger.info("Domain deleted", { id: domain.id, name: domain.name });

  return domain;
}
