import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { adminGuard } from "../guards.tsx";
import { redirect } from "../lib/responses.ts";
import { parseAuditActor } from "../lib/audit.ts";
import { csvExportResponse } from "../lib/csv-export.tsx";
import {
  isEmailStatus,
  type EmailSource,
} from "../../modules/emails/types/email.types.ts";
import { parseTagFilters, type TagFilter } from "../../modules/emails/services/tags.ts";
import { isAuditAction, isAuditOutcome } from "../../modules/audit/types/audit.types.ts";
import * as webhookService from "../../modules/webhooks/services/webhook.service.ts";
import {
  emailsExport,
  emailsTrashExport,
  inboundExport,
  inboundTrashExport,
  tombstonesExport,
} from "../../modules/exports/services/mail-exports.service.ts";
import {
  auditLogExport,
  dmarcReportsExport,
  suppressionsExport,
  webhookDeliveriesExport,
} from "../../modules/exports/services/record-exports.service.ts";
import {
  apiKeysExport,
  domainsExport,
  invitationsExport,
  templatesExport,
  usersExport,
  webhooksExport,
} from "../../modules/exports/services/setting-exports.service.ts";
import { apiKeysTabOf } from "../routes/api-keys.tsx";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/**
 * CSV exports (#430): one `GET <page>/export.csv` per dashboard table,
 * for admins and the owner only (`adminGuard` on every route; members get
 * the 403 page and see no Export link).
 *
 * Each route reads the same query parameters as its list page, validated
 * the same way (an unknown value is ignored, as on the page), builds the
 * table's export source from the exports module and hands it to
 * `csvExportResponse`, which applies the per-user budget, streams the
 * file, and logs and audits it. Admins see every key's records, so the
 * sources are unscoped, like the dashboard lists.
 *
 * A literal `export.csv` segment wins over the `/:id` routes of the same
 * area in Elysia's router, so the order of the plugins does not matter.
 */

/** The names of the filters that are set, for the audit event (never the values). */
function setFilters(filters: Record<string, unknown>): string[] {
  return Object.keys(filters).filter((name) => filters[name] !== undefined);
}

/** A query value, or `undefined` when empty: exactly as the list pages read them. */
function present(value: string | undefined): string | undefined {
  return value || undefined;
}

/** Export routes, mounted after the session guard. */
export function exportPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/emails/export.csv: the email list's filters (status,
       * source, API key, tag). An invalid tag goes back to the list, which
       * explains the problem, instead of exporting nothing silently.
       */
      .get(
        "/emails/export.csv",
        ({ query, auth, request, server, set }) => {
          const status = isEmailStatus(query.status) ? query.status : undefined;
          const source: EmailSource | undefined =
            query.source === "api" ? "api" : query.source === "smtp" ? "smtp" : undefined;
          const apiKeyId = present(query.apiKeyId);
          /** Trimmed, like the email list (#189). */
          const tag = present(query.tag?.trim());
          let tags: TagFilter[] | undefined;
          if (tag !== undefined) {
            const parsed = parseTagFilters([tag]);
            if (!parsed.ok) {
              logger.warn("CSV export refused: invalid tag filter", {
                userId: auth.user.id,
                tag: parsed.key,
                problem: parsed.problem,
              });
              return redirect(
                set,
                `/dashboard/emails?${new URLSearchParams({ tag }).toString()}`,
              );
            }
            tags = parsed.filters;
          }
          const filters = { status, source, apiKeyId, tags };
          return csvExportResponse({
            source: emailsExport(filters),
            filters: setFilters({ status, source, apiKeyId, tag }),
            auth,
            request,
            server,
            set,
          });
        },
        {
          beforeHandle: adminGuard,
          query: t.Object({
            status: t.Optional(t.String()),
            source: t.Optional(t.String()),
            apiKeyId: t.Optional(t.String()),
            tag: t.Optional(t.String()),
          }),
        },
      )

      /** GET /dashboard/emails/trash/export.csv: every trashed email. */
      .get(
        "/emails/trash/export.csv",
        ({ auth, request, server, set }) =>
          csvExportResponse({
            source: emailsTrashExport(),
            filters: [],
            auth,
            request,
            server,
            set,
          }),
        { beforeHandle: adminGuard },
      )

      /** GET /dashboard/emails/tombstones/export.csv: the optional `messageId` filter. */
      .get(
        "/emails/tombstones/export.csv",
        ({ query, auth, request, server, set }) => {
          const messageId = present(query.messageId);
          return csvExportResponse({
            source: tombstonesExport(messageId),
            filters: setFilters({ messageId }),
            auth,
            request,
            server,
            set,
          });
        },
        {
          beforeHandle: adminGuard,
          query: t.Object({ messageId: t.Optional(t.String()) }),
        },
      )

      /** GET /dashboard/inbound/export.csv: every received email not trashed. */
      .get(
        "/inbound/export.csv",
        ({ auth, request, server, set }) =>
          csvExportResponse({
            source: inboundExport(),
            filters: [],
            auth,
            request,
            server,
            set,
          }),
        { beforeHandle: adminGuard },
      )

      /** GET /dashboard/inbound/trash/export.csv: every trashed inbound email. */
      .get(
        "/inbound/trash/export.csv",
        ({ auth, request, server, set }) =>
          csvExportResponse({
            source: inboundTrashExport(),
            filters: [],
            auth,
            request,
            server,
            set,
          }),
        { beforeHandle: adminGuard },
      )

      /** GET /dashboard/suppressions/export.csv: the `email` substring and `apiKeyId` filters. */
      .get(
        "/suppressions/export.csv",
        ({ query, auth, request, server, set }) => {
          const email = present(query.email);
          const apiKeyId = present(query.apiKeyId);
          return csvExportResponse({
            source: suppressionsExport({ email, apiKeyId }),
            filters: setFilters({ email, apiKeyId }),
            auth,
            request,
            server,
            set,
          });
        },
        {
          beforeHandle: adminGuard,
          query: t.Object({
            email: t.Optional(t.String()),
            apiKeyId: t.Optional(t.String()),
          }),
        },
      )

      /** GET /dashboard/audit-log/export.csv: the `action`, `actor` and `outcome` filters. */
      .get(
        "/audit-log/export.csv",
        ({ query, auth, request, server, set }) => {
          const action = isAuditAction(query.action) ? query.action : undefined;
          const outcome = isAuditOutcome(query.outcome) ? query.outcome : undefined;
          const actor = parseAuditActor(query.actor);
          return csvExportResponse({
            source: auditLogExport({ action, actor, outcome }),
            filters: setFilters({ action, actor, outcome }),
            auth,
            request,
            server,
            set,
          });
        },
        {
          beforeHandle: adminGuard,
          query: t.Object({
            action: t.Optional(t.String()),
            actor: t.Optional(t.String()),
            outcome: t.Optional(t.String()),
          }),
        },
      )

      /** GET /dashboard/dmarc-reports/export.csv: the optional `domain` filter. */
      .get(
        "/dmarc-reports/export.csv",
        ({ query, auth, request, server, set }) => {
          const domain = present(query.domain);
          return csvExportResponse({
            source: dmarcReportsExport(domain),
            filters: setFilters({ domain }),
            auth,
            request,
            server,
            set,
          });
        },
        {
          beforeHandle: adminGuard,
          query: t.Object({ domain: t.Optional(t.String()) }),
        },
      )

      /**
       * GET /dashboard/webhooks/:id/deliveries/export.csv: one webhook's
       * deliveries with the page's `status` filter. An unknown webhook goes
       * back to the list with the same flash as the deliveries page.
       */
      .get(
        "/webhooks/:id/deliveries/export.csv",
        async ({ params, query, auth, request, server, set }) => {
          const hooks = await webhookService.listAllWebhooks();
          const webhook = hooks.find((h) => h.id === params.id);
          if (!webhook) {
            return redirect(
              set,
              `/dashboard/webhooks?flash=${encodeURIComponent("Webhook not found")}&flashType=error`,
            );
          }
          const status =
            query.status === "pending" ||
            query.status === "delivered" ||
            query.status === "failed"
              ? query.status
              : undefined;
          return csvExportResponse({
            source: webhookDeliveriesExport(webhook.id, status),
            filters: setFilters({ webhook: webhook.id, status }),
            auth,
            request,
            server,
            set,
          });
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
          query: t.Object({ status: t.Optional(t.String()) }),
        },
      )

      /**
       * GET /dashboard/api-keys/export.csv: the open tab's keys (#431),
       * Active by default, `?tab=revoked` the revoked and disabled ones.
       */
      .get(
        "/api-keys/export.csv",
        ({ query, auth, request, server, set }) => {
          const tab = apiKeysTabOf(query.tab);
          return csvExportResponse({
            source: apiKeysExport(tab),
            filters: ["tab"],
            auth,
            request,
            server,
            set,
          });
        },
        { beforeHandle: adminGuard, query: t.Object({ tab: t.Optional(t.String()) }) },
      )

      /** GET /dashboard/domains/export.csv: every domain. */
      .get(
        "/domains/export.csv",
        ({ auth, request, server, set }) =>
          csvExportResponse({
            source: domainsExport(),
            filters: [],
            auth,
            request,
            server,
            set,
          }),
        { beforeHandle: adminGuard },
      )

      /** GET /dashboard/templates/export.csv: every template. */
      .get(
        "/templates/export.csv",
        ({ auth, request, server, set }) =>
          csvExportResponse({
            source: templatesExport(),
            filters: [],
            auth,
            request,
            server,
            set,
          }),
        { beforeHandle: adminGuard },
      )

      /** GET /dashboard/webhooks/export.csv: every webhook. */
      .get(
        "/webhooks/export.csv",
        ({ auth, request, server, set }) =>
          csvExportResponse({
            source: webhooksExport(),
            filters: [],
            auth,
            request,
            server,
            set,
          }),
        { beforeHandle: adminGuard },
      )

      /** GET /dashboard/users/export.csv: every account. */
      .get(
        "/users/export.csv",
        ({ auth, request, server, set }) =>
          csvExportResponse({
            source: usersExport(),
            filters: [],
            auth,
            request,
            server,
            set,
          }),
        { beforeHandle: adminGuard },
      )

      /** GET /dashboard/invitations/export.csv: the pending invitations. */
      .get(
        "/invitations/export.csv",
        ({ auth, request, server, set }) =>
          csvExportResponse({
            source: invitationsExport(),
            filters: [],
            auth,
            request,
            server,
            set,
          }),
        { beforeHandle: adminGuard },
      )
  );
}
