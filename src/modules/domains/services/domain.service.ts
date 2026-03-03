import { eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { domains } from "../models/domain.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import type { Domain, CreateDomainInput } from "../types/domain.types.ts";

/**
 * Creates a new domain record.
 *
 * Inserts the domain name with default verification flags (all false).
 * DKIM key generation is not implemented yet — will come in a later phase.
 *
 * @param input - The domain name to register
 * @returns The newly created domain row
 */
export async function createDomain(input: CreateDomainInput): Promise<Domain> {
  /** Generate a unique prefixed ID for this domain */
  const id = generateId("dom");

  logger.info("Creating domain", { id, name: input.name });

  const [domain] = await db
    .insert(domains)
    .values({
      id,
      name: input.name,
    })
    .returning();

  logger.info("Domain created", { id: domain!.id, name: domain!.name });

  return domain!;
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

  const [domain] = await db
    .select()
    .from(domains)
    .where(eq(domains.id, id));

  if (!domain) {
    logger.debug("Domain not found", { id });
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

  const [domain] = await db
    .delete(domains)
    .where(eq(domains.id, id))
    .returning();

  if (!domain) {
    logger.warn("Domain not found for deletion", { id });
    return undefined;
  }

  logger.info("Domain deleted", { id: domain.id, name: domain.name });

  return domain;
}
