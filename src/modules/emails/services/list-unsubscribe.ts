import { config } from "../../../config.ts";
import {
  mintUnsubscribeToken,
  soleRecipient,
  unsubscribeLocalPart,
} from "../../suppressions/services/unsubscribe-token.ts";
import type { UnsubscribeOptions } from "./mailer.service.ts";

/**
 * What goes into an outgoing email's `List-Unsubscribe` header (#249).
 *
 * Per-recipient, when it can name exactly one person: the email has a
 * single `to` address and no cc or bcc (they all share one header, so a
 * token there would let a cc recipient unsubscribe the `to` address), and
 * `APP_BASE_URL` is an `https://` URL (RFC 8058 one-click needs HTTPS).
 * Then the header carries:
 *
 * - `<APP_BASE_URL/u/<token>>` with `List-Unsubscribe-Post: One-Click`.
 *   It replaces the domain's static `unsubscribeUrl`: a static URL cannot
 *   tell who clicked, because the one-click POST body is only
 *   `List-Unsubscribe=One-Click`.
 * - `<mailto:unsub+<token>@<sender domain>>` when the inbound SMTP
 *   receiver is on (`SMTP_ENABLED`), which turns such a message into a
 *   suppression; otherwise the domain's static `unsubscribeEmail` if set,
 *   else no mailto at all (nothing would read it).
 *
 * In every other case the static behaviour is kept: the domain's
 * `unsubscribeEmail` / `unsubscribeUrl`, and the mailer's default
 * `unsubscribe@<sender domain>` mailto.
 *
 * The token is deterministic, so every retry of an email carries the same
 * header.
 */

/** The parts of an email row the header is built from. */
export interface ListUnsubscribeEmail {
  id: string;
  fromAddress: string;
  toAddress: string;
  cc: string | null;
  bcc: string | null;
}

/** The domain's static unsubscribe settings, if the sender domain is registered. */
export interface ListUnsubscribeDomain {
  unsubscribeEmail: string | null;
  unsubscribeUrl: string | null;
}

/** Instance settings; from `config` unless a test passes its own. */
export interface ListUnsubscribeSettings {
  /** `APP_BASE_URL`, without a trailing slash. */
  appBaseUrl: string;
  /** Whether the inbound SMTP receiver runs (`SMTP_ENABLED`). */
  inboundSmtp: boolean;
  /** Token key override, for tests. */
  tokenKey?: Buffer;
}

function configuredSettings(): ListUnsubscribeSettings {
  return { appBaseUrl: config.appBaseUrl, inboundSmtp: config.smtp.enabled };
}

/**
 * `APP_BASE_URL` when it can carry a one-click link: an `https://` URL
 * with no query or fragment. `null` otherwise.
 */
export function oneClickBaseUrl(appBaseUrl: string): string | null {
  const base = appBaseUrl.trim().replace(/\/+$/, "");
  if (!URL.canParse(base)) return null;
  const url = new URL(base);
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") return null;
  return base;
}

/** The static options from the domain record, as before #249. */
function staticOptions(
  domain: ListUnsubscribeDomain | undefined,
): UnsubscribeOptions | undefined {
  if (!domain?.unsubscribeEmail && !domain?.unsubscribeUrl) return undefined;
  return {
    mailto: domain.unsubscribeEmail ?? undefined,
    url: domain.unsubscribeUrl ?? undefined,
  };
}

/**
 * The unsubscribe options for one email (see the file comment). Pure apart
 * from reading `config` when no settings are passed.
 */
export function listUnsubscribeOptions(
  email: ListUnsubscribeEmail,
  domain: ListUnsubscribeDomain | undefined,
  settings: ListUnsubscribeSettings = configuredSettings(),
): UnsubscribeOptions | undefined {
  const base = oneClickBaseUrl(settings.appBaseUrl);
  const recipient = soleRecipient(email.toAddress, email.cc, email.bcc);
  const senderDomain = email.fromAddress.split("@")[1]?.trim().toLowerCase();
  if (base === null || recipient === null || !senderDomain) return staticOptions(domain);

  const token = mintUnsubscribeToken({ emailId: email.id, recipient }, settings.tokenKey);
  if (token === null) return staticOptions(domain);

  return {
    url: `${base}/u/${token}`,
    mailto: settings.inboundSmtp
      ? `${unsubscribeLocalPart(token)}@${senderDomain}`
      : (domain?.unsubscribeEmail ?? null),
  };
}
