import { t } from "elysia";

/**
 * Validation schema for POST /api/v1/domains request body.
 * Only requires the domain name — DKIM key generation is handled later.
 */
export const createDomainDto = t.Object({
  /** The domain name to register (e.g. "example.com") */
  name: t.String({ minLength: 1, maxLength: 255 }),
});
