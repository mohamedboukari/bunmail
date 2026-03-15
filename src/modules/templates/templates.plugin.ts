import { Elysia, t } from "elysia";
import { createTemplateDto, updateTemplateDto } from "./dtos/create-template.dto.ts";
import { serializeTemplate } from "./serializations/template.serialization.ts";
import * as templateService from "./services/template.service.ts";
import { authMiddleware } from "../../middleware/auth.ts";
import { rateLimitMiddleware } from "../../middleware/rate-limit.ts";
import { logger } from "../../utils/logger.ts";

/**
 * Templates plugin — CRUD for email templates under /api/v1/templates.
 *
 * Routes:
 * - POST /        → Create a template
 * - GET /         → List templates for the current API key
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
    async (context) => {
      const { body, apiKeyId } = context as typeof context & { apiKeyId: string };

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
      );

      return { success: true, data: serializeTemplate(template) };
    },
    { body: createTemplateDto },
  )

  .get("/", async (context) => {
    const { apiKeyId } = context as typeof context & { apiKeyId: string };

    const list = await templateService.listTemplates(apiKeyId);

    return { success: true, data: list.map(serializeTemplate) };
  })

  .get(
    "/:id",
    async (context) => {
      const { params, set, apiKeyId } = context as typeof context & { apiKeyId: string };

      const template = await templateService.getTemplateById(params.id, apiKeyId);

      if (!template) {
        set.status = 404;
        return { success: false, error: "Template not found" };
      }

      return { success: true, data: serializeTemplate(template) };
    },
    { params: t.Object({ id: t.String() }) },
  )

  .put(
    "/:id",
    async (context) => {
      const { params, body, set, apiKeyId } = context as typeof context & { apiKeyId: string };

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
    },
  )

  .delete(
    "/:id",
    async (context) => {
      const { params, set, apiKeyId } = context as typeof context & { apiKeyId: string };

      const template = await templateService.deleteTemplate(params.id, apiKeyId);

      if (!template) {
        set.status = 404;
        return { success: false, error: "Template not found" };
      }

      return { success: true, data: serializeTemplate(template) };
    },
    { params: t.Object({ id: t.String() }) },
  );
