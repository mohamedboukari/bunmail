import { eq, and } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { templates } from "../models/template.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { TemplateTooLargeError } from "../errors.ts";
import type {
  Template,
  CreateTemplateInput,
  TemplateActor,
  TemplateChangeResult,
  UpdateTemplateInput,
} from "../types/template.types.ts";

/** Largest rendered html or text body (same cap as an inline send body). */
export const MAX_RENDERED_BODY_LENGTH = 5 * 1024 * 1024;

/** Largest rendered subject (same cap as an inline send subject). */
export const MAX_RENDERED_SUBJECT_LENGTH = 500;

/** Characters HTML-escaped in a `{{variable}}` of an HTML body (#250). */
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** A raw `{{{variable}}}` or an escaped `{{variable}}` placeholder. */
const PLACEHOLDER_RE = /\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g;

/**
 * Simple Mustache-style variable substitution.
 * Replaces `{{variableName}}` with the corresponding value.
 *
 * In an HTML body (`options.html`), `{{name}}` is HTML-escaped (#250): a
 * value such as a user-supplied display name can no longer inject markup
 * (a fake link, a form) into mail BunMail signs for the domain.
 * `{{{name}}}` inserts the value as is, for callers that pass HTML on
 * purpose. Subjects and text bodies are not HTML: both forms insert the
 * value as is there.
 *
 * The output is bounded while it is built: each substitution updates a
 * running length, and rendering stops with `TemplateTooLargeError` as soon
 * as it would pass `maxLength`. Only the variables' own keys are used, so
 * `{{constructor}}` and similar inherited names stay as written.
 */
export function renderTemplate(
  templateStr: string,
  variables: Record<string, string>,
  maxLength: number = MAX_RENDERED_BODY_LENGTH,
  options: { html?: boolean } = {},
): string {
  let length = templateStr.length;
  const rendered = templateStr.replace(
    PLACEHOLDER_RE,
    (match, rawKey: string | undefined, escapedKey: string | undefined) => {
      const key = rawKey ?? escapedKey ?? "";
      const raw = Object.hasOwn(variables, key) ? variables[key] : undefined;
      if (raw === undefined) return match;
      const value =
        options.html === true && rawKey === undefined
          ? raw.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
          : raw;
      length += value.length - match.length;
      if (length > maxLength) throw new TemplateTooLargeError(maxLength);
      return value;
    },
  );
  if (rendered.length > maxLength) throw new TemplateTooLargeError(maxLength);
  return rendered;
}

/**
 * Creates a new email template scoped to the requesting API key.
 *
 * @param input - Template name, subject, and optional html/text bodies
 * @param apiKeyId - Owner API key
 * @param createdByUserId - Who created it (#219): the dashboard user, or
 *   the calling key's user over REST; null = the owner. A member may edit
 *   and delete only the templates that carry its id.
 * @returns The newly created template row
 */
export async function createTemplate(
  input: CreateTemplateInput,
  apiKeyId: string,
  createdByUserId: string | null = null,
): Promise<Template> {
  const id = generateId("tpl");

  logger.info("Creating template", { id, name: input.name, apiKeyId, createdByUserId });

  const [template] = await db
    .insert(templates)
    .values({
      id,
      apiKeyId,
      name: input.name,
      subject: input.subject,
      html: input.html ?? null,
      textContent: input.text ?? null,
      variables: input.variables ?? [],
      createdByUserId,
    })
    .returning();

  return template!;
}

/** Lists all templates belonging to the given API key. */
export async function listTemplates(apiKeyId: string): Promise<Template[]> {
  return db.select().from(templates).where(eq(templates.apiKeyId, apiKeyId));
}

/** Returns all templates across all API keys (dashboard use). */
export async function listAllTemplates(): Promise<Template[]> {
  return db.select().from(templates);
}

/** Returns a template by ID without API key scoping (dashboard use). */
export async function getTemplateByIdUnscoped(id: string): Promise<Template | undefined> {
  const [row] = await db.select().from(templates).where(eq(templates.id, id));
  return row;
}

/** Returns a template by ID, scoped to the requesting API key. */
export async function getTemplateById(
  id: string,
  apiKeyId: string,
): Promise<Template | undefined> {
  const [template] = await db
    .select()
    .from(templates)
    .where(and(eq(templates.id, id), eq(templates.apiKeyId, apiKeyId)));

  return template;
}

/**
 * Partially updates a template. Only provided fields are overwritten.
 * Returns the updated row, or undefined if not found.
 */
export async function updateTemplate(
  id: string,
  apiKeyId: string,
  input: UpdateTemplateInput,
): Promise<Template | undefined> {
  logger.info("Updating template", { id, apiKeyId });

  const existing = await getTemplateById(id, apiKeyId);
  if (!existing) return undefined;

  const [template] = await db
    .update(templates)
    .set({
      ...(input.name !== undefined && { name: input.name }),
      ...(input.subject !== undefined && { subject: input.subject }),
      ...(input.html !== undefined && { html: input.html }),
      ...(input.text !== undefined && { textContent: input.text }),
      ...(input.variables !== undefined && { variables: input.variables }),
      updatedAt: new Date(),
    })
    .where(and(eq(templates.id, id), eq(templates.apiKeyId, apiKeyId)))
    .returning();

  return template;
}

/** Deletes a template. Returns the deleted row, or undefined if not found. */
export async function deleteTemplate(
  id: string,
  apiKeyId: string,
): Promise<Template | undefined> {
  logger.info("Deleting template", { id, apiKeyId });

  const [template] = await db
    .delete(templates)
    .where(and(eq(templates.id, id), eq(templates.apiKeyId, apiKeyId)))
    .returning();

  return template;
}

/**
 * Whether `actor` may edit or delete `template` (#219): admins and the
 * owner any template, a member only one it created. A template with no
 * creator belongs to the owner, so a member never matches it.
 */
function mayChangeTemplate(actor: TemplateActor, template: Template): boolean {
  if (actor.role === "admin" || actor.role === "owner") return true;
  return template.createdByUserId === actor.id;
}

/**
 * Looks a template up for a dashboard edit or delete and applies the
 * ownership rule (#219). Refusals are logged at `warn` with IDs only.
 */
async function templateForChange(
  id: string,
  actor: TemplateActor,
  action: "update" | "delete",
): Promise<TemplateChangeResult> {
  const template = await getTemplateByIdUnscoped(id);
  if (!template) {
    logger.warn("Template not found for dashboard change", {
      id,
      action,
      actorId: actor.id,
    });
    return { ok: false, reason: "not_found" };
  }
  if (!mayChangeTemplate(actor, template)) {
    logger.warn("Template change refused: not the creator", {
      id,
      action,
      actorId: actor.id,
      actorRole: actor.role,
      createdByUserId: template.createdByUserId,
    });
    return { ok: false, reason: "forbidden" };
  }
  return { ok: true, template };
}

/**
 * Dashboard edit (#219): updates a template if `actor` may change it
 * (admins and the owner any, a member its own). The write is scoped to
 * the template's API key, as the REST update is.
 */
export async function updateTemplateAs(
  id: string,
  actor: TemplateActor,
  input: UpdateTemplateInput,
): Promise<TemplateChangeResult> {
  const found = await templateForChange(id, actor, "update");
  if (!found.ok) return found;
  const template = await updateTemplate(id, found.template.apiKeyId, input);
  if (!template) return { ok: false, reason: "not_found" };
  return { ok: true, template };
}

/**
 * Dashboard delete (#219): deletes a template if `actor` may change it
 * (admins and the owner any, a member its own).
 */
export async function deleteTemplateAs(
  id: string,
  actor: TemplateActor,
): Promise<TemplateChangeResult> {
  const found = await templateForChange(id, actor, "delete");
  if (!found.ok) return found;
  const template = await deleteTemplate(id, found.template.apiKeyId);
  if (!template) return { ok: false, reason: "not_found" };
  return { ok: true, template };
}
