/**
 * Normalises a form field that can come back either as a single string
 * (one checkbox checked) or an array (many checkboxes). Repeated form
 * fields like `ids=a&ids=b` produce different shapes depending on the
 * runtime parser, so we always coerce to `string[]`.
 */
export function toIdArray(input: string | string[]): string[] {
  return Array.isArray(input) ? input : [input];
}
