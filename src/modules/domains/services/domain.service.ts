import { DrizzleQueryError, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { domains } from "../models/domain.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { encryptSecret } from "../../../utils/crypto.ts";
import { asciiLowerCase, config } from "../../../config.ts";
import type {
  Domain,
  CreateDomainInput,
  DomainSettingsChanges,
} from "../types/domain.types.ts";
import {
  DomainAlreadyRegisteredError,
  InvalidDkimSelectorError,
  InvalidDomainNameError,
} from "../errors.ts";
import { normalizeDomainName, parseDomainName } from "./domain-name.ts";
import {
  DEFAULT_DKIM_SELECTOR,
  dkimRecordValue,
  generateDkimKeyPair,
  isValidDkimSelector,
} from "./dkim-keys.ts";

/** Postgres SQLSTATE for a unique constraint violation. */
const UNIQUE_VIOLATION = "23505";

/**
 * Matches a domain row by name, case-insensitively: DNS names are, and
 * rows created before names were stored lowercase may carry capitals.
 * The name is normalised as on create (#406), so `Example.COM.` and
 * `example.com` find the same row, and a Unicode IDN finds its A-label.
 * When normalising changes more than the case, the name trimmed and
 * lowercased as before #406 matches too, so a row stored in that form
 * (a final dot, a Unicode name) is still found by every lookup that
 * found it before.
 */
export function domainNameIs(name: string): SQL {
  const normalized = normalizeDomainName(name);
  const asBefore = name.trim().toLowerCase();
  if (normalized === asBefore) return sql`lower(${domains.name}) = ${normalized}`;
  return sql`lower(${domains.name}) in (${normalized}, ${asBefore})`;
}

/**
 * Creates a new domain record with auto-generated DKIM keys.
 *
 * Generates a 2048-bit RSA keypair for DKIM signing and stores it
 * alongside the domain name. The user must add a DNS TXT record
 * with the public key before DKIM verification can pass.
 *
 * The name is normalised, then checked (#406, see `domain-name.ts`): a
 * name that is not a host name throws {@link InvalidDomainNameError}.
 *
 * @param input - The domain name to register
 * @returns The newly created domain row
 */
export async function createDomain(input: CreateDomainInput): Promise<Domain> {
  const id = generateId("dom");
  /**
   * Stored normalised (#406): trimmed, lowercase (DNS names are
   * case-insensitive), no final dot, an IDN as its A-label.
   */
  const name = parseDomainName(input.name);
  if (name === null) {
    /** Not the value itself: it can be anything, the length is enough to investigate. */
    logger.warn("Domain not created: invalid name", { length: input.name.length });
    throw new InvalidDomainNameError();
  }
  /** A DNS label (#250); the DTO checks it too, this covers the dashboard. */
  const dkimSelector = input.dkimSelector ?? DEFAULT_DKIM_SELECTOR;
  if (!isValidDkimSelector(dkimSelector)) {
    logger.warn("Domain not created: invalid DKIM selector", { name });
    throw new InvalidDkimSelectorError();
  }

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

  logger.info("Creating domain with DKIM keys", { id, name, dkimSelector });

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
        dkimSelector,
        unsubscribeEmail: input.unsubscribeEmail ?? null,
        unsubscribeUrl: input.unsubscribeUrl ?? null,
        notifyEmail: input.notifyEmail ?? null,
        trackOpens: input.trackOpens ?? false,
        trackClicks: input.trackClicks ?? false,
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
    trackOpens: domain!.trackOpens,
    trackClicks: domain!.trackClicks,
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
  return dkimRecordValue(domain.dkimPublicKey);
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

/** A stored domain name that domain creation would no longer store as is (#406). */
export interface NonCanonicalDomainName {
  id: string;
  name: string;
  /** What creation would store for it, or `null` when it would refuse it. */
  normalized: string | null;
}

/**
 * The stored domain names that creation would now refuse, or store in
 * another form than case alone (a final dot, a Unicode IDN, spaces): rows
 * created before names were checked (#406). Nothing is changed; the boot
 * reports them.
 */
export async function findNonCanonicalDomainNames(): Promise<NonCanonicalDomainName[]> {
  const rows = await db.select({ id: domains.id, name: domains.name }).from(domains);
  return rows.flatMap((row) => {
    const normalized = parseDomainName(row.name);
    if (normalized !== null && normalized === asciiLowerCase(row.name)) return [];
    return [{ id: row.id, name: row.name, normalized }];
  });
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
 * Updates a domain's settings: the `List-Unsubscribe` overrides (#243)
 * and the open and click tracking opt-in (#187). Only the fields present
 * in `changes` are written; `null` clears an unsubscribe override. A
 * tracking change applies to mail created from then on: queued mail keeps
 * the decision stored on it.
 *
 * @param id - The domain ID to update
 * @param changes - The fields to write
 * @returns The updated domain row, or undefined if not found
 */
export async function updateDomainSettings(
  id: string,
  changes: DomainSettingsChanges,
): Promise<Domain | undefined> {
  logger.info("Updating domain settings", {
    id,
    fields: Object.keys(changes),
    /** Booleans only: the unsubscribe values are never logged. */
    trackOpens: changes.trackOpens,
    trackClicks: changes.trackClicks,
  });

  const [domain] = await db
    .update(domains)
    .set({ ...changes, updatedAt: new Date() })
    .where(eq(domains.id, id))
    .returning();

  if (!domain) {
    logger.warn("Domain not found for settings update", { id });
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
