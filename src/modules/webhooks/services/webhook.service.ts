import { eq, and } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "../../../db/index.ts";
import { webhooks } from "../models/webhook.schema.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { InboundEventsRequireAdminError } from "../errors.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { assertPublicWebhookUrl } from "../../../utils/ssrf-guard.ts";
import { config } from "../../../config.ts";
import type { Webhook, CreateWebhookInput } from "../types/webhook.types.ts";

/**
 * Creates a new webhook endpoint.
 * Generates a random signing secret that the consumer uses to verify payloads.
 *
 * @returns The webhook row AND the secret (shown once, like API keys).
 */
export async function createWebhook(
  input: CreateWebhookInput,
  apiKeyId: string,
): Promise<{ webhook: Webhook; secret: string }> {
  /**
   * SSRF guard (#128): reject URLs that aren't https (unless http is opted
   * in) or that resolve to a private/loopback/link-local/metadata address,
   * before we ever store or deliver to them. Throws `BlockedUrlError`,
   * mapped to HTTP 422 by the global error handler.
   */
  await assertPublicWebhookUrl(input.url, config.webhookDelivery.allowInsecureHttp);

  /**
   * Inbound events are admin-only: `email.received` has no owning API key,
   * so only admin keys may subscribe to it. Checked here (not in the route)
   * so the REST API and the dashboard enforce it alike.
   */
  if (input.events.includes("email.received")) {
    const [key] = await db
      .select({ isAdmin: apiKeys.isAdmin })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .limit(1);
    if (!key?.isAdmin) throw new InboundEventsRequireAdminError();
  }

  const id = generateId("whk");
  const secret = randomBytes(32).toString("hex");

  logger.info("Creating webhook", {
    id,
    url: input.url,
    events: input.events,
    apiKeyId,
  });

  const [webhook] = await db
    .insert(webhooks)
    .values({
      id,
      apiKeyId,
      url: input.url,
      events: input.events,
      secret,
    })
    .returning();

  return { webhook: webhook!, secret };
}

/**
 * Lists webhooks scoped to an API key.
 */
export async function listWebhooks(apiKeyId: string): Promise<Webhook[]> {
  return db.select().from(webhooks).where(eq(webhooks.apiKeyId, apiKeyId));
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
  const columns = { id: webhooks.id, events: webhooks.events };

  const candidates =
    "apiKeyId" in scope
      ? await db
          .select(columns)
          .from(webhooks)
          .where(and(eq(webhooks.isActive, true), eq(webhooks.apiKeyId, scope.apiKeyId)))
      : await db
          .select(columns)
          .from(webhooks)
          .innerJoin(apiKeys, eq(apiKeys.id, webhooks.apiKeyId))
          .where(and(eq(webhooks.isActive, true), eq(apiKeys.isAdmin, true)));

  return candidates.filter((w) => w.events.includes(event)).map((w) => ({ id: w.id }));
}
