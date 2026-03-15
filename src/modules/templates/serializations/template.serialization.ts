import type { Template } from "../types/template.types.ts";

/** Shape of a template in API responses. */
export interface SerializedTemplate {
  id: string;
  name: string;
  subject: string;
  html: string | null;
  text: string | null;
  variables: string[];
  createdAt: Date;
  updatedAt: Date;
}

/** Maps a template DB row to the API response shape. */
export function serializeTemplate(template: Template): SerializedTemplate {
  return {
    id: template.id,
    name: template.name,
    subject: template.subject,
    html: template.html,
    text: template.textContent,
    variables: template.variables,
    createdAt: template.createdAt,
    updatedAt: template.updatedAt,
  };
}
