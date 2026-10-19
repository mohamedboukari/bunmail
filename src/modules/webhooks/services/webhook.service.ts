import { eq, and, asc, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "../../../db/index.ts";
import { webhooks } from "../models/webhook.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { InboundEventsRequireAdminError, WebhookLimitReachedError } from "../errors.ts";
import { encryptSecret } from "../../../utils/crypto.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { redactUrl } from "../../../utils/redact.ts";
import { assertPublicWebhookUrl } from "../../../utils/ssrf-guard.ts";
import { config } from "../../../config.ts";
import type { Webhook, CreateWebhookInput } from "../types/webhook.types.ts";

/**
 * Creates a new webhook endpoint.
 * Generates a random signing secret that the consumer uses to verify payloads.
 *
 * @param input - Endpoint URL and subscribed events
 * @param apiKeyId - Owner API key (scopes the events it receives)
 * @param createdByUserId - Who created it (#219): the dashboard user, or
 *   the calling key's user over REST. Attribution only; null = the owner.
 * @returns The webhook row AND the secret (shown once, like API keys).
 */
export async function createWebhook(
  input: CreateWebhookInput,
  apiKeyId: string,
  createdByUserId: string | null = null,
): Promise<{ webhook: Webhook; secret: string }> {
  /**
   * SSRF guard (#128): reject URLs that aren't https (unless http is opted
   * in) or that resolve to a private/loopback/link-local/metadata address,
   * before we ever store or deliver to them. Throws `BlockedUrlError`,
   * mapped to HTTP 422 by the global error handler.
   */
  await assertPublicWebhookUrl(input.url, config.webhookDelivery.allowInsecureHttp);

  const id = generateId("whk");
  const secret = randomBytes(32).toString("hex");
  const maxPerKey = config.webhookDelivery.maxPerApiKey;

  /**
   * The count and the insert run in one transaction holding a lock on the
   * owning key's row (#258), so parallel creates for one key queue up
   * behind each other and cannot all pass the count. `FOR NO KEY UPDATE`
   * leaves foreign-key checks (`FOR KEY SHARE`: this insert, emails sent
   * with the key) unblocked; an update of the key row waits for the
   * few milliseconds the transaction takes.
   */
  const webhook = await db.transaction(async (tx) => {
    const [key] = await tx
      .select({ isAdmin: apiKeys.isAdmin })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .for("no key update");

    /**
     * Inbound events are admin-only: `email.received` has no owning API key,
     * so only admin keys may subscribe to it. Checked here (not in the route)
     * so the REST API and the dashboard enforce it alike.
     */
    if (input.events.includes("email.received") && !key?.isAdmin) {
      throw new InboundEventsRequireAdminError();
    }

    const [counted] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(webhooks)
      .where(eq(webhooks.apiKeyId, apiKeyId));
    const existing = counted?.count ?? 0;
    if (existing >= maxPerKey) {
      logger.warn("Webhook not created: API key at its webhook limit", {
        apiKeyId,
        existing,
        limit: maxPerKey,
      });
      throw new WebhookLimitReachedError(maxPerKey);
    }

    logger.info("Creating webhook", {
      id,
      url: redactUrl(input.url),
      events: input.events,
      apiKeyId,
      createdByUserId,
    });

    const [created] = await tx
      .insert(webhooks)
      .values({
        id,
        apiKeyId,
        url: input.url,
        events: input.events,
        /** Only the ciphertext is stored (#259); the caller gets the raw secret once. */
        secret: encryptSecret(secret, config.dkimEncryptionKey),
        createdByUserId,
      })
      .returning();
    return created;
  });

  return { webhook: webhook!, secret };
}

/**
 * Lists one page of an API key's webhooks, oldest first (#258), with the
 * key's total for the pagination meta.
 */
export async function listWebhooks(
  apiKeyId: string,
  pagination: { page: number; limit: number },
): Promise<{ data: Webhook[]; total: number }> {
  const owned = eq(webhooks.apiKeyId, apiKeyId);
  const [data, [counted]] = await Promise.all([
    db
      .select()
      .from(webhooks)
      .where(owned)
      .orderBy(asc(webhooks.createdAt), asc(webhooks.id))
      .limit(pagination.limit)
      .offset((pagination.page - 1) * pagination.limit),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(webhooks)
      .where(owned),
  ]);
  return { data, total: counted?.count ?? 0 };
}

/**
 * Lists all webhooks (unscoped): used by the dashboard.
 */
export async function listAllWebhooks(): Promise<Webhook[]> {
  return db.select().from(webhooks);
}

/**
 * Deletes a webhook, scoped to the requesting API key.
 */
export async function deleteWebhook(
  id: string,
  apiKeyId: string,
): Promise<Webhook | undefined> {
  logger.info("Deleting webhook", { id, apiKeyId });

  const [webhook] = await db
    .delete(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.apiKeyId, apiKeyId)))
    .returning();

  return webhook;
}

/**
 * Looks up a single webhook by id, scoped to an API key.
 * Used by the deliveries endpoint to disambiguate "no deliveries yet"
 * from "wrong id / wrong key" before returning a 404.
 */
export async function findWebhookById(
  id: string,
  apiKeyId: string,
): Promise<Webhook | undefined> {
  const [row] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.apiKeyId, apiKeyId)))
    .limit(1);
  return row;
}

/**
 * Who an event may be delivered to.
 *
 * - `{ apiKeyId }`: an event about one API key's email (`email.sent`,
 *   `email.failed`, `email.bounced`). Only that key's webhooks receive it.
 * - `{ adminOnly: true }`: an event with no owning key (`email.received`:
 *   domains and inbound mail aren't owned by a key). Only webhooks owned by
 *   admin keys receive it, matching the admin-only inbound API (#130).
 */
export type DispatchScope = { apiKeyId: string } | { adminOnly: true };

/**
 * Finds the active webhooks that should receive `event`, scoped by owner.
 *
 * Before scoping, every active webhook subscribed to the event type was
 * returned regardless of which API key owned it, so one key's email events
 * (sender, recipient, subject) reached other keys' webhooks. The owner
 * scope is enforced in SQL. The event match stays in JS on the parsed
 * array: rows written through bun-sql store `events` as a JSON string
 * inside jsonb, so a jsonb `@>` match would miss them. Only `id` and
 * `events` are selected: the signing secret stays out of memory here.
 */
export async function findWebhooksForEvent(
  event: string,
  scope: DispatchScope,
): Promise<{ id: string }[]> {
  const columns = { id: webhooks.id };

  /** A revoked key's webhooks receive nothing: revoking a leaked key must
   *  also cut off the event feed its holder registered. The event is
   *  matched in SQL (#173): `events` holds real JSON since #261, and the
   *  array is built from a plain parameter (see `src/db/jsonb.ts`). */
  const live = and(
    eq(webhooks.isActive, true),
    eq(apiKeys.isActive, true),
    sql`${webhooks.events} @> jsonb_build_array(${event}::text)`,
  );

  const candidates =
    "apiKeyId" in scope
      ? await db
          .select(columns)
          .from(webhooks)
          .innerJoin(apiKeys, eq(apiKeys.id, webhooks.apiKeyId))
          .where(and(live, eq(webhooks.apiKeyId, scope.apiKeyId)))
      : await db
          .select(columns)
          .from(webhooks)
          .innerJoin(apiKeys, eq(apiKeys.id, webhooks.apiKeyId))
          .where(and(live, eq(apiKeys.isAdmin, true)));

  return candidates;
}
