import { randomBytes } from "crypto";

type IdPrefix = "msg" | "key" | "dom" | "whk" | "tpl" | "inb" | "sup";

/**
 * Generates a prefixed unique ID.
 * Format: `<prefix>_<24 hex chars>` (12 random bytes = 24 hex = ~96 bits of entropy)
 *
 * Examples: msg_a1b2c3d4e5f6a1b2c3d4e5f6, key_..., dom_...
 */
export function generateId(prefix: IdPrefix): string {
  const random = randomBytes(12).toString("hex");
  return `${prefix}_${random}`;
}
