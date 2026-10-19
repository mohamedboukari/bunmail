import { Elysia, t } from "elysia";
import { createTemplateDto, updateTemplateDto } from "./dtos/create-template.dto.ts";
import { listTemplatesQueryDto } from "./dtos/list-templates.dto.ts";
import { serializeTemplate } from "./serializations/template.serialization.ts";
import * as templateService from "./services/template.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Templates plugin: CRUD for email templates under /api/v1/templates.
 *
 * Routes:
 * - POST /        → Create a template
 * - GET /         → List templates for the current API key (paginated)
 * - GET /:id      → Get a single template
 * - PUT /:id      → Update a template
 * - DELETE /:id   → Delete a template
 */
export const templatesPlugin = new Elysia({
  prefix: "/api/v1/templates",
  normalize: true,
})
  .use(authMiddleware)
  .use(rateLimitMiddleware)

  .post(
    "/",
    async ({ body, apiKeyId, apiKeyCreatedByUserId }) => {
      logger.info("POST /api/v1/templates", { name: body.name });

      const template = await templateService.createTemplate(
        {
          name: body.name,
          subject: body.subject,
          html: body.html,
          text: body.text,
          variables: body.variables,
        },
        apiKeyId,
        /** Belongs to the calling key's user (#219). */
        apiKeyCreatedByUserId,
      );

      return { success: true, data: serializeTemplate(template) };
    },
    {
      body: createTemplateDto,
      detail: {
        tags: ["Templates"],
        summary: "Create template",
        description:
          "Creates a new email template with optional Mustache-style {{variable}} substitution.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/",
    async ({ query, apiKeyId }) => {
      const page = query.page ?? 1;
      const limit = query.limit ?? 100;
      const { data, total } = await templateService.listTemplates(apiKeyId, {
        page,
        limit,
      });

      return {
        success: true,
        data: data.map(serializeTemplate),
        pagination: { page, limit, total },
      };
    },
    {
      query: listTemplatesQueryDto,
      detail: {
        tags: ["Templates"],
        summary: "List templates",
        description:
          "Returns the current API key's templates, oldest first, paginated with `?page` and `?limit` (default and maximum 100).",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .get(
    "/:id",
    async ({ params, set, apiKeyId }) => {
      const template = await templateService.getTemplateById(params.id, apiKeyId);

      if (!template) {
        set.status = 404;
        return { success: false, error: "Template not found" };
      }

      return { success: true, data: serializeTemplate(template) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Templates"],
        summary: "Get template by ID",
        description: "Returns a single template by its ID.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .put(
    "/:id",
    async ({ params, body, set, apiKeyId }) => {
      const template = await templateService.updateTemplate(params.id, apiKeyId, {
        name: body.name,
        subject: body.subject,
        html: body.html,
        text: body.text,
        variables: body.variables,
      });

      if (!template) {
        set.status = 404;
        return { success: false, error: "Template not found" };
      }

      return { success: true, data: serializeTemplate(template) };
    },
    {
      params: t.Object({ id: t.String() }),
      body: updateTemplateDto,
      detail: {
        tags: ["Templates"],
        summary: "Update template",
        description: "Updates an existing template. All fields are optional.",
        security: [{ bearerAuth: [] }],
      },
    },
  )

  .delete(
    "/:id",
    async ({ params, set, apiKeyId }) => {
      const template = await templateService.deleteTemplate(params.id, apiKeyId);

      if (!template) {
        set.status = 404;
        return { success: false, error: "Template not found" };
      }

      return { success: true, data: serializeTemplate(template) };
    },
    {
      params: t.Object({ id: t.String() }),
      detail: {
        tags: ["Templates"],
        summary: "Delete template",
        description: "Permanently deletes a template.",
        security: [{ bearerAuth: [] }],
      },
    },
  );
