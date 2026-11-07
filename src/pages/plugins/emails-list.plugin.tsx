import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { isEmailStatus } from "../../modules/emails/types/email.types.ts";
import {
  describeTagProblem,
  parseTagFilters,
} from "../../modules/emails/services/tags.ts";
import { EmailsPage } from "../routes/emails.tsx";
import { EmailTombstonesPage } from "../routes/email-tombstones.tsx";
import { memberGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import * as emailService from "../../modules/emails/services/email.service.ts";
import * as tombstoneService from "../../modules/emails/services/tombstone.service.ts";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import { toFlash } from "../lib/responses.ts";
import { recordActorOf } from "../lib/record-ownership.ts";
import type { emailSendPages } from "./emails-send.plugin.tsx";

/**
 * The email list and the tombstones (#34). Takes the instance the send
 * routes were registered on, so the route types chain exactly as in one
 * `emailPages` chain.
 */
export function emailListPages(app: ReturnType<typeof emailSendPages>) {
  return (
    app
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
          /**
           * Tag filter (#189): one `key:value` from the text input. An
           * invalid one lists nothing and says why, rather than silently
           * listing everything. The log names the rule, never the value.
           */
          const tag = query.tag?.trim() || undefined;
          const parsedTag = tag === undefined ? undefined : parseTagFilters([tag]);
          if (parsedTag && !parsedTag.ok) {
            logger.warn("Dashboard email list: invalid tag filter", {
              userId: auth.user.id,
              tag: parsedTag.key,
              problem: parsedTag.problem,
            });
          }

          const [{ data, total }, keys] = await Promise.all([
            parsedTag && !parsedTag.ok
              ? { data: [], total: 0 }
              : emailService.listAllEmails({
                  page,
                  limit,
                  status,
                  source,
                  apiKeyId,
                  tags: parsedTag?.filters,
                }),
            /** Populate the API-key dropdown (#137): a member's own keys only (#219). */
            apiKeyService.listApiKeys(recordActorOf(auth)),
          ]);

          const flash =
            parsedTag && !parsedTag.ok
              ? {
                  message: describeTagProblem(parsedTag, "Tag filter"),
                  type: "error" as const,
                }
              : toFlash(query.flash, query.flashType);

          return (
            <EmailsPage
              emails={data}
              total={total}
              page={page}
              limit={limit}
              status={status}
              source={source}
              apiKeyId={apiKeyId}
              tag={tag}
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
            /** Tag filter (#189), `key:value`. */
            tag: t.Optional(t.String()),
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
  );
}
