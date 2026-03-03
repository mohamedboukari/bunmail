import type { ApiKey } from "../types/api-key.types.ts";

/**
 * Shape of an API key in API responses.
 * Hides the key_hash — it must never be exposed. Only the prefix is shown
 * so users can identify which key is which (e.g. "bm_live_a1b2").
 */
export interface SerializedApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/**
 * Transforms a raw database API key row into the public API response shape.
 * Strips `keyHash` — the hash is internal and must never leave the server.
 */
export function serializeApiKey(apiKey: ApiKey): SerializedApiKey {
  return {
    id: apiKey.id,
    name: apiKey.name,
    keyPrefix: apiKey.keyPrefix,
    isActive: apiKey.isActive,
    lastUsedAt: apiKey.lastUsedAt,
    createdAt: apiKey.createdAt,
  };
}
