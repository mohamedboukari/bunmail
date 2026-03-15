import type { templates } from "../models/template.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

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

/** Input for updating a template — all fields optional (partial update). */
export interface UpdateTemplateInput {
  name?: string;
  subject?: string;
  html?: string;
  text?: string;
  variables?: string[];
}
