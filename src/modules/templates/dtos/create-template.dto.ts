import { t } from "elysia";

/** Validation schema for POST /api/v1/templates. */
export const createTemplateDto = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  subject: t.String({ minLength: 1, maxLength: 500 }),
  html: t.Optional(t.String()),
  text: t.Optional(t.String()),
  variables: t.Optional(t.Array(t.String())),
});

/** Validation schema for PUT /api/v1/templates/:id. All fields optional. */
export const updateTemplateDto = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  subject: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
  html: t.Optional(t.String()),
  text: t.Optional(t.String()),
  variables: t.Optional(t.Array(t.String())),
});
