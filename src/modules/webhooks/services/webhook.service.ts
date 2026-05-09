import { eq, and } from "drizzle-orm";
import { randomBytes } from "crypto";
import { db } from "../../../db/index.ts";
import { webhooks } from "../models/webhook.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
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
 * Lists all webhooks (unscoped) — used by the dashboard.
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
 * Finds all active webhooks subscribed to a given event type.
 * Used by the dispatch service to know where to send events.
 */
export async function findWebhooksForEvent(event: string): Promise<Webhook[]> {
  const all = await db.select().from(webhooks).where(eq(webhooks.isActive, true));

  return all.filter((w) => w.events.includes(event));
}
