import type { templates } from "../models/template.schema.ts";
import type { InferSelectModel } from "drizzle-orm";
import type { UserRole } from "../../users/types/user.types.ts";

/** Database row shape for the templates table. */
export type Template = InferSelectModel<typeof templates>;

/** Input for creating a new template via the API. */
export interface CreateTemplateInput {
  name: string;
  subject: string;
  html?: string;
  text?: string;
  variables?: string[];
}

/** Input for updating a template: all fields optional (partial update). */
export interface UpdateTemplateInput {
  name?: string;
  subject?: string;
  html?: string;
  text?: string;
  variables?: string[];
}

/**
 * The signed-in dashboard account editing or deleting a template (#219),
 * from the guard's `auth`. A `member` may change only the templates it
 * created; admins and the owner may change any.
 */
export interface TemplateActor {
  /** `users.id`, compared with the template's `created_by_user_id`. */
  id: string;
  /** The account's role, read with the session on every request. */
  role: UserRole;
}

/**
 * Outcome of a dashboard edit or delete (#219): the changed (or deleted)
 * row, or why nothing changed. `forbidden` means the template exists but
 * belongs to someone else and the actor is a member.
 */
export type TemplateChangeResult =
  { ok: true; template: Template } | { ok: false; reason: "not_found" | "forbidden" };
