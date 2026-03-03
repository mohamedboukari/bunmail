/**
 * Seed script — creates a test API key for local development.
 *
 * Run with: bun run src/db/seed.ts
 *
 * This generates a real API key using SHA-256 hashing, inserts it into
 * the database, and prints the raw key to stdout. Copy the raw key and
 * use it as `Authorization: Bearer <key>` for all API requests.
 *
 * The raw key is shown ONCE — it is not stored anywhere.
 */
import { db } from "./index.ts";
import { apiKeys } from "../modules/api-keys/models/api-key.schema.ts";
import { generateId } from "../utils/id.ts";
import { generateApiKey } from "../utils/crypto.ts";
import { logger } from "../utils/logger.ts";

async function seed() {
  logger.info("Seeding test API key...");

  /** Generate a unique prefixed ID for this key */
  const id = generateId("key");

  /** Generate the raw key, its SHA-256 hash, and the display prefix */
  const { raw, hash, prefix } = generateApiKey();

  const [key] = await db
    .insert(apiKeys)
    .values({
      id,
      name: "Development Test Key",
      keyHash: hash,
      keyPrefix: prefix,
    })
    .returning();

  logger.info("Test API key created", { id: key!.id, name: key!.name, prefix });

  /**
   * Log the raw key clearly — this is the ONLY time it will be shown.
   * Copy it and use as: Authorization: Bearer <raw key>
   */
  logger.info("========================================");
  logger.info("  YOUR API KEY (save it — shown once!)");
  logger.info("========================================");
  logger.info("  Raw key", { key: raw });
  logger.info("========================================");
  logger.info("Usage example", {
    curl: `curl -H "Authorization: Bearer ${raw}" http://localhost:3000/api/v1/emails`,
  });

  process.exit(0);
}

seed().catch((error) => {
  logger.error("Seed failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
