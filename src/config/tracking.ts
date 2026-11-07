import { optionalBoundedInt, optionalStrictBoolean } from "./env.ts";

/**
 * Open and click tracking (#187). Off by default: tracking is personal
 * data, so the operator turns it on knowingly. Three gates must all be
 * open before a send is tracked: this kill switch, the sender domain's
 * opt-in (set by an admin), and the send not opting out.
 */

/**
 * Reads `TRACKING_ENABLED` (#187), the global kill switch. Default
 * `false`: nothing is tracked, whatever the domains and sends ask for.
 * Only `true` or `false`; anything else refuses to boot, so a typo cannot
 * turn tracking on (or leave it on) silently.
 */
export function readTrackingEnabled(
  raw: string | undefined = process.env["TRACKING_ENABLED"],
): boolean {
  return optionalStrictBoolean("TRACKING_ENABLED", false, raw);
}

/** Default and bounds of `EMAIL_EVENTS_RETENTION_DAYS` (#187), in days. */
export const DEFAULT_EMAIL_EVENTS_RETENTION_DAYS = 90;
export const MIN_EMAIL_EVENTS_RETENTION_DAYS = 1;
export const MAX_EMAIL_EVENTS_RETENTION_DAYS = 3650;

/**
 * Reads `EMAIL_EVENTS_RETENTION_DAYS` (#187), how long an open or click
 * event is kept before the purge cycle deletes it. Events also go with
 * their email (trash purge, permanent delete), whichever comes first.
 * Unset or blank: 90. Anything other than a whole number of days from 1
 * to 3650 refuses to boot: a typo must never keep personal data longer,
 * or drop it sooner, than the operator chose.
 */
export function readEmailEventsRetentionDays(
  raw: string | undefined = process.env["EMAIL_EVENTS_RETENTION_DAYS"],
): number {
  return optionalBoundedInt(
    "EMAIL_EVENTS_RETENTION_DAYS",
    DEFAULT_EMAIL_EVENTS_RETENTION_DAYS,
    MIN_EMAIL_EVENTS_RETENTION_DAYS,
    MAX_EMAIL_EVENTS_RETENTION_DAYS,
    raw,
  );
}

/** The `config.tracking` section (#187). */
interface TrackingConfig {
  readonly enabled: boolean;
  readonly eventsRetentionDays: number;
}

/** Open and click tracking (#187). */
export function buildTrackingConfig(): TrackingConfig {
  return {
    /**
     * The kill switch (`TRACKING_ENABLED`, default false). Off: no send is
     * marked as tracked. Checked again at send time once tracking is
     * injected, so turning it off takes effect at once.
     */
    enabled: readTrackingEnabled(),

    /**
     * Days an open or click event is kept (`EMAIL_EVENTS_RETENTION_DAYS`,
     * default 90, a whole number from 1 to 3650).
     */
    eventsRetentionDays: readEmailEventsRetentionDays(),
  };
}
