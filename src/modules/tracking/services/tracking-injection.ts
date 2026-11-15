import { config } from "../../../config.ts";
import { oneClickBaseUrl } from "../../emails/services/list-unsubscribe.ts";
import { soleRecipient } from "../../suppressions/services/unsubscribe-token.ts";
import type { BodyTracking } from "./body-tracking.ts";
import {
  mintClickToken,
  mintOpenToken,
  trackableUrl,
  type TrackingKeys,
} from "./tracking-token.ts";

/**
 * The tracking of one outgoing email (#187), built by the queue on every
 * attempt and applied by `composeMessageBody`. The decision itself was
 * made when the email was created (`emails.track_opens`,
 * `track_clicks`); this only re-checks what can have changed since:
 *
 * - `TRACKING_ENABLED` is still on (the kill switch takes effect at once);
 * - the email still names one recipient (a row written another way never
 *   gets a token) and `APP_BASE_URL` is still an `https://` URL;
 * - clicks only: the sender domain still exists. Click tokens carry its
 *   id and current tracking epoch (#424), so a retry after an admin
 *   revoked the domain's links gets links of the new epoch.
 *
 * Tokens are deterministic, so every retry gets the same URLs and the
 * same body (until the domain's epoch is bumped).
 */

/** The parts of an email row tracking is built from. */
export interface TrackedEmail {
  id: string;
  toAddress: string;
  cc: string | null;
  bcc: string | null;
  trackOpens: boolean;
  trackClicks: boolean;
}

/** The parts of the sender domain's row tracking is built from. */
export interface TrackingDomain {
  id: string;
  /** `domains.tracking_epoch` (#424), signed into every click token. */
  trackingEpoch: number;
  /** The domain's static one-click unsubscribe URL, never rewritten. */
  unsubscribeUrl: string | null;
}

/** Instance settings; from `config` unless a test passes its own. */
export interface TrackingSettings {
  /** `TRACKING_ENABLED`. */
  enabled: boolean;
  /** `APP_BASE_URL`. */
  appBaseUrl: string;
  /** Token keys override, for tests. */
  keys?: TrackingKeys;
}

function configuredSettings(): TrackingSettings {
  return { enabled: config.tracking.enabled, appBaseUrl: config.appBaseUrl };
}

/**
 * The tracking to apply to an email's body, or `undefined` when nothing is
 * tracked. `domain` is the sender domain (`null` when it is gone: links
 * are then left alone, as click tokens name the domain). Links to its
 * static one-click unsubscribe URL are never rewritten, nor is any link
 * to BunMail's own host (`/u/`, `/t/`, the dashboard, in any encoding).
 */
export function trackingForEmail(
  email: TrackedEmail,
  domain: TrackingDomain | null,
  settings: TrackingSettings = configuredSettings(),
): BodyTracking | undefined {
  if (!settings.enabled || (!email.trackOpens && !email.trackClicks)) return undefined;
  const base = oneClickBaseUrl(settings.appBaseUrl);
  const recipient = soleRecipient(email.toAddress, email.cc, email.bcc);
  if (base === null || recipient === null) return undefined;

  const openToken = email.trackOpens ? mintOpenToken(email.id, settings.keys) : null;
  const pixelUrl = openToken === null ? null : `${base}/t/o/${openToken}.gif`;

  /** Links to BunMail's own host are never rewritten, whatever their scheme or path. */
  const ownHost = new URL(base).hostname;
  const unsubscribeUrl = domain?.unsubscribeUrl ?? null;
  const ownUnsubscribe = unsubscribeUrl === null ? null : canonical(unsubscribeUrl);
  const clickDomain =
    domain === null ? null : { domainId: domain.id, epoch: domain.trackingEpoch };

  const links =
    email.trackClicks && clickDomain !== null
      ? {
          ownHost,
          unsubscribeUrl: ownUnsubscribe,
          trackingUrl: (url: string, position: number): string | null => {
            const token = mintClickToken(
              { emailId: email.id, position, url },
              clickDomain,
              settings.keys,
            );
            return token === null ? null : `${base}/t/c/${token}`;
          },
        }
      : null;

  if (pixelUrl === null && links === null) return undefined;
  return { pixelUrl, links };
}

/** A URL in canonical form when it is an `http(s)` URL, else `null`. */
function canonical(url: string): string | null {
  if (!URL.canParse(url.trim())) return null;
  return trackableUrl(new URL(url.trim()).href);
}
