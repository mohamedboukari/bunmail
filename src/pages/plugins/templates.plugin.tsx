import { t } from "elysia";
import { ForbiddenPage } from "../routes/forbidden.tsx";
import { TemplatesPage } from "../routes/templates.tsx";
import { TemplateDetailPage } from "../routes/template-detail.tsx";
import { memberGuard } from "../guards.tsx";
import { flashMessageFor } from "../flash-errors.ts";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import * as templateService from "../../modules/templates/services/template.service.ts";
import { toFlash } from "../lib/responses.ts";
import {
  recordActorOf,
  managesAll,
  creatorNames,
  NO_USABLE_KEY_TEXT,
} from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/** The 403 page text for a member changing someone else's template (#219). */
const TEMPLATE_FORBIDDEN_TEXT =
  "Only the template's creator, admins and the owner can edit or delete it.";

/** Template pages (#291): list, create, detail, edit, delete. */
export function templatePages(app: GuardedDashboard) {
  return (
    app
      .get(
        "/templates",
        async ({ query, auth }) => {
          const [list, creators] = await Promise.all([
            templateService.listAllTemplates(),
            creatorNames(auth),
          ]);
          const flash = toFlash(query.flash, query.flashType);
          return (
            <TemplatesPage
              templates={list}
              flash={flash}
              creators={creators}
              viewer={{ id: auth.user.id, canManageAll: managesAll(auth) }}
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

      .post(
        "/templates",
        async ({ body, set, auth }) => {
          try {
            /**
             * The key the template is attached to (#219): the user's own active key;
             * admins and the owner fall back to anyone's, a member never does.
             */
            const activeKey = await apiKeyService.findDashboardKeyFor(
              recordActorOf(auth),
            );
            if (!activeKey) {
              set.status = 302;
              set.headers["location"] =
                `/dashboard/templates?flash=${encodeURIComponent(NO_USABLE_KEY_TEXT)}&flashType=error`;
              return "";
            }
            const variables = body.variables
              ? body.variables
                  .split(",")
                  .map((v: string) => v.trim())
                  .filter(Boolean)
              : undefined;
            await templateService.createTemplate(
              {
                name: body.name,
                subject: body.subject,
                html: body.html || undefined,
                text: body.text || undefined,
                variables,
              },
              activeKey.id,
              /** The template belongs to the signed-in account (#219). */
              auth.user.id,
            );
            set.status = 302;
            set.headers["location"] =
              `/dashboard/templates?flash=${encodeURIComponent("Template created")}`;
          } catch (error) {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/templates?flash=${encodeURIComponent(flashMessageFor(error, "Failed to create template"))}&flashType=error`;
          }
          return "";
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({
            name: t.String(),
            subject: t.String(),
            html: t.Optional(t.String()),
            text: t.Optional(t.String()),
            variables: t.Optional(t.String()),
          }),
        },
      )

      .get(
        "/templates/:id",
        async ({ params, set, query, auth }) => {
          const template = await templateService.getTemplateByIdUnscoped(params.id);
          if (!template) {
            set.status = 404;
            return "Template not found";
          }
          const creators = await creatorNames(auth);
          const flash = toFlash(query.flash, query.flashType);
          /** Display only: the edit and delete routes check ownership again (#219). */
          const canEdit = managesAll(auth) || template.createdByUserId === auth.user.id;
          return (
            <TemplateDetailPage
              template={template}
              flash={flash}
              creators={creators}
              canEdit={canEdit}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String() }),
          query: t.Object({
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/templates/:id/edit
       * Any signed-in account (#219); the service lets a member change only
       * the templates it created (admins and the owner any). Someone else's
       * template answers the 403 page: the detail page offers no form for it.
       */
      .post(
        "/templates/:id/edit",
        async ({ params, body, set, auth }) => {
          try {
            const variables = body.variables
              ? body.variables
                  .split(",")
                  .map((v: string) => v.trim())
                  .filter(Boolean)
              : undefined;
            const result = await templateService.updateTemplateAs(
              params.id,
              recordActorOf(auth),
              {
                name: body.name || undefined,
                subject: body.subject || undefined,
                html: body.html || undefined,
                text: body.text || undefined,
                variables,
              },
            );
            if (!result.ok && result.reason === "forbidden") {
              set.status = 403;
              return <ForbiddenPage message={TEMPLATE_FORBIDDEN_TEXT} />;
            }
            if (!result.ok) {
              set.status = 302;
              set.headers["location"] =
                `/dashboard/templates?flash=${encodeURIComponent("Template not found")}&flashType=error`;
              return "";
            }
            set.status = 302;
            set.headers["location"] =
              `/dashboard/templates/${params.id}?flash=${encodeURIComponent("Template updated")}`;
          } catch (error) {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/templates/${params.id}?flash=${encodeURIComponent(flashMessageFor(error, "Failed to update"))}&flashType=error`;
          }
          return "";
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String() }),
          body: t.Object({
            name: t.Optional(t.String()),
            subject: t.Optional(t.String()),
            html: t.Optional(t.String()),
            text: t.Optional(t.String()),
            variables: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/templates/:id/delete
       * Any signed-in account (#219); a member may delete only the templates
       * it created (checked in the service), anything else is the 403 page.
       */
      .post(
        "/templates/:id/delete",
        async ({ params, set, auth }) => {
          try {
            const result = await templateService.deleteTemplateAs(
              params.id,
              recordActorOf(auth),
            );
            if (!result.ok && result.reason === "forbidden") {
              set.status = 403;
              return <ForbiddenPage message={TEMPLATE_FORBIDDEN_TEXT} />;
            }
            if (!result.ok) {
              set.status = 302;
              set.headers["location"] =
                `/dashboard/templates?flash=${encodeURIComponent("Template not found")}&flashType=error`;
              return "";
            }
            set.status = 302;
            set.headers["location"] =
              `/dashboard/templates?flash=${encodeURIComponent("Template deleted")}`;
          } catch {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/templates?flash=${encodeURIComponent("Failed to delete template")}&flashType=error`;
          }
          return "";
        },
        { beforeHandle: memberGuard, params: t.Object({ id: t.String() }) },
      )
  );
}
