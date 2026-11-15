import { isIP } from "net";
import { parseIpv6 } from "../utils/ssrf-guard.ts";
import { parseDomainName } from "../modules/domains/services/domain-name.ts";
import { readAppEnv, type AppEnv } from "./app.ts";
import { ownerEmailProblem } from "./auth.ts";
import {
  optionalBoundedInt,
  optionalEnv,
  optionalPositiveInt,
  optionalStrictBoolean,
  runningBunVersion,
  runtimeHasSocketFeatures,
  socketFeatureError,
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

/**
 * The local addresses outbound SMTP binds its connections to
 * (`MAIL_SOURCE_IP`, #414): at most one per family, `null` for the
 * system's choice.
 */
export interface SourceIps {
  v4: string | null;
  v6: string | null;
}

/** An IPv4 address as its four octets (the caller checked `isIP`). */
function ipv4Octets(ip: string): number[] {
  return ip.split(".").map(Number);
}

/**
 * Why `ip` cannot be an outbound source address (`MAIL_SOURCE_IP`, #414),
 * or `null` if it can. Refused: the unspecified address, loopback,
 * link-local (and any address with a zone id, which only link-local scopes
 * need), multicast, the IPv4 broadcast and reserved range, and IPv6
 * addresses that carry an IPv4 one (IPv4-mapped `::ffff:a.b.c.d`,
 * IPv4-compatible `::a.b.c.d`): a socket of the other family can never
 * bind them. Private ranges stay allowed (1:1 NAT). Pure, for tests.
 */
export function sourceIpProblem(ip: string): string | null {
  const family = isIP(ip);
  if (family === 0) return "not an IP address";
  if (ip.includes("%")) return "scoped to an interface (a zone id: link-local only)";
  if (family === 4) {
    const [a = 0, b = 0] = ipv4Octets(ip);
    if (a === 0) return 'the unspecified or "this host" range (0.0.0.0/8)';
    if (a === 127) return "loopback";
    if (a === 169 && b === 254) return "link-local";
    if (a >= 224 && a <= 239) return "multicast";
    if (a >= 240) return "the broadcast or reserved range (240.0.0.0/4)";
    return null;
  }
  const groups = parseIpv6(ip);
  if (groups === null) return "not an IP address";
  const g = (i: number): number => groups[i] ?? 0;
  const zeroUpTo = (end: number): boolean => groups.slice(0, end).every((x) => x === 0);
  if (groups.every((x) => x === 0)) return "the unspecified address";
  if (zeroUpTo(7) && g(7) === 1) return "loopback";
  if ((g(0) & 0xffc0) === 0xfe80) return "link-local";
  if ((g(0) & 0xff00) === 0xff00) return "multicast";
  if (zeroUpTo(5) && g(5) === 0xffff)
    return "an IPv4-mapped address (use the IPv4 address)";
  if (zeroUpTo(6)) return "an IPv4-compatible address (deprecated; use the IPv4 address)";
  return null;
}

/** Two IP addresses are the same address (IPv6 compared by value, not text). */
function sameIp(a: string, b: string): boolean {
  if (isIP(a) !== isIP(b)) return false;
  if (isIP(a) === 4) return a === b;
  const x = parseIpv6(a);
  const y = parseIpv6(b);
  return x !== null && y !== null && x.every((group, i) => group === y[i]);
}

/** One boot warning about `MAIL_SOURCE_IP` (#414): its message and fields. */
export interface SourceIpWarning {
  message: string;
  fields: Record<string, unknown>;
}

/**
 * Boot warnings about `MAIL_SOURCE_IP` (#414), never fatal (the address can
 * appear later, a NAT can map it):
 *
 * - an entry that is on none of this host's interfaces (`localAddresses`,
 *   from `os.networkInterfaces()`): every connection would fail with
 *   `EADDRNOTAVAIL` (in Docker, the container needs host networking or a
 *   macvlan network to have the address);
 * - with `MAIL_PUBLIC_IP` set, an entry not among its addresses of that
 *   family: SPF guidance and the reverse DNS check describe another
 *   address than the one mail leaves from (expected behind a 1:1 NAT).
 *
 * Pure: the caller passes the interface addresses. Exported for tests.
 */
export function sourceIpWarnings(
  sourceIps: SourceIps,
  publicIps: readonly string[],
  localAddresses: readonly string[],
): SourceIpWarning[] {
  const warnings: SourceIpWarning[] = [];
  for (const ip of [sourceIps.v4, sourceIps.v6]) {
    if (ip === null) continue;
    if (!localAddresses.some((local) => sameIp(local.split("%")[0] ?? "", ip))) {
      warnings.push({
        message: "MAIL_SOURCE_IP is not an address of this host: outbound SMTP will fail",
        fields: {
          sourceIp: ip,
          hint: "assign it to an interface (in Docker: network_mode: host or a macvlan network), or unset MAIL_SOURCE_IP",
        },
      });
    }
    const family = isIP(ip);
    const sameFamily = publicIps.filter((pub) => isIP(pub) === family);
    if (sameFamily.length > 0 && !sameFamily.some((pub) => sameIp(pub, ip))) {
      warnings.push({
        message: "MAIL_SOURCE_IP differs from MAIL_PUBLIC_IP",
        fields: {
          sourceIp: ip,
          publicIps: sameFamily,
          hint: "fine behind a 1:1 NAT that maps it to MAIL_PUBLIC_IP; otherwise set MAIL_PUBLIC_IP to the address mail leaves from, so SPF and reverse DNS checks match",
        },
      });
    }
  }
  return warnings;
}

/**
 * Reads `MAIL_SOURCE_IP` (#414): the local address outbound SMTP connects
 * from, for a host with several addresses whose mail must leave from one
 * (the one its PTR, SPF and reputation belong to). One IPv4 address, one
 * IPv6 address, or one of each separated by a comma. A connection to an
 * IPv4 MX binds the IPv4 entry, one to an IPv6 MX the IPv6 entry; a family
 * without an entry keeps the system's choice.
 *
 * - Unset or blank: no binding, the system picks (the default).
 * - Anything that is not an IP address, an address no mail can leave from
 *   (see {@link sourceIpProblem}), or two entries of one family refuses to
 *   boot. Private addresses are allowed: behind a 1:1 NAT (a cloud VM's
 *   secondary address with its own public IP) they are the right choice.
 * - Set under a Bun older than 1.4.4 refuses to boot: that Bun ignores
 *   `localAddress`, so mail would silently leave from another address.
 *   `bunVersion` is the running Bun (`null` under Node), for tests.
 *
 * The address must be assigned to this host (a container needs host
 * networking or a macvlan for that), or every connection fails with
 * `EADDRNOTAVAIL`, which is retried like any connection failure.
 * Exported for tests.
 */
export function readSourceIps(
  raw: string | undefined = process.env["MAIL_SOURCE_IP"],
  bunVersion: string | null = runningBunVersion(),
): SourceIps {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const ips: SourceIps = { v4: null, v6: null };
  for (const entry of entries) {
    const family = isIP(entry);
    if (family === 0) {
      throw new Error(
        `[config] MAIL_SOURCE_IP must be one IPv4 and/or one IPv6 address, separated by a comma, got "${entry}"`,
      );
    }
    const problem = sourceIpProblem(entry);
    if (problem !== null) {
      throw new Error(
        `[config] MAIL_SOURCE_IP must be a unicast address mail can leave from, but "${entry}" is ${problem}`,
      );
    }
    const slot = family === 4 ? "v4" : "v6";
    if (ips[slot] !== null) {
      throw new Error(
        `[config] MAIL_SOURCE_IP takes at most one IPv${family} address, got "${ips[slot]}" and "${entry}"`,
      );
    }
    ips[slot] = entry;
  }
  if ((ips.v4 !== null || ips.v6 !== null) && bunVersion !== null) {
    if (!runtimeHasSocketFeatures(bunVersion)) {
      throw socketFeatureError(
        "MAIL_SOURCE_IP",
        "this Bun ignores the local address of an outgoing connection, so mail would leave from another address.",
        bunVersion,
      );
    }
  }
  return ips;
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
 * verified complaint suppression for (see `readFeedbackLoopDomains`). Unset or blank: `false`. Only `true` or
 * `false`; anything else refuses to boot.
 */
export function readSuppressionsSharedHard(
  raw: string | undefined = process.env["SUPPRESSIONS_SHARED_HARD"],
): boolean {
  return optionalStrictBoolean("SUPPRESSIONS_SHARED_HARD", false, raw);
}

/**
 * Reads `FEEDBACK_LOOP_DOMAINS`: the DKIM signing domains (`d=`) of the
 * mailbox providers whose feedback-loop reports BunMail trusts,
 * comma-separated. A complaint is shared across API keys by
 * `SUPPRESSIONS_SHARED_HARD` only when its report carries a passing DKIM
 * signature of one of these domains and comes from one of
 * `FEEDBACK_LOOP_SENDERS` (see `readFeedbackLoopSenders` and
 * `feedback-handler.service.ts`).
 *
 * Each entry is normalised like a registered domain name
 * (`parseDomainName`: trimmed, an IDN turned into its A-label, ASCII
 * lower-cased, one final dot dropped) and must be a domain of at least two
 * labels; anything else (a single label, an IP address, a URL, an `@`)
 * refuses to boot. Unset or blank gives an empty list: no report is
 * verified and no complaint is shared. Duplicates are dropped. Exported
 * for tests.
 */
export function readFeedbackLoopDomains(
  raw: string | undefined = process.env["FEEDBACK_LOOP_DOMAINS"],
): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const domains: string[] = [];
  for (const entry of entries) {
    const domain = parseDomainName(entry);
    if (domain === null) {
      throw new Error(
        `[config] FEEDBACK_LOOP_DOMAINS must be domain names separated by commas, got "${entry}"`,
      );
    }
    domains.push(domain);
  }
  return [...new Set(domains)];
}

/**
 * Consumer mailbox domains: providers whose DKIM key signs the ordinary
 * mail of every one of their users. `exact` names match as written;
 * `anySuffix` names match under any one- or two-label suffix (`gmx.net`,
 * `gmx.de`, `yahoo.co.uk`). A short list of the large ones, not a
 * complete one.
 */
const CONSUMER_MAILBOX_DOMAINS: {
  exact: readonly string[];
  anySuffix: readonly string[];
} = {
  exact: [
    "gmail.com",
    "googlemail.com",
    "ymail.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "web.de",
    "mail.ru",
    "protonmail.com",
    "protonmail.ch",
    "proton.me",
    "pm.me",
  ],
  anySuffix: ["gmx", "yandex", "yahoo", "hotmail", "outlook", "live", "aol"],
};

/**
 * Whether `domain` (a normalised domain name, as `parseDomainName` returns
 * it) is a consumer mailbox domain (see {@link CONSUMER_MAILBOX_DOMAINS}):
 * one whose DKIM signature vouches for mail written by any of its users,
 * so a passing signature alone says nothing about who wrote a report.
 * Subdomains count too (`mail.yahoo.com`, `arf.mail.yahoo.com`): which
 * names under a provider's domain its users can send from is not
 * something BunMail can know, so such a domain is treated like the
 * provider's own.
 */
export function isConsumerMailboxDomain(domain: string): boolean {
  const { exact, anySuffix } = CONSUMER_MAILBOX_DOMAINS;
  if (exact.some((name) => domain === name || domain.endsWith(`.${name}`))) return true;
  const labels = domain.split(".");
  /** A listed name followed by a one- or two-label suffix, anywhere in the name. */
  return labels.some((label, index) => {
    const suffixLabels = labels.length - index - 1;
    return anySuffix.includes(label) && suffixLabels >= 1 && suffixLabels <= 2;
  });
}

/**
 * Reads `FEEDBACK_LOOP_SENDERS`: who may send a verified feedback-loop
 * report, comma-separated. An entry is either one exact address
 * (`feedback@fbl.example.net`) or `@` and a domain (`@fbl.example.net`: any
 * address at exactly that domain, no subdomains). A complaint is verified
 * only when its report's `From` (and its envelope sender, when not empty)
 * matches one of them, on top of the DKIM rule of `FEEDBACK_LOOP_DOMAINS`
 * (see `feedback-handler.service.ts`).
 *
 * Matching ignores case: each entry is stored lower-cased, its domain
 * normalised like `FEEDBACK_LOOP_DOMAINS` (`parseDomainName`). Refuses to
 * boot on an entry that is neither a bare address nor `@domain` (a display
 * name, angle brackets, a wildcard), and on `@domain` for a consumer
 * mailbox domain or a subdomain of one ({@link isConsumerMailboxDomain}),
 * which would accept a
 * report from any user of that provider: its exact feedback-loop address
 * must be listed instead. Unset or blank gives an empty list: no report is
 * verified. Duplicates are dropped. Exported for tests.
 */
export function readFeedbackLoopSenders(
  raw: string | undefined = process.env["FEEDBACK_LOOP_SENDERS"],
): string[] {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const senders: string[] = [];
  for (const entry of entries) {
    const at = entry.lastIndexOf("@");
    const domain = at < 0 ? null : parseDomainName(entry.slice(at + 1));
    /**
     * `@domain` (at 0) or one bare address (the same check as
     * `BUNMAIL_OWNER_EMAIL`). A `*` is valid in an address but here can
     * only be meant as a wildcard, which `@domain` already is: refused.
     * The local part must be printable ASCII, so lowercasing it folds
     * nothing but A to Z (the report side compares the same way).
     */
    const local = at < 0 ? "" : entry.slice(0, at);
    const valid =
      domain !== null &&
      (at === 0 ||
        (ownerEmailProblem(entry) === null &&
          !local.includes("*") &&
          /^[\x21-\x7e]+$/.test(local)));
    if (!valid) {
      throw new Error(
        `[config] FEEDBACK_LOOP_SENDERS must be addresses or @domain entries separated by commas, got "${entry}"`,
      );
    }
    if (at === 0 && isConsumerMailboxDomain(domain)) {
      throw new Error(
        `[config] FEEDBACK_LOOP_SENDERS must not list "@${domain}": every user of that mailbox provider sends from it.\n` +
          "  → List the provider's exact feedback-loop address instead (the From of a\n" +
          "    real report), e.g. FEEDBACK_LOOP_SENDERS=feedback@fbl.example.net",
      );
    }
    senders.push(`${local.toLowerCase()}@${domain}`);
  }
  return [...new Set(senders)];
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
     * Local addresses outbound SMTP connects from (`MAIL_SOURCE_IP`,
     * #414), one per family; `null` entries leave the choice to the
     * system (the default). See `readSourceIps`.
     */
    sourceIps: readSourceIps(),

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
     * a permanent hard-bounce or verified complaint suppression for
     * (`SUPPRESSIONS_SHARED_HARD`, default false, strictly `true` or
     * `false`). The sending IP and the DKIM domains are shared, so one
     * key's bad list hurts every key's delivery. Unsubscribe, manual,
     * unverified-complaint and temporary rows stay per key, and the refusal
     * never names the other key or its row.
     */
    sharedHard: readSuppressionsSharedHard(),

    /**
     * DKIM signing domains of trusted feedback-loop senders
     * (`FEEDBACK_LOOP_DOMAINS`, default empty). A complaint counts for the
     * shared gate above only when its report carries a passing DKIM
     * signature whose `d=` is exactly one of these, from a sender listed
     * in `feedbackLoopSenders` below; any other complaint still suppresses
     * under the reporting email's own key.
     */
    feedbackLoopDomains: readFeedbackLoopDomains(),

    /**
     * Who may send a verified feedback-loop report
     * (`FEEDBACK_LOOP_SENDERS`, default empty): exact addresses and
     * `@domain` entries, lower-cased. A complaint is verified only when its
     * report's `From`, and its envelope sender when not empty, match one
     * of these, on top of the DKIM rule above. Empty: nothing is verified,
     * whatever `FEEDBACK_LOOP_DOMAINS` lists.
     */
    feedbackLoopSenders: readFeedbackLoopSenders(),
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
