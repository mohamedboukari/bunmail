import type {
  EmailTombstone,
  TombstoneAttachment,
} from "../models/email-tombstone.schema.ts";

export interface SerializedEmailTombstone {
  id: string;
  messageId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  status: string;
  sentAt: Date | null;
  deletedAt: Date | null;
  purgedAt: Date;
  /** The email's attachments (#181), metadata only; empty when none. */
  attachments: TombstoneAttachment[];
}

/**
 * Strips `apiKeyId` (the caller already authenticated as that key, so
 * echoing it is redundant noise). Everything else is kept: tombstones
 * are forensic artefacts; once you can read one, you want all the
 * identifiers we kept.
 */
export function serializeEmailTombstone(row: EmailTombstone): SerializedEmailTombstone {
  return {
    id: row.id,
    messageId: row.messageId,
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    subject: row.subject,
    status: row.status,
    sentAt: row.sentAt,
    deletedAt: row.deletedAt,
    purgedAt: row.purgedAt,
    attachments: row.attachments ?? [],
  };
}
