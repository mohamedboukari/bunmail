import { eq, and } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { templates } from "../models/template.schema.ts";
import { generateId } from "../../../utils/id.ts";
import { logger } from "../../../utils/logger.ts";
import { TemplateTooLargeError } from "../errors.ts";
import type {
  Template,
  CreateTemplateInput,
  UpdateTemplateInput,
} from "../types/template.types.ts";

/** Largest rendered html or text body (same cap as an inline send body). */
export const MAX_RENDERED_BODY_LENGTH = 5 * 1024 * 1024;

/** Largest rendered subject (same cap as an inline send subject). */
export const MAX_RENDERED_SUBJECT_LENGTH = 500;

/**
 * Simple Mustache-style variable substitution.
 * Replaces `{{variableName}}` with the corresponding value.
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
): string {
  let length = templateStr.length;
  const rendered = templateStr.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = Object.hasOwn(variables, key) ? variables[key] : undefined;
    if (value === undefined) return match;
    length += value.length - match.length;
    if (length > maxLength) throw new TemplateTooLargeError(maxLength);
    return value;
  });
  if (rendered.length > maxLength) throw new TemplateTooLargeError(maxLength);
  return rendered;
}

/**
 * Creates a new email template scoped to the requesting API key.
 *
 * @param input - Template name, subject, and optional html/text bodies
 * @param apiKeyId - Owner API key
 * @returns The newly created template row
 */
export async function createTemplate(
  input: CreateTemplateInput,
  apiKeyId: string,
): Promise<Template> {
  const id = generateId("tpl");

  logger.info("Creating template", { id, name: input.name, apiKeyId });

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
