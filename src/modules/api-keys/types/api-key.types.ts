import type { apiKeys } from "../models/api-key.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

/**
 * The shape of an API key row returned from the database.
 * Inferred directly from the Drizzle schema to stay in sync automatically.
 */
export type ApiKey = InferSelectModel<typeof apiKeys>;

/**
 * Input required to create a new API key.
 * Only a human-readable name is needed — the key itself is auto-generated.
 */
export interface CreateApiKeyInput {
  /** Human-readable label for the key (e.g. "Production Key") */
  name: string;

  /**
   * Optional allowlist of `From` addresses this key may send from (#126).
   * Omit or pass `[]` for unrestricted (any registered domain). Stored
   * lower-cased/trimmed.
   */
  allowedSenders?: string[];
}

/**
 * Fields that can be updated on an existing API key (#126). All optional —
 * only the provided fields change. `allowedSenders` uses replace semantics
 * (the full desired list); add = include an address, remove = omit it.
 */
export interface UpdateApiKeyInput {
  name?: string;
  allowedSenders?: string[];
}
