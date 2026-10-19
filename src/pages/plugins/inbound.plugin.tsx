import { t } from "elysia";
import { config } from "../../config.ts";
import { logger } from "../../utils/logger.ts";
import { SendEmailPage } from "../routes/send-email.tsx";
import { InboundPage } from "../routes/inbound.tsx";
import { InboundTrashPage } from "../routes/inbound-trash.tsx";
import { InboundDetailPage } from "../routes/inbound-detail.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import * as inboundService from "../../modules/inbound/services/inbound.service.ts";
import * as replyThreading from "../../modules/inbound/services/reply-threading.service.ts";
import { toIdArray } from "../lib/form.ts";
import { toFlash } from "../lib/responses.ts";
import { recordActorOf } from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/** Inbound email pages (#291): list, trash, detail and the reply form. */
export function inboundPages(app: GuardedDashboard) {
  return (
    app
      .get(
        "/inbound",
        async ({ query }) => {
          const { page, limit } = parsePagination(query);

          const { data, total } = await inboundService.listInboundEmails({ page, limit });

          const flash = toFlash(query.flash, query.flashType);

          return (
            <InboundPage
              emails={data}
              total={total}
              page={page}
              limit={limit}
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
       * GET /dashboard/inbound/trash
       * Trashed inbound emails: defined before /:id.
       */
      .get(
        "/inbound/trash",
        async ({ query }) => {
          const { page, limit } = parsePagination(query);

          const { data, total } = await inboundService.listTrashedInboundEmails({
            page,
            limit,
          });

          const flash = toFlash(query.flash, query.flashType);

          return (
            <InboundTrashPage
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

      /** POST /dashboard/inbound/bulk-trash: bulk soft-delete from list page. */
      .post(
        "/inbound/bulk-trash",
        async ({ body, set }) => {
          const ids = toIdArray(body.ids);
          const count = await inboundService.trashInboundEmails(ids);
          logger.info("Bulk-trashed inbound emails via dashboard", { count });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/inbound?flash=${encodeURIComponent(`${count} email(s) moved to trash`)}`;
          return "";
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            ids: t.Union([t.Array(t.String()), t.String()]),
          }),
        },
      )

      /** POST /dashboard/inbound/trash/bulk-restore: bulk restore from trash page. */
      .post(
        "/inbound/trash/bulk-restore",
        async ({ body, set }) => {
          const ids = toIdArray(body.ids);
          let restored = 0;
          for (const id of ids) {
            const r = await inboundService.restoreInboundEmail(id);
            if (r) restored += 1;
          }
          logger.info("Bulk-restored inbound emails via dashboard", { restored });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/inbound/trash?flash=${encodeURIComponent(`${restored} email(s) restored`)}`;
          return "";
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            ids: t.Union([t.Array(t.String()), t.String()]),
          }),
        },
      )

      /** POST /dashboard/inbound/trash/bulk-permanent: bulk hard-delete from trash page. */
      .post(
        "/inbound/trash/bulk-permanent",
        async ({ body, set }) => {
          const ids = toIdArray(body.ids);
          let deleted = 0;
          for (const id of ids) {
            const r = await inboundService.permanentDeleteInboundEmail(id);
            if (r) deleted += 1;
          }
          logger.info("Bulk-permanent-deleted inbound emails via dashboard", { deleted });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/inbound/trash?flash=${encodeURIComponent(`${deleted} email(s) deleted forever`)}`;
          return "";
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            ids: t.Union([t.Array(t.String()), t.String()]),
          }),
        },
      )

      /** POST /dashboard/inbound/trash/empty: empty inbound trash entirely. */
      .post(
        "/inbound/trash/empty",
        async ({ set }) => {
          const deleted = await inboundService.emptyInboundTrash();
          logger.info("Emptied inbound trash via dashboard", { deleted });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/inbound/trash?flash=${encodeURIComponent(`Trash emptied: ${deleted} email(s) permanently deleted`)}`;
          return "";
        },
        { beforeHandle: adminGuard },
      )

      /** POST /dashboard/inbound/:id/trash, move single inbound to trash. */
      .post(
        "/inbound/:id/trash",
        async ({ params, set }) => {
          const email = await inboundService.trashInboundEmail(params.id);

          if (!email) {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/inbound?flash=${encodeURIComponent("Inbound email not found")}&flashType=error`;
            return "";
          }

          logger.info("Inbound email trashed via dashboard", { id: params.id });
          set.status = 302;
          set.headers["location"] =
            `/dashboard/inbound?flash=${encodeURIComponent("Email moved to trash")}`;
          return "";
        },
        { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
      )

      /** POST /dashboard/inbound/:id/restore, restore single trashed inbound. */
      .post(
        "/inbound/:id/restore",
        async ({ params, set }) => {
          const email = await inboundService.restoreInboundEmail(params.id);
          const message = email ? "Email restored" : "Trashed email not found";
          const type: "success" | "error" = email ? "success" : "error";
          if (email) logger.info("Inbound restored via dashboard", { id: params.id });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/inbound/trash?flash=${encodeURIComponent(message)}&flashType=${type}`;
          return "";
        },
        { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
      )

      /** POST /dashboard/inbound/:id/permanent, hard-delete single trashed inbound. */
      .post(
        "/inbound/:id/permanent",
        async ({ params, set }) => {
          const email = await inboundService.permanentDeleteInboundEmail(params.id);
          const message = email ? "Email deleted forever" : "Trashed email not found";
          const type: "success" | "error" = email ? "success" : "error";
          if (email) {
            logger.info("Inbound permanently deleted via dashboard", { id: params.id });
          }

          set.status = 302;
          set.headers["location"] =
            `/dashboard/inbound/trash?flash=${encodeURIComponent(message)}&flashType=${type}`;
          return "";
        },
        { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
      )

      .get(
        "/inbound/:id",
        async ({ params, set }) => {
          /**
           * The email of ours it replies to (#192). Every role that may open
           * this page (member and up) may open that email's page too.
           */
          const live = await inboundService.getInboundEmailById(params.id);
          if (live) {
            const repliedTo = await replyThreading.getRepliedEmail(live);
            return (
              <InboundDetailPage email={live} isTrashed={false} repliedTo={repliedTo} />
            );
          }

          const trashed = await inboundService.getTrashedInboundEmailById(params.id);
          if (trashed) {
            const repliedTo = await replyThreading.getRepliedEmail(trashed);
            return (
              <InboundDetailPage email={trashed} isTrashed={true} repliedTo={repliedTo} />
            );
          }

          set.status = 404;
          return "Inbound email not found";
        },
        { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
      )

      /**
       * GET /dashboard/inbound/:id/reply (#86)
       *
       * Pre-fills the compose form with a reply skeleton. The chosen
       * direction:
       *   - `from` = the address that *received* the inbound (the user's
       *     own address) so reputation + SPF/DKIM stay aligned.
       *   - `to` = the original sender.
       *   - `subject` = the original subject prefixed with "Re: " when not
       *     already prefixed (case-insensitive to avoid double "Re:" loops).
       *   - body = the original message quoted: HTML wrapped in a
       *     `<blockquote>` with an attribution line, plain text with the
       *     classic `>` line prefix.
       *
       * The form carries the inbound id; `POST /dashboard/send` sets
       * `In-Reply-To` and `References` from it (#192).
       *
       * This is a GET: operator may navigate to it, see what's pre-filled,
       * back out without sending. No side effects until they hit Send.
       *
       * Trash status is not consulted: replying to a trashed message is
       * fine; the trash bit only governs the destructive Delete forever path.
       */
      .get(
        "/inbound/:id/reply",
        async ({ params, set, auth }) => {
          const inbound =
            (await inboundService.getInboundEmailById(params.id)) ??
            (await inboundService.getTrashedInboundEmailById(params.id));
          if (!inbound) {
            set.status = 404;
            return "Inbound email not found";
          }

          const originalSubject = inbound.subject ?? "";
          const replySubject = /^re:/i.test(originalSubject)
            ? originalSubject
            : `Re: ${originalSubject || "(no subject)"}`;

          /**
           * Quote construction. Attribution line uses the original sender +
           * received date. HTML and plain-text variants are constructed
           * independently: we don't auto-derive one from the other so the
           * quote matches whatever the original message actually had.
           */
          const receivedIso = inbound.receivedAt.toISOString();
          const attribution = `On ${receivedIso}, ${inbound.fromAddress} wrote:`;

          /** Defensive HTML escape: the attribution components (ISO date,
           *  email address) shouldn't contain `<>&"'` in practice, but a
           *  hostile sender shouldn't be able to inject anything either. */
          const escapeHtml = (s: string): string =>
            s.replace(/[&<>"']/g, (c) => {
              const map: Record<string, string> = {
                "&": "&amp;",
                "<": "&lt;",
                ">": "&gt;",
                '"': "&quot;",
                "'": "&#39;",
              };
              return map[c]!;
            });

          const quotedHtml = inbound.html
            ? `<p></p><p>${escapeHtml(attribution)}</p><blockquote style="margin:0 0 0 0.8em;padding-left:1em;border-left:2px solid #ccc;color:#555;">${inbound.html}</blockquote>`
            : undefined;

          const quotedText = inbound.textContent
            ? `\n\n${attribution}\n${inbound.textContent
                .split("\n")
                .map((line) => `> ${line}`)
                .join("\n")}`
            : undefined;

          /** Keys the viewer may send with (#219): a member's own, or every key. */
          const keys = await apiKeyService.listApiKeys(recordActorOf(auth));
          const activeKeys = keys.filter((k) => k.isActive);

          return (
            <SendEmailPage
              flash={undefined}
              apiKeys={activeKeys}
              defaultApiKeyId={activeKeys[0]?.id}
              prefill={{
                from: inbound.toAddress,
                to: inbound.fromAddress,
                subject: replySubject,
                html: quotedHtml,
                text: quotedText,
                /** Threading headers are computed from it on send (#192). */
                inboundId: inbound.id,
              }}
            />
          );
        },
        { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
      )
  );
}
