import { randomBytes } from "crypto";

type IdPrefix =
  | "msg"
  | "key"
  | "dom"
  | "whk"
  | "tpl"
  | "inb"
  | "sup"
  | "dmr" // DMARC report (#41)
  | "dmrec" // DMARC report record (per source IP, #41)
  | "wdl" // webhook delivery (persisted retry queue, #30)
  | "smu" // SMTP submission usage (per key/day counters, #123)
  | "usr" // dashboard user account (#214)
  | "crd" // user credential: password, TOTP, passkey, OAuth link (#214)
  | "ses" // dashboard session (#214)
  | "utk" // one-time token: owner setup, invite, password reset (#214)
  | "udv" // browser an account signed in from (#282)
  | "rcv" // TOTP recovery code (#220)
  | "aud" // audit log event (#221)
  | "idk" // idempotency key on the send API (#188)
  | "drv"; // one run of the domain DNS re-verification loop (#250)

/**
 * Generates a prefixed unique ID.
 * Format: `<prefix>_<24 hex chars>` (12 random bytes = 24 hex = ~96 bits of entropy)
 *
 * Examples: msg_a1b2c3d4e5f6a1b2c3d4e5f6, key_..., dom_...
 */
export function generateId(prefix: IdPrefix): string {
  const random = randomBytes(12).toString("hex");
  return `${prefix}_${random}`;
}
