import type { inboundEmails } from "../models/inbound-email.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

/**
 * The shape of an inbound email row returned from the database.
 */
export type InboundEmail = InferSelectModel<typeof inboundEmails>;
