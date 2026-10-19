import type { domains } from "../models/domain.schema.ts";
import type { InferSelectModel } from "drizzle-orm";

/**
 * The shape of a domain row returned from the database.
 * Inferred directly from the Drizzle schema to stay in sync automatically.
 */
export type Domain = InferSelectModel<typeof domains>;

/**
 * Input required to create a new domain.
 *
 * `name` is the only required field: DKIM keys are generated server-side.
 * The unsubscribe fields override the defaults BunMail emits on outbound
 * `List-Unsubscribe` headers; both are optional.
 */
export interface CreateDomainInput {
  /** The domain name (e.g. "example.com") */
  name: string;
  /** Mailbox for `List-Unsubscribe: <mailto:...>`. Defaults to `unsubscribe@<name>`. */
  unsubscribeEmail?: string;
  /** RFC 8058 one-click HTTPS unsubscribe endpoint. Optional. */
  unsubscribeUrl?: string;
  /** Address notified when inbound mail arrives for this domain (#106). Optional. */
  notifyEmail?: string;
  /**
   * Who added the domain (#219): the dashboard user, or the calling key's
   * user over REST. Attribution only; null (the default) means the owner.
   */
  createdByUserId?: string | null;
}

/** A DMARC policy (`p=` and `sp=`, RFC 7489 6.3). */
export type DmarcPolicy = "none" | "quarantine" | "reject";

/** A DMARC alignment mode (`adkim=` and `aspf=`): relaxed or strict. */
export type DmarcAlignment = "r" | "s";

/** The tags of one DMARC record, parsed strictly (#250). */
export interface ParsedDmarcRecord {
  /** `p=`, or null when it is missing or invalid. */
  policy: DmarcPolicy | null;
  /** `sp=`, or null when absent or invalid. */
  subdomainPolicy: DmarcPolicy | null;
  /** `pct=`, 0 to 100 (default 100). */
  pct: number;
  /** `adkim=` (default `r`). */
  adkim: DmarcAlignment;
  /** `aspf=` (default `r`). */
  aspf: DmarcAlignment;
  /** The `mailto:` URIs of `rua=`. */
  rua: string[];
  /** Invalid values, reported and otherwise ignored (the default applies). */
  problems: string[];
}

/**
 * The DMARC check of a domain (#250): exactly one `v=DMARC1` record at
 * `_dmarc.<domain>`, or, when there is none, at the organizational domain
 * (`inherited`), with a valid `p=`.
 */
export interface DmarcCheck {
  /**
   * `pass`: one record with a valid `p=`. `missing`: no record. `multiple`:
   * more than one record (RFC 7489 6.6.3, receivers then apply none).
   * `invalid`: one record without a valid `p=`. `error`: the lookup failed.
   */
  status: "pass" | "missing" | "multiple" | "invalid" | "error";
  /** True only for `pass`. */
  ok: boolean;
  /** One line for the operator. */
  reason: string;
  /** Passing but weak settings (`p=none`, `pct` below 100, no `rua`). */
  warnings: string[];
  /** Invalid tag values in the record, ignored as RFC 7489 says. */
  problems: string[];
  /** The domain whose `_dmarc` record applies, or null when none does. */
  recordDomain: string | null;
  /** True when the record is the organizational domain's. */
  inherited: boolean;
  policy: DmarcPolicy | null;
  subdomainPolicy: DmarcPolicy | null;
  /** The policy receivers apply to this domain: `sp` when inherited and set, else `p`. */
  effectivePolicy: DmarcPolicy | null;
  pct: number | null;
  adkim: DmarcAlignment | null;
  aspf: DmarcAlignment | null;
  rua: string[];
}

/** One DNS record an operator publishes for a domain (#250). */
export interface RequiredDnsRecord {
  type: "TXT" | "A" | "AAAA" | "PTR" | "MX";
  /** Fully qualified name the record goes on (an IP address for PTR). */
  host: string;
  /** Record value as entered at a DNS provider. */
  value: string;
  /** What the record is for, in a few words. */
  purpose: string;
  /** True when sending works without it. */
  optional: boolean;
  /** How to apply it, when it is not obvious. */
  note?: string;
}
