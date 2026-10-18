import type { apiKeys } from "../models/api-key.schema.ts";
import type { InferSelectModel } from "drizzle-orm";
import type { UserRole } from "../../users/types/user.types.ts";

/**
 * The shape of an API key row returned from the database.
 * Inferred directly from the Drizzle schema to stay in sync automatically.
 */
export type ApiKey = InferSelectModel<typeof apiKeys>;

/**
 * Why a key is inactive (#219), stored in `api_keys.disabled_reason` and
 * enforced by a `CHECK` constraint:
 *
 * - `revoked`: someone revoked the key (dashboard or REST).
 * - `creator_deactivated`: the user who created it was deactivated.
 * - `creator_removed`: the user who created it was removed.
 */
export const API_KEY_DISABLED_REASONS = [
  "revoked",
  "creator_deactivated",
  "creator_removed",
] as const;

/** A value of `API_KEY_DISABLED_REASONS`. */
export type ApiKeyDisabledReason = (typeof API_KEY_DISABLED_REASONS)[number];

/**
 * The signed-in dashboard account acting on API keys (#219), from the
 * guard's `auth`. A `member` sees and manages only the keys it created
 * and can create only restricted keys; admins and the owner manage every
 * key.
 */
export interface KeyActor {
  /** `users.id`; recorded as `created_by_user_id` on a key it creates. */
  id: string;
  /** The account's role, read with the session on every request. */
  role: UserRole;
}

/**
 * Input required to create a new API key.
 * Only a human-readable name is needed: the key itself is auto-generated.
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

  /**
   * Whether the key is an admin key (#130). Defaults to `false`
   * (restricted / send-only). **Operator-only**: the REST create DTO does
   * NOT expose this; it's set solely by the dashboard and the seed script,
   * so an API caller can never mint an admin key.
   */
  isAdmin?: boolean;

  /**
   * The user the key belongs to (#219), for keys created through the REST
   * API: the calling key's own `created_by_user_id` (null = the owner).
   * Ignored when the dashboard passes an actor to `createApiKey`, which
   * records the actor instead.
   */
  createdByUserId?: string | null;
}

/**
 * Fields that can be updated on an existing API key (#126). All optional,
 * only the provided fields change. `allowedSenders` uses replace semantics
 * (the full desired list); add = include an address, remove = omit it.
 */
export interface UpdateApiKeyInput {
  name?: string;
  allowedSenders?: string[];
}

/**
 * Outcome of `setApiKeyAdmin` (#219): the updated key, or why nothing
 * changed. `creator_not_admin`: a promotion of a key whose creator is a
 * member or deactivated.
 */
export type SetApiKeyAdminResult =
  { ok: true; apiKey: ApiKey } | { ok: false; reason: "not_found" | "creator_not_admin" };
