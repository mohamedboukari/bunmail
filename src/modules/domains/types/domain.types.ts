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
 * `name` is the only required field — DKIM keys are generated server-side.
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
}
