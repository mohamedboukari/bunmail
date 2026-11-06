import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { EmailDetailPage } from "../routes/email-detail.tsx";
import { AttachmentGonePage } from "../routes/attachment-gone.tsx";
import { attachmentContentDisposition } from "../../modules/emails/services/attachments.ts";
import { memberGuard } from "../guards.tsx";
import * as emailService from "../../modules/emails/services/email.service.ts";
import type { emailTrashPages } from "./emails-trash.plugin.tsx";

/**
 * The email detail and its attachment downloads (#181). Takes the
 * instance the trash routes were registered on, so the route types
 * chain exactly as in one `emailPages` chain.
 */
export function emailDetailPages(app: ReturnType<typeof emailTrashPages>) {
  return (
    app
      /**
       * GET /dashboard/emails/:id
       * Single email detail view. Falls back to the trashed copy if the email
       * is in trash so users can navigate to it from the trash list.
       */
      .get(
        "/emails/:id",
        async ({ params, set }) => {
          const live = await emailService.getEmailByIdUnscoped(params.id);
          const email =
            live ?? (await emailService.getTrashedEmailByIdUnscoped(params.id));

          if (!email) {
            set.status = 404;
            return "Email not found";
          }

          /** Attachment metadata (#181), read without the bytes. */
          const attachments = (await emailService.attachmentsFor([email.id])).get(
            email.id,
          );
          return (
            <EmailDetailPage
              email={email}
              isTrashed={live === undefined}
              attachments={attachments ?? []}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({
            id: t.String(),
          }),
        },
      )

      /**
       * GET /dashboard/emails/:id/attachments/:position (#181)
       * Downloads one attachment of an email, live or in trash, with the
       * email page's guard. Always a forced download that no browser
       * renders or sniffs: `application/octet-stream`, `Content-Disposition:
       * attachment` with the RFC 5987 encoded name, `nosniff`, a sandbox
       * CSP and `no-store`. Once the email reached a final state the bytes
       * are gone: 410 with a page that says so.
       */
      .get(
        "/emails/:id/attachments/:position",
        async ({ params, set, auth }) => {
          const position = /^\d{1,3}$/.test(params.position)
            ? Number(params.position)
            : null;
          const found =
            position === null
              ? undefined
              : await emailService.findAttachmentForDownload(params.id, position);

          if (!found) {
            set.status = 404;
            return "Attachment not found";
          }
          if (found.content === null) {
            logger.info("Dashboard attachment download: no longer stored", {
              emailId: params.id,
              position,
              userId: auth.user.id,
            });
            set.status = 410;
            return <AttachmentGonePage emailId={params.id} />;
          }

          /** Size only: the filename may carry personal data. */
          logger.info("Dashboard attachment downloaded", {
            emailId: params.id,
            position,
            sizeBytes: found.sizeBytes,
            userId: auth.user.id,
          });
          return new Response(found.content, {
            headers: attachmentDownloadHeaders(found.filename),
          });
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({
            id: t.String(),
            position: t.String(),
          }),
        },
      )
  );
}

/**
 * Headers of an attachment download (#181), whatever the file is: a
 * generic binary type and a forced `attachment` disposition so the
 * browser saves it instead of rendering it, `nosniff` so it never guesses
 * another type, a CSP that sandboxes the response and allows nothing
 * should it be rendered anyway, and no caching.
 */
export function attachmentDownloadHeaders(filename: string): Record<string, string> {
  return {
    "content-type": "application/octet-stream",
    "content-disposition": attachmentContentDisposition(filename),
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'",
    "cache-control": "no-store",
  };
}
