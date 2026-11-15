import { drizzle } from "drizzle-orm/bun-sql";
import { SQL } from "bun";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

/**
 * The shared pool, at most `DATABASE_POOL_MAX` connections (#423): Bun
 * 1.3.14's pool can stall when more queries run at once than it has
 * connections, so it is sized above the peak (see `readDatabasePoolMax`).
 */
const client = new SQL(config.database.url, { max: config.database.poolMax });

export const db = drizzle({ client, schema });

/**
 * The transaction handle `db.transaction` passes to its callback. A
 * function that takes a `Tx` (not `typeof db`) can only run inside a
 * transaction its caller opened: the webhook outbox (#184) relies on it.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Where a write runs: the shared pool, or a transaction the caller opened. */
export type DbExecutor = typeof db | Tx;
