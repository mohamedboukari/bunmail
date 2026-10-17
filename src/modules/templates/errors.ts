/**
 * Thrown by `renderTemplate` when substituting variables would produce
 * more than the allowed output. Variables multiply a template's size (a
 * placeholder repeated a million times, each replaced by a long value),
 * so the output is bounded while rendering, before a huge string exists.
 * Mapped to HTTP 422 with `code: "TEMPLATE_OUTPUT_TOO_LARGE"`.
 */
export class TemplateTooLargeError extends Error {
  override readonly name = "TemplateTooLargeError";

  constructor(limit: number) {
    super(`Rendered template exceeds ${limit} characters.`);
  }
}
