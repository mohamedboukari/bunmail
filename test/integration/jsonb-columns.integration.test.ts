/**
 * jsonb columns store real JSON (#261), real Postgres.
 *
 * Writes through `drizzle-orm/bun-sql`'s built-in `jsonb` were stored as a
 * jsonb string holding the JSON text, so SQL containment and path
 * operators matched nothing. The `jsonb` column type in `src/db/jsonb.ts`
 * fixes the write path; migration `0022` rewrites rows written before.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { eq, sql } from "drizzle-orm";
import {
  truncateAll,
  seed,
  db,
  apiKeys,
  emails,
  templates,
  webhooks,
} from "./_helpers.ts";

/** `jsonb_typeof` of one column of one row. */
async function typeOf(table: string, column: string, id: string): Promise<string> {
  const rows = await db.execute(
    sql`SELECT jsonb_typeof(${sql.identifier(column)}) AS kind FROM ${sql.identifier(table)} WHERE id = ${id}`,
  );
  return String(rows[0]?.["kind"]);
}

beforeEach(async () => {
  await truncateAll();
});

describe("writes store arrays and objects, not strings", () => {
  test("webhooks.events, api_keys.allowed_senders, templates.variables, emails.delivery_state", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await db
      .update(apiKeys)
      .set({ allowedSenders: ["noreply@example.com"] })
      .where(eq(apiKeys.id, apiKeyId));
    const hook = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/hook",
      events: ["email.sent", "email.failed"],
    });
    const template = await seed.template({ apiKeyId, variables: ["name"] });
    const { id: emailId } = await seed.email({ apiKeyId });
    await db
      .update(emails)
      .set({
        deliveryState: {
          "mx.example.org": {
            status: "sent",
            recipients: ["user@example.org"],
            attempts: 1,
          },
        },
      })
      .where(eq(emails.id, emailId));

    expect(await typeOf("webhooks", "events", hook.id)).toBe("array");
    expect(await typeOf("api_keys", "allowed_senders", apiKeyId)).toBe("array");
    expect(await typeOf("templates", "variables", template.id)).toBe("array");
    expect(await typeOf("emails", "delivery_state", emailId)).toBe("object");
  });

  test("SQL containment now matches", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const wanted = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/a",
      events: ["email.sent"],
    });
    await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/b",
      events: ["email.failed"],
    });

    const rows = await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(sql`${webhooks.events} @> jsonb_build_array(${"email.sent"}::text)`);
    expect(rows.map((r) => r.id)).toEqual([wanted.id]);
  });

  test("an empty array stays an empty array", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    await db.update(apiKeys).set({ allowedSenders: [] }).where(eq(apiKeys.id, apiKeyId));
    expect(await typeOf("api_keys", "allowed_senders", apiKeyId)).toBe("array");
    const [row] = await db
      .select({ allowedSenders: apiKeys.allowedSenders })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId));
    expect(row?.allowedSenders).toEqual([]);
  });
});

describe("rows written before the fix", () => {
  /** Stores `value` the old, broken way: a jsonb string holding the JSON text. */
  async function storeAsString(
    table: string,
    column: string,
    id: string,
    value: unknown,
  ) {
    await db.execute(
      sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = to_jsonb(${JSON.stringify(value)}::text) WHERE id = ${id}`,
    );
  }

  test("still read back as arrays", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const template = await seed.template({ apiKeyId, variables: ["name"] });
    await storeAsString("templates", "variables", template.id, ["first", "last"]);
    expect(await typeOf("templates", "variables", template.id)).toBe("string");

    const [row] = await db
      .select({ variables: templates.variables })
      .from(templates)
      .where(eq(templates.id, template.id));
    expect(row?.variables).toEqual(["first", "last"]);
  });

  test("migration 0022 rewrites them as real JSON, and leaves correct rows alone", async () => {
    const { id: apiKeyId } = await seed.apiKey();
    const legacy = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/a",
      events: ["x"],
    });
    const current = await seed.webhook({
      apiKeyId,
      url: "https://93.184.216.34/b",
      events: ["email.failed"],
    });
    await storeAsString("webhooks", "events", legacy.id, ["email.sent"]);
    const { id: emailId } = await seed.email({ apiKeyId });
    await storeAsString("emails", "delivery_state", emailId, {
      "mx.example.org": { status: "sent" },
    });

    const migration = await readFile(
      join(import.meta.dir, "../../drizzle/0022_jsonb_values.sql"),
      "utf-8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      const body = statement
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim();
      if (body) await db.execute(sql.raw(body));
    }

    expect(await typeOf("webhooks", "events", legacy.id)).toBe("array");
    expect(await typeOf("webhooks", "events", current.id)).toBe("array");
    expect(await typeOf("emails", "delivery_state", emailId)).toBe("object");
    const [row] = await db
      .select({ events: webhooks.events })
      .from(webhooks)
      .where(eq(webhooks.id, legacy.id));
    expect(row?.events).toEqual(["email.sent"]);
  });
});
