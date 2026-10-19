import { drizzle } from "drizzle-orm/bun-sql";
import { SQL } from "bun";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

const client = new SQL(config.database.url);

export const db = drizzle({ client, schema });

/**
 * The transaction handle `db.transaction` passes to its callback. A
 * function that takes a `Tx` (not `typeof db`) can only run inside a
 * transaction its caller opened: the webhook outbox (#184) relies on it.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Where a write runs: the shared pool, or a transaction the caller opened. */
export type DbExecutor = typeof db | Tx;
