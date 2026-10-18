/**
 * Owner recovery script (#215): prints a fresh owner setup link.
 *
 * Run with: bun run src/db/reset-owner.ts
 * In Docker: docker compose exec app bun run src/db/reset-owner.ts
 *
 * Use it when the setup link logged on first boot was lost or expired, or
 * as a password reset for the owner. It revokes every open token of the
 * owner, signs the owner out of every dashboard session (#216: a kill
 * switch when a compromise is suspected), and mints a new single-use link
 * valid for 24 hours; the stored email and the current password stay until
 * the new link is completed, so an abandoned reset cannot lock the owner
 * out (until then the old password can still sign in; completing the link
 * signs every session out again). With no owner yet, it creates one from
 * `BUNMAIL_OWNER_EMAIL`, as the boot does.
 *
 * Shell access is the trust boundary: there is no HTTP surface, and the
 * link goes to the operator's terminal (`docker compose exec` output), not
 * the container log stream. It is written straight to stdout, not through
 * the logger, so `LOG_LEVEL` can never hide it: the script revokes every
 * earlier link, so a filtered-out new link would leave none at all.
 */
import { config } from "../config.ts";
import { issueOwnerSetupLink } from "../modules/users/services/owner.service.ts";
import { buildSetupUrl } from "../modules/users/services/owner-setup-policy.service.ts";
import { logger } from "../utils/logger.ts";
import { redactEmail } from "../utils/redact.ts";

async function resetOwner(): Promise<void> {
  const configured = config.dashboard.ownerEmail;
  const link = await issueOwnerSetupLink(configured);

  /** The stored owner email wins; a differing env value never moves ownership. */
  if (configured !== null && configured !== link.email) {
    logger.warn(
      "BUNMAIL_OWNER_EMAIL differs from the stored owner; ignored. Ownership moves only by transfer.",
      { configured: redactEmail(configured), stored: redactEmail(link.email) },
    );
  }

  const { url, usedFallback } = buildSetupUrl(
    config.appBaseUrl,
    config.server.port,
    link.token,
  );
  const lines = [
    "The owner's dashboard sessions were signed out.",
    `Owner setup link for ${redactEmail(link.email)} (single use, expires ${link.expiresAt.toISOString()}; earlier links no longer work):`,
    url,
    ...(usedFallback
      ? [
          "Hint: APP_BASE_URL is not set to an http(s) URL: the link uses localhost, set it to this server's public URL",
        ]
      : []),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);

  /** The SQL pool keeps the process alive; exit explicitly, like seed.ts. */
  process.exit(0);
}

resetOwner().catch((error: unknown) => {
  logger.error("Owner reset failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
