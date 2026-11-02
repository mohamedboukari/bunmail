import { db } from "../../../db/index.ts";
import { inboundEmails } from "../models/inbound-email.schema.ts";
import { enqueueEvent } from "../../webhooks/services/webhook-dispatch.service.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";

/**
 * Stores a received message and enqueues `email.received` for admin keys'
 * webhooks in one transaction (#184): the row and its event commit
 * together, or neither does. A failure is thrown; the receiver then
 * answers `451`, so the sending MTA delivers the message again later
 * instead of BunMail keeping it without its event.
 */
export async function storeInboundEmail(
  row: typeof inboundEmails.$inferInsert & { id: string },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(inboundEmails).values(row);
      await enqueueEvent(
        tx,
        "email.received",
        {
          inboundEmailId: row.id,
          from: row.fromAddress,
          to: row.toAddress,
          subject: row.subject ?? null,
        },
        { adminOnly: true },
      );
    });
  } catch (error) {
    logger.error("Inbound email not stored: transaction rolled back", {
      id: row.id,
      error: loggableError(error),
    });
    throw error;
  }
}
