import type { domains } from "../models/domain.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

/**
 * The shape of a domain row returned from the database.
 * Inferred directly from the Drizzle schema to stay in sync automatically.
 */
export type Domain = InferSelectModel<typeof domains>;

/**
 * Input required to create a new domain.
 * Only the domain name is needed — DKIM key generation comes in a later phase.
 */
export interface CreateDomainInput {
  /** The domain name (e.g. "example.com") */
  name: string;
}
