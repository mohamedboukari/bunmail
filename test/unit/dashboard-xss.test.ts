import { describe, test, expect } from "bun:test";
import { TemplatesPage } from "../../src/pages/routes/templates.tsx";
import { SuppressionsPage } from "../../src/pages/routes/suppressions.tsx";
import type { Template } from "../../src/modules/templates/types/template.types.ts";
import type { Suppression } from "../../src/modules/suppressions/types/suppression.types.ts";

/**
 * Stored-XSS regression tests for dashboard pages that render data any
 * API key can write, including restricted (send-only) keys.
 *
 * - Template `variables` are set through `POST`/`PUT /api/v1/templates`.
 *   The templates list rendered them without `safe`, and the CI xss-scan
 *   missed it: `@kitajs/ts-html-plugin` 4.1.4 only checks the false branch
 *   of `cond ? a : b`.
 * - Suppression addresses are set through `POST /api/v1/suppressions`.
 *   The Delete button put the address inside an inline `onclick` string.
 *   Attribute escaping only covers `"`, and a local part may contain `'`,
 *   which ends the JavaScript string. xss-scan never checks attributes.
 */

/** A payload whose escaped form differs unmistakably from its raw form. */
const XSS = `<img src=x onerror="alert(1)">`;
/** After HTML-escaping, `<` becomes `&lt;`: the payload can't open a tag. */
const ESCAPED_LT = "&lt;img";

function makeTemplate(overrides: Partial<Template> = {}): Template {
  return {
    id: "tpl_x",
    apiKeyId: "key_x",
    name: "Welcome",
    subject: "Hello",
    html: null,
    textContent: null,
    variables: [XSS],
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    createdByUserId: null,
    ...overrides,
  };
}

function makeSuppression(overrides: Partial<Suppression> = {}): Suppression {
  return {
    id: "sup_x",
    apiKeyId: "key_x",
    email: "o'brien@example.com",
    reason: "manual",
    bounceType: null,
    diagnosticCode: null,
    sourceEmailId: null,
    expiresAt: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    ...overrides,
  };
}

/** Every inline event-handler attribute value in the rendered HTML. */
function eventHandlerValues(html: string): string[] {
  return [...html.matchAll(/\bon[a-z]+="([^"]*)"/g)].map((m) => m[1] ?? "");
}

describe("templates list: XSS", () => {
  test("escapes API-writable template variables", async () => {
    const html = await TemplatesPage({
      templates: [makeTemplate()],
      creators: new Map(),
      viewer: { id: "usr_x", canManageAll: true },
    });

    expect(html).not.toContain(XSS);
    expect(html).toContain(ESCAPED_LT);
  });
});

describe("suppressions list: XSS", () => {
  test("never puts a stored address inside an inline event handler", async () => {
    const sup = makeSuppression();
    const html = await SuppressionsPage({
      suppressions: [sup],
      total: 1,
      page: 1,
      limit: 20,
      filters: {},
      apiKeys: [],
      apiKeyLabels: {},
    });

    /** The address is shown in the row (escaped), just not in script. */
    expect(html).toContain("o&#x27;brien@example.com");
    for (const handler of eventHandlerValues(html)) {
      expect(handler).not.toContain("brien");
    }
  });
});
