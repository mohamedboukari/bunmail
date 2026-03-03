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
}
