/**
 * The emails module's service surface (#380). The code lives in one file
 * per concern, beside this one:
 *
 *   - `email-create.service.ts`: `createEmail`, the idempotent send and the insert
 *   - `email-prepare.service.ts`: every check a send passes before it is inserted
 *   - `email-query.service.ts`: reads, lists, tag filters and attachment lookups
 *   - `email-trash.service.ts`: trash, restore and permanent delete
 *
 * Importers (and the e2e mocks of this module) keep using this module.
 */
export { createEmail, createEmailIdempotent } from "./email-create.service.ts";
export {
  attachmentsFor,
  findAttachmentForDownload,
  getEmailById,
  checkTagFilters,
  listEmails,
  listAllEmails,
  getEmailByIdUnscoped,
} from "./email-query.service.ts";
export {
  trashEmail,
  trashEmails,
  listTrashedEmails,
  restoreEmail,
  permanentDeleteEmail,
  emptyEmailsTrash,
  listTrashedEmailsUnscoped,
  getTrashedEmailByIdUnscoped,
  trashEmailUnscoped,
  trashEmailsUnscoped,
  restoreEmailUnscoped,
  permanentDeleteEmailUnscoped,
  emptyEmailsTrashUnscoped,
} from "./email-trash.service.ts";
