import { t } from "elysia";
import { SuppressionsPage } from "../routes/suppressions.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import * as suppressionService from "../../modules/suppressions/services/suppression.service.ts";
import { toFlash } from "../lib/responses.ts";
import { recordActorOf } from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/** Suppression pages (#291): the list and per-row delete. */
export function suppressionPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/suppressions (#89)
       *
       * Admin-scoped list across every API key. Auto-suppressions get
       * filed under whichever key happened to be sending when a bounce
       * arrived; before this page the only way to clear a stuck
       * suppression was direct SQL because the suppression's owning key
       * was rarely the same key as the operator's Bearer token. The list
       * supports two filter params (`email` substring + `apiKeyId`) and
       * per-row deletion via a POST sibling route.
       */
      .get(
        "/suppressions",
        async ({ query, auth }) => {
          const { page, limit } = parsePagination(query, 25);

          const [{ data, total }, allKeys] = await Promise.all([
            suppressionService.listAllSuppressions({
              page,
              limit,
              email: query.email || undefined,
              apiKeyId: query.apiKeyId || undefined,
            }),
            /** Filter dropdown and row labels: a member's own keys only (#219). */
            apiKeyService.listApiKeys(recordActorOf(auth)),
          ]);

          /** Pre-build the id→name lookup once so the page component
           *  doesn't have to make N service calls or duplicate logic. */
          const apiKeyLabels = Object.fromEntries(
            allKeys.map((k) => [k.id, { name: k.name }]),
          );

          const flash = toFlash(query.flash, query.flashType);

          return (
            <SuppressionsPage
              suppressions={data}
              total={total}
              page={page}
              limit={limit}
              filters={{
                email: query.email || undefined,
                apiKeyId: query.apiKeyId || undefined,
              }}
              apiKeys={allKeys}
              apiKeyLabels={apiKeyLabels}
              flash={flash}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            page: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            email: t.Optional(t.String()),
            apiKeyId: t.Optional(t.String()),
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/suppressions/:id/delete (#89)
       *
       * Unscoped delete: the dashboard session already authenticated; we
       * trust the operator to clear any suppression they can see. Redirect
       * back to the list (preserving the filter context that brought them
       * here would be nicer; deferred to keep this PR tight).
       */
      .post(
        "/suppressions/:id/delete",
        async ({ params, set }) => {
          const removed = await suppressionService.deleteSuppressionByIdUnscoped(
            params.id,
          );
          const flash = removed
            ? `Suppression for ${removed.email} removed`
            : "Suppression not found (already deleted?)";
          const flashType = removed ? "success" : "error";

          set.status = 302;
          set.headers["location"] =
            `/dashboard/suppressions?flash=${encodeURIComponent(flash)}&flashType=${flashType}`;
          return "";
        },
        { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
      )
  );
}
