import { t } from "elysia";

/** Largest stored html or text body (same cap as an inline send body). */
const MAX_TEMPLATE_BODY_LENGTH = 5 * 1024 * 1024;

/**
 * Declared variable names: the names `{{name}}` placeholders can use
 * (word characters only, as the renderer matches), at most 100 of them.
 */
const variableNames = t.Array(
  t.String({ minLength: 1, maxLength: 100, pattern: "^\\w+$" }),
  {
    maxItems: 100,
  },
);

/** Validation schema for POST /api/v1/templates. */
export const createTemplateDto = t.Object({
  name: t.String({ minLength: 1, maxLength: 255 }),
  subject: t.String({ minLength: 1, maxLength: 500 }),
  html: t.Optional(t.String({ maxLength: MAX_TEMPLATE_BODY_LENGTH })),
  text: t.Optional(t.String({ maxLength: MAX_TEMPLATE_BODY_LENGTH })),
  variables: t.Optional(variableNames),
});

/** Validation schema for PUT /api/v1/templates/:id. All fields optional. */
export const updateTemplateDto = t.Object({
  name: t.Optional(t.String({ minLength: 1, maxLength: 255 })),
  subject: t.Optional(t.String({ minLength: 1, maxLength: 500 })),
  html: t.Optional(t.String({ maxLength: MAX_TEMPLATE_BODY_LENGTH })),
  text: t.Optional(t.String({ maxLength: MAX_TEMPLATE_BODY_LENGTH })),
  variables: t.Optional(variableNames),
});
