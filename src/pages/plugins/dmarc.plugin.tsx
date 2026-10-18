import { t } from "elysia";
import { DmarcReportsPage } from "../routes/dmarc-reports.tsx";
import { DmarcReportDetailPage } from "../routes/dmarc-report-detail.tsx";
import { memberGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import * as dmarcReportsService from "../../modules/dmarc-reports/services/dmarc-reports.service.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/** DMARC report pages (#291): list and detail. */
export function dmarcPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/dmarc-reports: list page with optional `?domain=`
       * filter. The filter dropdown is driven by the distinct set of
       * domains we have reports for.
       */
      .get(
        "/dmarc-reports",
        async ({ query }) => {
          const { page, limit } = parsePagination(query);
          const domain = query.domain || undefined;

          const { data, total } = await dmarcReportsService.listDmarcReports({
            page,
            limit,
            domain,
          });

          const domains = await dmarcReportsService.listReportDomains();

          return (
            <DmarcReportsPage
              reports={data}
              total={total}
              page={page}
              limit={limit}
              domainFilter={domain}
              domains={domains}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            page: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            domain: t.Optional(t.String()),
          }),
        },
      )

      /** GET /dashboard/dmarc-reports/:id, detail with per-source-IP records. */
      .get(
        "/dmarc-reports/:id",
        async ({ params, set }) => {
          const result = await dmarcReportsService.getDmarcReportById(params.id);
          if (!result) {
            set.status = 404;
            return "DMARC report not found";
          }
          return (
            <DmarcReportDetailPage report={result.report} records={result.records} />
          );
        },
        { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
      )
  );
}
