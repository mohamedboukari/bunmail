import { generateKeyPair } from "crypto";
import { DrizzleQueryError, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { domains } from "../models/domain.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { encryptSecret } from "../../../utils/crypto.ts";
import { config } from "../../../config.ts";
import type { Domain, CreateDomainInput } from "../types/domain.types.ts";
import { DomainAlreadyRegisteredError } from "../errors.ts";

/** Postgres SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Matches a domain row by name, case-insensitively: DNS names are, and
 * rows created before names were stored lowercase may carry capitals.
 */
export function domainNameIs(name: string): SQL {
  return sql`lower(${domains.name}) = ${name.trim().toLowerCase()}`;
}

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
  /** Stored lowercase: DNS names are case-insensitive. */
  const name = input.name.trim().toLowerCase();

  const [existing] = await db
    .select({ id: domains.id })
    .from(domains)
    .where(domainNameIs(name))
    .limit(1);
  if (existing) {
    logger.warn("Domain not created: already registered", {
      name,
      existingId: existing.id,
    });
    throw new DomainAlreadyRegisteredError(name);
  }

  logger.info("Creating domain with DKIM keys", { id, name });

  const { privateKey, publicKey } = await generateDkimKeyPair();

  /**
   * Encrypt the PEM-encoded private key with AES-256-GCM before it ever
   * touches the database. The plaintext PEM only lives in memory inside
   * this function and is never logged. Public key stays plaintext: it's
   * literally published in DNS, no threat in storing it raw.
   */
  const encryptedPrivateKey = encryptSecret(privateKey, config.dkimEncryptionKey);

  let inserted: Domain[];
  try {
    inserted = await db
      .insert(domains)
      .values({
        id,
        name,
        dkimPrivateKey: encryptedPrivateKey,
        dkimPublicKey: publicKey,
        dkimSelector: "bunmail",
        unsubscribeEmail: input.unsubscribeEmail ?? null,
        unsubscribeUrl: input.unsubscribeUrl ?? null,
        notifyEmail: input.notifyEmail ?? null,
        createdByUserId: input.createdByUserId ?? null,
      })
      .returning();
  } catch (error: unknown) {
    /** A concurrent registration of the same name won the race. */
    const sqlState =
      error instanceof DrizzleQueryError &&
      typeof error.cause === "object" &&
      error.cause !== null
        ? Reflect.get(error.cause, "errno")
        : undefined;
    if (sqlState === UNIQUE_VIOLATION) throw new DomainAlreadyRegisteredError(name);
    throw error;
  }
  const [domain] = inserted;

  logger.info("Domain created with DKIM keys", {
    id: domain!.id,
    name: domain!.name,
    createdByUserId: domain!.createdByUserId,
  });

  return domain!;
}

/**
 * The SPF record to suggest for a domain (#247): authorizes this server
 * by its hostname (`a:MAIL_HOSTNAME`, the same name the PTR must carry),
 * instead of a `<YOUR_SERVER_IP>` placeholder that operators pasted as
 * is. A domain with an existing SPF record must merge the `a:` term into
 * it: two records are a permerror.
 */
export function suggestedSpfRecord(hostname: string = config.mail.hostname): string {
  return `v=spf1 ${spfAuthorizationTerm(hostname)} -all`;
}

/** The SPF term that authorizes this server (`a:MAIL_HOSTNAME`), to merge into an existing record. */
export function spfAuthorizationTerm(hostname: string = config.mail.hostname): string {
  return `a:${hostname}`;
}

/**
 * Returns the raw base64 public key for DNS TXT record setup.
 * Format: `v=DKIM1; k=rsa; p=<base64>`
 */
export function getDkimDnsRecord(domain: Pick<Domain, "dkimPublicKey">): string | null {
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
 * Retrieves a single domain by its name.
 *
 * Used by the inbound-notification path (#106) to resolve the recipient
 * domain's `notify_email` + DKIM material from the address an inbound
 * message was sent to. Returns the full row (including the encrypted
 * `dkimPrivateKey`) so the caller can sign the notification with the
 * domain's own key.
 *
 * @param name - The domain name (e.g. "example.com")
 * @returns The domain row, or undefined if not found
 */
export async function getDomainByName(name: string): Promise<Domain | undefined> {
  logger.debug("Fetching domain by name", { name });

  const [domain] = await db.select().from(domains).where(domainNameIs(name)).limit(1);

  if (!domain) {
    logger.debug("Domain not found by name", { name });
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
    .where(domainNameIs(name))
    .limit(1);
  return !!domain;
}

/**
 * Updates the inbound-notification address for a domain (#106).
 *
 * Pass a non-empty address to enable inbound notifications for the
 * domain, or `null` to disable them. Returns the updated row, or
 * `undefined` when no domain matches the id.
 *
 * `updatedAt` is bumped so the change is reflected in the audit
 * timestamp, mirroring how other domain mutations behave.
 *
 * @param id - The domain ID to update
 * @param notifyEmail - The address to notify, or null to clear
 * @returns The updated domain row, or undefined if not found
 */
export async function updateDomainNotifyEmail(
  id: string,
  notifyEmail: string | null,
): Promise<Domain | undefined> {
  logger.info("Updating domain notify email", {
    id,
    hasNotifyEmail: notifyEmail !== null,
  });

  const [domain] = await db
    .update(domains)
    .set({ notifyEmail, updatedAt: new Date() })
    .where(eq(domains.id, id))
    .returning();

  if (!domain) {
    logger.warn("Domain not found for notify-email update", { id });
    return undefined;
  }

  return domain;
}

/**
 * Updates a domain's `List-Unsubscribe` overrides (#243). Only the fields
 * present in `changes` are written; `null` clears one.
 *
 * @param id - The domain ID to update
 * @param changes - New `unsubscribeEmail` and/or `unsubscribeUrl`
 * @returns The updated domain row, or undefined if not found
 */
export async function updateDomainUnsubscribe(
  id: string,
  changes: { unsubscribeEmail?: string | null; unsubscribeUrl?: string | null },
): Promise<Domain | undefined> {
  logger.info("Updating domain unsubscribe settings", {
    id,
    fields: Object.keys(changes),
  });

  const [domain] = await db
    .update(domains)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(domains.id, id))
    .returning();

  if (!domain) {
    logger.warn("Domain not found for unsubscribe update", { id });
    return undefined;
  }

  return domain;
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
