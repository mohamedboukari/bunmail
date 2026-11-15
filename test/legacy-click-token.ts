import { createHmac } from "crypto";
import type { TrackingKeys } from "../src/modules/tracking/services/tracking-token.ts";

/**
 * A v1 click token (#187), as BunMail minted them before #424:
 * `<email id hex>.<position>.<base64url(url)>.<MAC>`, the MAC over
 * `click:v1:<email id>:<position>:<url>`. BunMail no longer mints them,
 * so tests build them by hand here, independently of the production
 * code, to prove links already sent keep verifying.
 */
export function legacyClickToken(
  subject: { emailId: string; position: number; url: string },
  keys: TrackingKeys,
): string {
  const mac = createHmac("sha256", keys.click)
    .update(
      ["click:v1", subject.emailId, String(subject.position), subject.url].join(":"),
    )
    .digest()
    .subarray(0, 16)
    .toString("hex");
  const encoded = Buffer.from(subject.url, "utf8").toString("base64url");
  return `${subject.emailId.slice("msg_".length)}.${subject.position}.${encoded}.${mac}`;
}
