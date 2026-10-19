import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { redactEmail } from "../../utils/redact.ts";
import { isEmailStatus } from "../../modules/emails/types/email.types.ts";
import { EmailSendRejectedError } from "../../modules/emails/errors.ts";
import { EmailsPage } from "../routes/emails.tsx";
import { EmailTombstonesPage } from "../routes/email-tombstones.tsx";
import { EmailsTrashPage } from "../routes/emails-trash.tsx";
import { EmailDetailPage } from "../routes/email-detail.tsx";
import { SendEmailPage } from "../routes/send-email.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import { sendSuccessFlash } from "../send-warnings.ts";
import { flashMessageFor } from "../flash-errors.ts";
import * as emailService from "../../modules/emails/services/email.service.ts";
import * as tombstoneService from "../../modules/emails/services/tombstone.service.ts";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import * as replyThreading from "../../modules/inbound/services/reply-threading.service.ts";
import { toIdArray } from "../lib/form.ts";
import { toFlash } from "../lib/responses.ts";
import { recordActorOf } from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/**
 * Outbound email pages (#291): the send form, the email list, trash,
 * tombstones and the email detail.
 */
export function emailPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/send
       * Send email page: compose form with flash message support. Includes
       * an explicit "Sending as" api-key picker (#89) so the operator
       * always knows which key is charged with the send and any resulting
       * auto-suppressions.
       */
      .get(
        "/send",
        async ({ query, auth }) => {
          /** A member picks only from the keys it created (#219); admins and the owner from every key. */
          const keys = await apiKeyService.listApiKeys(recordActorOf(auth));
          /** Only active keys are eligible: disabled keys are filtered out
           *  so the dropdown reflects what's actually usable. */
          const activeKeys = keys.filter((k) => k.isActive);
          const defaultApiKeyId = activeKeys[0]?.id;

          const flash = toFlash(query.flash, query.flashType);

          return (
            <SendEmailPage
              flash={flash}
              apiKeys={activeKeys}
              defaultApiKeyId={defaultApiKeyId}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/send
       * Sends an email via form submission. The operator picks the api key
       * explicitly via the form (#89). We re-validate that the key is
       * still active before sending so a stale form fails loud instead of
       * silently falling back to a different key. A member may send only with
       * a key it created (#219): any other key id, an admin's or the owner's
       * included, is "not available" like a missing key, and nothing is sent.
       */
      .post(
        "/send",
        async ({ body, set, auth }) => {
          const keys = await apiKeyService.listApiKeys(recordActorOf(auth));
          /** Match exactly what the form submitted: no implicit fallback. */
          const chosenKey = keys.find((k) => k.id === body.apiKeyId);

          if (!chosenKey || !chosenKey.isActive) {
            logger.warn("Dashboard send refused: API key not available to the user", {
              apiKeyId: body.apiKeyId,
              userId: auth.user.id,
              role: auth.user.role,
            });
            set.status = 302;
            set.headers["location"] =
              `/dashboard/send?flash=${encodeURIComponent("Selected API key is not available. Pick an active one and try again.")}&flashType=error`;
            return "";
          }

          try {
            /**
             * A reply to an inbound email (#192): the form names the email
             * by id and the threading headers are computed here from its
             * validated, stored ids, then go through the custom-header
             * rules like any other (#177).
             */
            const headers = body.inboundId
              ? await replyThreading.replyHeadersForInbound(body.inboundId)
              : undefined;
            const { warnings } = await emailService.createEmail(
              {
                from: body.from,
                to: body.to,
                cc: body.cc || undefined,
                bcc: body.bcc || undefined,
                replyTo: body.replyTo || undefined,
                subject: body.subject,
                html: body.html || undefined,
                text: body.text || undefined,
                ...(headers ? { headers } : {}),
              },
              chosenKey.id,
            );

            logger.info("Email sent via dashboard", {
              to: redactEmail(body.to),
              apiKeyId: chosenKey.id,
            });
            set.status = 302;
            /** Unverified sender-domain records are named in the flash (#245). */
            set.headers["location"] =
              `/dashboard/send?flash=${encodeURIComponent(sendSuccessFlash(warnings))}`;
          } catch (error) {
            if (error instanceof EmailSendRejectedError) {
              /** Refused on its input (#245): expected; the service logged the email id. */
              logger.warn("Dashboard send refused", {
                apiKeyId: chosenKey.id,
                code: error.code,
              });
            } else {
              logger.error("Failed to send email via dashboard", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            set.status = 302;
            set.headers["location"] =
              `/dashboard/send?flash=${encodeURIComponent(flashMessageFor(error, "Failed to send email"))}&flashType=error`;
          }
          return "";
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({
            apiKeyId: t.String(),
            from: t.String({ format: "email" }),
            to: t.String({ format: "email" }),
            /**
             * Same header-injection guard as the REST `sendEmailDto` (#133):
             * length cap + CR/LF rejected. The dashboard path previously took
             * cc/bcc/subject unrestricted (#202).
             */
            cc: t.Optional(
              t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" }),
            ),
            bcc: t.Optional(
              t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" }),
            ),
            /** Same guard as the API DTO: length cap + CR/LF rejected (#169). */
            replyTo: t.Optional(
              t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" }),
            ),
            subject: t.String({ maxLength: 500, pattern: "^[^\\u000d\\u000a]*$" }),
            html: t.Optional(t.String()),
            text: t.Optional(t.String()),
            /** The inbound email a reply answers (#192): an id, never header text. */
            inboundId: t.Optional(t.String({ maxLength: 36 })),
          }),
        },
      )

      /**
       * GET /dashboard/emails
       * Email list with status filter tabs, bulk-select checkboxes, and pagination.
       * Trashed rows are hidden: view them at /dashboard/emails/trash.
       */
      .get(
        "/emails",
        async ({ query, auth }) => {
          const { page, limit } = parsePagination(query);
          const status = isEmailStatus(query.status) ? query.status : undefined;
          /** Source + API-key filters (#137). Only pass through valid values. */
          const source =
            query.source === "api" || query.source === "smtp" ? query.source : undefined;
          const apiKeyId = query.apiKeyId || undefined;

          const [{ data, total }, keys] = await Promise.all([
            emailService.listAllEmails({
              page,
              limit,
              status,
              source,
              apiKeyId,
            }),
            /** Populate the API-key dropdown (#137): a member's own keys only (#219). */
            apiKeyService.listApiKeys(recordActorOf(auth)),
          ]);

          const flash = toFlash(query.flash, query.flashType);

          return (
            <EmailsPage
              emails={data}
              total={total}
              page={page}
              limit={limit}
              status={status}
              source={source}
              apiKeyId={apiKeyId}
              apiKeys={keys.map((k) => ({
                id: k.id,
                name: k.name,
                keyPrefix: k.keyPrefix,
              }))}
              flash={flash}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            page: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            status: t.Optional(t.String()),
            source: t.Optional(t.String()),
            apiKeyId: t.Optional(t.String()),
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
          }),
        },
      )

      /**
       * GET /dashboard/emails/tombstones (#34): post-purge audit trail.
       * Defined before `/:id` so the literal segment doesn't get eaten by
       * the param route. Optional `?messageId=` for the bounce-trace flow.
       */
      .get(
        "/emails/tombstones",
        async ({ query }) => {
          const { page, limit } = parsePagination(query);
          const messageId =
            typeof query.messageId === "string" && query.messageId.length > 0
              ? query.messageId
              : undefined;

          const { data, total } = await tombstoneService.listAllTombstones({
            messageId,
            page,
            limit,
          });

          return (
            <EmailTombstonesPage
              tombstones={data}
              total={total}
              page={page}
              limit={limit}
              messageIdFilter={messageId}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            page: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            messageId: t.Optional(t.String()),
          }),
        },
      )

      /**
       * GET /dashboard/emails/trash
       * Trashed emails view: defined before /:id so the segment doesn't match.
       */
      .get(
        "/emails/trash",
        async ({ query }) => {
          const { page, limit } = parsePagination(query);

          const { data, total } = await emailService.listTrashedEmailsUnscoped({
            page,
            limit,
          });

          const flash = toFlash(query.flash, query.flashType);

          return (
            <EmailsTrashPage
              emails={data}
              total={total}
              page={page}
              limit={limit}
              retentionDays={config.trash.retentionDays}
              flash={flash}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            page: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/emails/bulk-trash
       * Bulk soft-delete from the emails list page.
       */
      .post(
        "/emails/bulk-trash",
        async ({ body, set }) => {
          const ids = toIdArray(body.ids);
          const count = await emailService.trashEmailsUnscoped(ids);
          logger.info("Bulk-trashed emails via dashboard", { count });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/emails?flash=${encodeURIComponent(`${count} email(s) moved to trash`)}`;
          return "";
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            ids: t.Union([t.Array(t.String()), t.String()]),
          }),
        },
      )

      /**
       * POST /dashboard/emails/trash/bulk-restore
       * Bulk-restore from the trash page.
       */
      .post(
        "/emails/trash/bulk-restore",
        async ({ body, set }) => {
          const ids = toIdArray(body.ids);
          let restored = 0;
          for (const id of ids) {
            const r = await emailService.restoreEmailUnscoped(id);
            if (r) restored += 1;
          }
          logger.info("Bulk-restored emails via dashboard", { restored });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/emails/trash?flash=${encodeURIComponent(`${restored} email(s) restored`)}`;
          return "";
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            ids: t.Union([t.Array(t.String()), t.String()]),
          }),
        },
      )

      /**
       * POST /dashboard/emails/trash/bulk-permanent
       * Bulk-permanently-delete from the trash page.
       */
      .post(
        "/emails/trash/bulk-permanent",
        async ({ body, set }) => {
          const ids = toIdArray(body.ids);
          let deleted = 0;
          for (const id of ids) {
            const r = await emailService.permanentDeleteEmailUnscoped(id);
            if (r) deleted += 1;
          }
          logger.info("Bulk-permanent-deleted emails via dashboard", { deleted });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/emails/trash?flash=${encodeURIComponent(`${deleted} email(s) deleted forever`)}`;
          return "";
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            ids: t.Union([t.Array(t.String()), t.String()]),
          }),
        },
      )

      /**
       * POST /dashboard/emails/trash/empty
       * Empties the email trash entirely.
       */
      .post(
        "/emails/trash/empty",
        async ({ set }) => {
          const deleted = await emailService.emptyEmailsTrashUnscoped();
          logger.info("Emptied emails trash via dashboard", { deleted });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/emails/trash?flash=${encodeURIComponent(`Trash emptied: ${deleted} email(s) permanently deleted`)}`;
          return "";
        },
        { beforeHandle: adminGuard },
      )

      /**
       * POST /dashboard/emails/:id/trash
       * Move single email to trash from the detail or list page.
       */
      .post(
        "/emails/:id/trash",
        async ({ params, set }) => {
          const email = await emailService.trashEmailUnscoped(params.id);

          if (!email) {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/emails?flash=${encodeURIComponent("Email not found")}&flashType=error`;
            return "";
          }

          logger.info("Email trashed via dashboard", { id: params.id });
          set.status = 302;
          set.headers["location"] =
            `/dashboard/emails?flash=${encodeURIComponent("Email moved to trash")}`;
          return "";
        },
        { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
      )

      /**
       * POST /dashboard/emails/:id/restore
       * Restore a single trashed email: redirects back to trash view.
       */
      .post(
        "/emails/:id/restore",
        async ({ params, set }) => {
          const email = await emailService.restoreEmailUnscoped(params.id);

          const message = email ? "Email restored" : "Trashed email not found";
          const type: "success" | "error" = email ? "success" : "error";

          if (email) logger.info("Email restored via dashboard", { id: params.id });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/emails/trash?flash=${encodeURIComponent(message)}&flashType=${type}`;
          return "";
        },
        { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
      )

      /**
       * POST /dashboard/emails/:id/permanent
       * Permanently delete a single trashed email.
       */
      .post(
        "/emails/:id/permanent",
        async ({ params, set }) => {
          const email = await emailService.permanentDeleteEmailUnscoped(params.id);

          const message = email ? "Email deleted forever" : "Trashed email not found";
          const type: "success" | "error" = email ? "success" : "error";

          if (email)
            logger.info("Email permanently deleted via dashboard", { id: params.id });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/emails/trash?flash=${encodeURIComponent(message)}&flashType=${type}`;
          return "";
        },
        { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
      )

      /**
       * GET /dashboard/emails/:id
       * Single email detail view. Falls back to the trashed copy if the email
       * is in trash so users can navigate to it from the trash list.
       */
      .get(
        "/emails/:id",
        async ({ params, set }) => {
          const live = await emailService.getEmailByIdUnscoped(params.id);

          if (live) {
            return <EmailDetailPage email={live} isTrashed={false} />;
          }

          const trashed = await emailService.getTrashedEmailByIdUnscoped(params.id);
          if (trashed) {
            return <EmailDetailPage email={trashed} isTrashed={true} />;
          }

          set.status = 404;
          return "Email not found";
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({
            id: t.String(),
          }),
        },
      )
  );
}
