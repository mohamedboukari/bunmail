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
 *   gets a token) and `APP_BASE_URL` is still an `https://` URL.
 *
 * Tokens are deterministic, so every retry gets the same URLs and the
 * same body.
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
 * tracked. `unsubscribeUrl` is the sender domain's static one-click URL:
 * links to it are never rewritten, nor is any link to BunMail's own host
 * (`/u/`, `/t/`, the dashboard, in any encoding).
 */
export function trackingForEmail(
  email: TrackedEmail,
  unsubscribeUrl: string | null,
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
  const ownUnsubscribe = unsubscribeUrl === null ? null : canonical(unsubscribeUrl);

  const links = email.trackClicks
    ? {
        ownHost,
        unsubscribeUrl: ownUnsubscribe,
        trackingUrl: (url: string, position: number): string | null => {
          const token = mintClickToken(
            { emailId: email.id, position, url },
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
