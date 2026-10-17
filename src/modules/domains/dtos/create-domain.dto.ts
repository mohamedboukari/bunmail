import { t } from "elysia";

/**
 * Validation schema for POST /api/v1/domains request body.
 *
 * Only `name` is required: DKIM key generation is handled later.
 *
 * Optional `unsubscribeEmail` / `unsubscribeUrl` override the defaults
 * BunMail emits in the outbound `List-Unsubscribe` header. Set them
 * when the default `unsubscribe@<domain>` mailbox isn't a real address
 * you can read, or when you want RFC 8058 one-click unsubscribe (which
 * Gmail's bulk-sender rules require).
 */
/**
 * `unsubscribeUrl` must be HTTPS: RFC 8058 one-click unsubscribe requires
 * it, and receivers ignore other schemes. Shared with the update DTO.
 */
export const unsubscribeUrlSchema = t.String({
  format: "uri",
  pattern: "^https://",
  minLength: 8,
  maxLength: 2048,
});

/** Mailbox for `List-Unsubscribe: <mailto:...>`; 254 is RFC 5321's cap. */
export const unsubscribeEmailSchema = t.String({
  format: "email",
  minLength: 3,
  maxLength: 254,
});

export const createDomainDto = t.Object({
  /** The domain name to register (e.g. "example.com") */
  name: t.String({ minLength: 1, maxLength: 255 }),

  /**
   * Mailbox that receives `List-Unsubscribe: <mailto:...>` requests.
   * Omit to fall back to `unsubscribe@<domain>`. RFC 5321 caps the
   * full address at 254 characters.
   */
  unsubscribeEmail: t.Optional(unsubscribeEmailSchema),

  /**
   * One-click HTTPS unsubscribe endpoint per RFC 8058. When set the
   * mailer also emits `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
   * Leave unset for transactional mail.
   */
  unsubscribeUrl: t.Optional(unsubscribeUrlSchema),

  /**
   * Address notified when inbound mail is received for this domain (#106).
   * Optional at create-time; can also be set/cleared later from the
   * dashboard. Point this at an external mailbox.
   */
  notifyEmail: t.Optional(t.String({ format: "email", minLength: 3, maxLength: 255 })),
});
