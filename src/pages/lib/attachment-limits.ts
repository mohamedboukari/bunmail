import { config } from "../../config.ts";
import { BYTES_PER_MB } from "../../config/smtp.ts";
import { MAX_ATTACHMENTS } from "../../modules/emails/services/attachments.ts";

/**
 * The attachment limits the Send form shows (#488): the same ones the
 * server enforces on every send (`validateAttachments`), so the hint never
 * promises more than a send accepts.
 */
export function sendFormAttachmentLimits(): { maxFiles: number; maxTotalMb: number } {
  return {
    maxFiles: MAX_ATTACHMENTS,
    maxTotalMb: Math.floor(config.attachments.maxTotalBytes / BYTES_PER_MB),
  };
}
