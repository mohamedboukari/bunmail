import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { EmailsTrashPage } from "../routes/emails-trash.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import * as emailService from "../../modules/emails/services/email.service.ts";
import { toIdArray } from "../lib/form.ts";
import { toFlash } from "../lib/responses.ts";
import type { emailListPages } from "./emails-list.plugin.tsx";

/**
 * The trash page and the trash actions: bulk and single trash, restore
 * and permanent delete, empty. Takes the instance the list routes were
 * registered on, so the route types chain exactly as in one `emailPages`
 * chain.
 */
export function emailTrashPages(app: ReturnType<typeof emailListPages>) {
  return (
    app
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
  );
}
