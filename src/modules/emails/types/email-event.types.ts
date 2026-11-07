/**
 * Value sets of the `email_events` table (#187), checked by the database
 * (`email-event.schema.ts`) as well as by the code that writes them.
 */

/** What happened: the open pixel was fetched, or a tracked link was followed. */
export const EMAIL_EVENT_TYPES = ["open", "click"] as const;

/**
 * Who fetched the pixel or link, as far as the request tells (never the
 * raw user agent, which is not stored):
 *   - `image_proxy`: a mail provider's image proxy (Gmail, Yahoo, Apple
 *     Mail Privacy Protection), so the fetch may not be a person reading;
 *   - `unknown`: anything else.
 */
export const EMAIL_EVENT_CLIENT_KINDS = ["image_proxy", "unknown"] as const;
