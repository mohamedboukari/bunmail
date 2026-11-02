import { isIP } from "net";
import { readAppEnv, type AppEnv } from "./app.ts";
import { ownerEmailProblem } from "./auth.ts";
import {
  optionalBoundedInt,
  optionalEnv,
  optionalPositiveInt,
  optionalStrictBoolean,
} from "./env.ts";

/**
 * Reads `MAIL_PUBLIC_IP` (#247, #248): the public IPv4/IPv6 addresses this
 * server sends mail from, comma-separated. Optional: unset, BunMail uses
 * the A/AAAA records of `MAIL_HOSTNAME`. Set it when they differ (NAT, a
 * separate egress IP). Any entry that is not an IP address refuses to
 * boot. Exported for tests.
 */
export function readPublicIps(
  raw: string | undefined = process.env["MAIL_PUBLIC_IP"],
): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (isIP(entry) === 0) {
      throw new Error(
        `[config] MAIL_PUBLIC_IP must be IP addresses separated by commas, got "${entry}"`,
      );
    }
  }
  return [...new Set(entries)];
}

/** Address families outbound SMTP may prefer (`MAIL_IP_FAMILY`, #250). */
export type IpFamily = 4 | 6;

/**
 * Reads `MAIL_IP_FAMILY` (#250): the address family outbound SMTP prefers.
 * `4` (the default): an MX host's IPv4 addresses when it has any, its IPv6
 * ones only when it has none. `6`: the mirror. Unset or blank gives `4`;
 * anything else refuses to boot. Exported for tests.
 */
export function readIpFamily(
  raw: string | undefined = process.env["MAIL_IP_FAMILY"],
): IpFamily {
  const trimmed = raw?.trim() ?? "";
  if (trimmed === "" || trimmed === "4") return 4;
  if (trimmed === "6") return 6;
  throw new Error(`[config] MAIL_IP_FAMILY must be "4" or "6", got "${raw}"`);
}

/** Bounds of `MAIL_MX_RATE_PER_MIN` (#250), in messages per minute. */
export const MIN_MX_RATE_PER_MIN = 1;
export const MAX_MX_RATE_PER_MIN = 100_000;

/**
 * Reads `MAIL_MX_RATE_PER_MIN` (#250): the most messages per minute sent
 * to one provider bucket (see `provider-bucket.ts`), per replica. Unset or
 * blank: `null`, no budget. Anything other than a whole number from 1 to
 * 100000 refuses to boot. Exported for tests.
 */
export function readMxRatePerMin(
  raw: string | undefined = process.env["MAIL_MX_RATE_PER_MIN"],
): number | null {
  if ((raw?.trim() ?? "") === "") return null;
  return optionalBoundedInt(
    "MAIL_MX_RATE_PER_MIN",
    MIN_MX_RATE_PER_MIN,
    MIN_MX_RATE_PER_MIN,
    MAX_MX_RATE_PER_MIN,
    raw,
  );
}

/**
 * Suffixes that can never be a real sending host: RFC 2606 / 6761
 * reserved names and the placeholders used in `.env.example` and the docs.
 */
const PLACEHOLDER_HOST_SUFFIXES = [
  "example.com",
  "example.net",
  "example.org",
  "yourdomain.com",
  "example",
  "test",
  "invalid",
  "localhost",
  "local",
];

/**
 * Why `hostname` can't be used as the SMTP EHLO name and Message-ID domain,
 * or `null` if it can. Receivers expect a fully qualified name whose A
 * record and the sending IP's PTR match; `localhost`, an IP literal or a
 * placeholder is a strong spam signal. Pure, for tests.
 */
export function mailHostnameProblem(hostname: string): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "") return "it is not set";
  if (host === "localhost") return "it is localhost";
  if (isIP(host) !== 0) return "it is an IP address";
  if (!host.includes(".")) return "it is not a fully qualified domain name";
  if (
    host.length > 253 ||
    !host.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))
  ) {
    return "it is not a valid hostname";
  }
  if (PLACEHOLDER_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) {
    return "it is a placeholder or reserved name";
  }
  return null;
}

/**
 * Reads `MAIL_HOSTNAME`, the EHLO name and Message-ID domain of outbound
 * mail. Production refuses to start with a value receivers would distrust
 * (#242); development keeps the `localhost` default.
 */
export function readMailHostname(
  env: AppEnv,
  raw: string = optionalEnv("MAIL_HOSTNAME", ""),
): string {
  const problem = mailHostnameProblem(raw);
  if (env === "production" && problem) {
    throw new Error(
      `[config] MAIL_HOSTNAME is not usable in production: ${problem} ("${raw}").\n` +
        "  → Set it to this server's fully qualified hostname (e.g. mail.yourcompany.com),\n" +
        "    whose A record points at the server and which the sending IP's PTR\n" +
        "    (reverse DNS) resolves to. It is used as the SMTP EHLO name and the\n" +
        "    Message-ID domain; `localhost` or a placeholder lands mail in spam.",
    );
  }
  return raw.trim() === "" ? "localhost" : raw.trim();
}

/**
 * Reads `SUPPRESSIONS_SHARED_HARD` (#250): whether the send gate also
 * refuses an address that ANY API key holds a permanent hard-bounce or
 * complaint suppression for. Unset or blank: `false`. Only `true` or
 * `false`; anything else refuses to boot.
 */
export function readSuppressionsSharedHard(
  raw: string | undefined = process.env["SUPPRESSIONS_SHARED_HARD"],
): boolean {
  return optionalStrictBoolean("SUPPRESSIONS_SHARED_HARD", false, raw);
}

/**
 * Reads `SENDING_IP_DNSBL_CHECK` (#250): whether the daily DNSBL
 * self-check of the sending IPs runs. Unset or blank: `true`. Only `true`
 * or `false`; anything else refuses to boot.
 */
export function readSendingIpDnsblCheck(
  raw: string | undefined = process.env["SENDING_IP_DNSBL_CHECK"],
): boolean {
  return optionalStrictBoolean("SENDING_IP_DNSBL_CHECK", true, raw);
}

/**
 * Reads `SYSTEM_MAIL_FROM`, the address BunMail's own mail (invitations,
 * #217) is sent from. Trimmed and lower-cased; unset or empty means no
 * system sender, and the dashboard shows invitation links for the inviter
 * to share instead. A malformed value (anything but one bare address, or
 * over 254 characters) refuses to boot in every environment. Whether its
 * domain is registered and DKIM-verified is checked at send time, since
 * domains change at runtime.
 */
export function readSystemMailFrom(
  raw: string = optionalEnv("SYSTEM_MAIL_FROM", ""),
): string | null {
  const email = raw.trim().toLowerCase();
  if (email === "") return null;
  /** The same single-address check as `BUNMAIL_OWNER_EMAIL`. */
  const problem = ownerEmailProblem(email);
  if (problem) {
    throw new Error(
      `[config] SYSTEM_MAIL_FROM is not usable: ${problem}.\n` +
        "  → Set it to one bare address on a domain registered and DKIM-verified\n" +
        "    in BunMail (no name or angle brackets), e.g. noreply@yourcompany.com,\n" +
        "    or leave it unset to share invitation links by hand.",
    );
  }
  return email;
}

/** The `config.mail` section: outbound delivery and the send queue. */
export function buildMailConfig() {
  return {
    /** Hostname used in SMTP HELO command and Message-ID header (#242) */
    hostname: readMailHostname(readAppEnv()),

    /** Public sending IPs (`MAIL_PUBLIC_IP`); empty: use the A/AAAA records of `hostname`. */
    publicIps: readPublicIps(),

    /**
     * Max parallel SMTP sessions per provider bucket (#91, #250: every
     * Microsoft, Google, Yahoo or Apple MX counts as one bucket, any other
     * MX as its registrable domain, see `provider-bucket.ts`). Direct-to-MX
     * delivery means strict receivers (Outlook, Yahoo) reject parallel
     * sessions from the same source IP with `421 Too many concurrent
     * SMTP connections`. Default `1` is safe for new self-hosters with
     * cold IP reputation; operators with established reputation can
     * raise it to 2-3. Sends to different buckets are unaffected.
     */
    mxConcurrency: Math.max(1, parseInt(optionalEnv("MAIL_MX_CONCURRENCY", "1"), 10)),

    /**
     * Most messages per minute to one provider bucket (#250), a token
     * bucket per provider bucket and per replica; `null` (unset): no
     * budget. A send over it is deferred, not failed: back to `queued`
     * until a token is free, without counting an attempt.
     */
    mxRatePerMin: readMxRatePerMin(),

    /** Address family outbound SMTP prefers (`MAIL_IP_FAMILY`, #250): 4 or 6. */
    ipFamily: readIpFamily(),

    /**
     * How long a temporarily failing email keeps being retried, in hours
     * (#180). Retries follow an escalating schedule (5 m, 15 m, 30 m, 1 h,
     * 2 h, then every 4 h); once the next retry would land past this age
     * the email fails for good. RFC 5321 suggests 4 to 5 days.
     */
    retryMaxAgeHours: optionalPositiveInt("MAIL_RETRY_MAX_AGE_HOURS", 48),

    /**
     * Send queue throughput and its bound (#176). Each poll (every
     * `QUEUE_POLL_INTERVAL_MS`, +/-10% jitter, never overlapping the
     * previous one) claims up to `QUEUE_BATCH_SIZE` due emails, but never
     * more than the free slots under `QUEUE_MAX_CONCURRENT_SENDS`, the cap
     * on sends in flight in this process. A slow receiver holds one slot
     * instead of making the queue open ever more connections. Sends that
     * wait for a busy provider bucket (`MAIL_MX_CONCURRENCY`) hold their
     * slot while they wait.
     */
    queueBatchSize: optionalBoundedInt("QUEUE_BATCH_SIZE", 5, 1, 100),
    queuePollIntervalMs: optionalBoundedInt("QUEUE_POLL_INTERVAL_MS", 2000, 250, 60_000),
    queueMaxConcurrentSends: optionalBoundedInt("QUEUE_MAX_CONCURRENT_SENDS", 10, 1, 500),

    /**
     * Allow delivery to MX hosts that resolve to private, loopback or
     * link-local addresses. Off by default: recipient domains are chosen
     * by API callers, so a private MX would let any key aim the server's
     * port-25 connections at its internal network. Set to "true" only to
     * deliver to an internal mail server on purpose.
     */
    allowPrivateMx: optionalEnv("MAIL_ALLOW_PRIVATE_MX", "false") === "true",

    /**
     * Refuse sends whose sender domain has no verified DKIM record (#245).
     * A registered domain whose stored DKIM flag is false is re-verified
     * inline once (a failure is remembered for 5 minutes per domain); if
     * it is still unverified the send is rejected with
     * `SENDER_DOMAIN_UNVERIFIED` (SMTP 550), and an unregistered domain
     * is rejected in every environment. Off by default: the send is
     * queued and the response carries `warnings`. SPF and DMARC only warn.
     */
    requireVerifiedDomain: optionalStrictBoolean("REQUIRE_VERIFIED_DOMAIN", false),
  } as const;
}

/** The suppression list's send gate (#250). */
export function buildSuppressionsConfig() {
  return {
    /**
     * Whether the send gate also refuses an address that any API key holds
     * a permanent hard-bounce or complaint suppression for
     * (`SUPPRESSIONS_SHARED_HARD`, default false, strictly `true` or
     * `false`). The sending IP and the DKIM domains are shared, so one
     * key's bad list hurts every key's delivery. Unsubscribe, manual and
     * temporary rows stay per key, and the refusal never names the other
     * key or its row.
     */
    sharedHard: readSuppressionsSharedHard(),
  } as const;
}

/** Daily DNSBL self-check of the sending IPs (#250). */
export function buildSendingIpDnsblConfig() {
  return {
    /**
     * Whether the check runs (`SENDING_IP_DNSBL_CHECK`, default true,
     * strictly `true` or `false`): about a minute after boot, then every
     * 24 hours, against Spamhaus ZEN, Barracuda and SpamCop. Information
     * only: a listing never holds or refuses mail.
     */
    enabled: readSendingIpDnsblCheck(),
  } as const;
}
