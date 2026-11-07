import { t } from "elysia";
import { DKIM_SELECTOR_PATTERN } from "../services/dkim-keys.ts";

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

/**
 * Open or click tracking opt-in (#187), shared with the update DTO. Off by
 * default. Tracking also needs `TRACKING_ENABLED`, one recipient and an
 * https `APP_BASE_URL`; a send can always opt out.
 */
export const trackingFlagSchema = t.Boolean({
  description:
    "Open or click tracking opt-in for mail from this domain (default false). Also needs TRACKING_ENABLED=true; each send can opt out, and transactional mail is tracked only when the send asks. Nothing is tracked yet in this version: the setting is only stored.",
});

export const createDomainDto = t.Object({
  /**
   * The domain name to register (e.g. "example.com"). Only its length is
   * checked here: the service normalises it (trim, lowercase, one final
   * dot dropped, a Unicode IDN to its A-label) and refuses anything that
   * is not then a host name with `422 INVALID_DOMAIN_NAME` (#406).
   */
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

  /**
   * DKIM selector of the domain's key (#250): one lowercase DNS label, 1 to
   * 63 characters (letters, digits, inner hyphens). Omit for `bunmail`.
   * Anything else is a 422.
   */
  dkimSelector: t.Optional(
    t.String({ pattern: DKIM_SELECTOR_PATTERN, minLength: 1, maxLength: 63 }),
  ),

  /** Open and click tracking opt-in (#187); omitted means off. */
  trackOpens: t.Optional(trackingFlagSchema),
  trackClicks: t.Optional(trackingFlagSchema),
});
