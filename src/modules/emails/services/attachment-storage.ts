import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { emailAttachments } from "../models/email-attachment.schema.ts";
import { generateId } from "../../../utils/id.ts";
import type { DbExecutor } from "../types/email.types.ts";
import type { PreparedAttachment } from "./attachments.ts";

/**
 * Where attachment bytes are kept (#181), behind a small interface so an
 * object store can be added later without touching the send, queue or
 * retention code. Only the Postgres implementation exists: the bytes sit
 * in `email_attachments.content`, next to their metadata.
 *
 * The metadata (filename, type, size, Content-ID, whether the bytes still
 * exist) always lives in `email_attachments`; it is read by
 * {@link listAttachmentMeta}, which never selects `content`.
 */
export interface AttachmentStorage {
  /** Stores a send's attachments, in the caller's transaction (the email insert's). */
  saveAttachments(
    executor: DbExecutor,
    emailId: string,
    attachments: readonly PreparedAttachment[],
  ): Promise<void>;
  /**
   * The email's attachments in order, with their bytes (`null` once
   * dropped); only the one at `position` when given.
   */
  loadAttachments(
    executor: DbExecutor,
    emailId: string,
    position?: number,
  ): Promise<LoadedAttachment[]>;
  /**
   * Drops the bytes of these emails' attachments, keeping the metadata,
   * in the caller's transaction. Returns how many files lost their bytes.
   */
  dropAttachmentBytes(executor: DbExecutor, emailIds: readonly string[]): Promise<number>;
}

/** What is known about an attachment without its bytes. */
export interface AttachmentMeta {
  /** 0-based index in the send's list. */
  position: number;
  filename: string;
  /** The derived type it is sent with. */
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  /** Whether the bytes are still stored (false once the email reached a final state). */
  available: boolean;
}

/** An attachment with its bytes, as the mailer and the download read it. */
export interface LoadedAttachment extends AttachmentMeta {
  /** The raw bytes, `null` once dropped. */
  content: Uint8Array | null;
}

/**
 * The metadata columns, never `content`: `available` is computed in SQL
 * (`content IS NOT NULL` reads the null bitmap, not the value).
 */
const META_COLUMNS = {
  emailId: emailAttachments.emailId,
  position: emailAttachments.position,
  filename: emailAttachments.filename,
  contentType: emailAttachments.contentType,
  sizeBytes: emailAttachments.sizeBytes,
  contentId: emailAttachments.contentId,
  available: sql<boolean>`${emailAttachments.content} IS NOT NULL`.mapWith(Boolean),
};

/** The Postgres implementation: bytes in `email_attachments.content`. */
const postgresAttachmentStorage: AttachmentStorage = {
  async saveAttachments(executor, emailId, attachments) {
    if (attachments.length === 0) return;
    await executor.insert(emailAttachments).values(
      attachments.map((a) => ({
        id: generateId("att"),
        emailId,
        position: a.position,
        filename: a.filename,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        contentId: a.contentId,
        sha256: a.sha256,
        content: a.content,
      })),
    );
  },

  async loadAttachments(executor, emailId, position) {
    const rows = await executor
      .select({ ...META_COLUMNS, content: emailAttachments.content })
      .from(emailAttachments)
      .where(
        and(
          eq(emailAttachments.emailId, emailId),
          position === undefined ? undefined : eq(emailAttachments.position, position),
        ),
      )
      .orderBy(asc(emailAttachments.position));
    return rows.map(({ emailId: _emailId, ...row }) => row);
  },

  async dropAttachmentBytes(executor, emailIds) {
    if (emailIds.length === 0) return 0;
    const dropped = await executor
      .update(emailAttachments)
      .set({ content: null })
      .where(
        and(
          inArray(emailAttachments.emailId, [...emailIds]),
          isNotNull(emailAttachments.content),
        ),
      )
      .returning({ id: emailAttachments.id });
    return dropped.length;
  },
};

/** The storage in use. */
export const attachmentStorage: AttachmentStorage = postgresAttachmentStorage;

/**
 * The metadata query for some emails' attachments, ordered by email and
 * position. Exported so a test can check, with `EXPLAIN`, that it never
 * reads `content`.
 */
export function attachmentMetaQuery(executor: DbExecutor, emailIds: readonly string[]) {
  return executor
    .select(META_COLUMNS)
    .from(emailAttachments)
    .where(inArray(emailAttachments.emailId, [...emailIds]))
    .orderBy(asc(emailAttachments.emailId), asc(emailAttachments.position));
}

/**
 * Attachment metadata of these emails, by email id (an email without
 * attachments is absent). One query, never reading the bytes.
 */
export async function listAttachmentMeta(
  executor: DbExecutor,
  emailIds: readonly string[],
): Promise<Map<string, AttachmentMeta[]>> {
  const byEmail = new Map<string, AttachmentMeta[]>();
  if (emailIds.length === 0) return byEmail;
  for (const { emailId, ...meta } of await attachmentMetaQuery(executor, emailIds)) {
    const list = byEmail.get(emailId) ?? [];
    list.push(meta);
    byEmail.set(emailId, list);
  }
  return byEmail;
}
