/**
 * Seed script: creates a test API key for local development.
 *
 * Run with: bun run src/db/seed.ts
 *
 * This generates a real API key using SHA-256 hashing, inserts it into
 * the database, and prints the raw key to stdout. Copy the raw key and
 * use it as `Authorization: Bearer <key>` for all API requests.
 *
 * The raw key is shown ONCE: it is not stored anywhere.
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
      /** The bootstrap key is an admin key so the operator can manage keys,
       *  domains, and inbound via the API from a fresh install (#130). */
      isAdmin: true,
    })
    .returning();

  logger.info("Test API key created", { id: key!.id, name: key!.name, prefix });

  /**
   * Print the raw key to the terminal: this is the ONLY time it is shown.
   * Written to stdout directly, never through the structured logger
   * (#260): when seed output is shipped to a log system (CI, a Kubernetes
   * Job), a logged line would leave a full admin key there.
   */
  process.stdout.write(
    [
      "",
      "========================================",
      "  YOUR API KEY (save it: shown once!)",
      "  Do not paste it into tickets or logs.",
      "========================================",
      `  ${raw}`,
      "========================================",
      "Usage example:",
      `  curl -H "Authorization: Bearer ${raw}" http://localhost:3000/api/v1/emails`,
      "",
      "",
    ].join("\n"),
  );

  process.exit(0);
}

seed().catch((error) => {
  logger.error("Seed failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
