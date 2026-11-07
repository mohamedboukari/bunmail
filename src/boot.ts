/**
 * Boot steps of `src/index.ts` that run before the HTTP server listens
 * (#387, split from `src/index.ts`): the running version, the DKIM key
 * decryption check, the stored domain name check (#406), the owner
 * bootstrap and the warnings about settings that do nothing.
 * `src/index.ts` calls them in order.
 */
import { config, daneResolverIsLocal } from "./config.ts";
import { logger } from "./utils/logger.ts";
import { findUndecryptableDomainKeys } from "./db/encrypt-domain-keys.ts";
import { bootstrapOwner } from "./modules/users/services/owner.service.ts";
import { buildSetupUrl } from "./modules/users/services/owner-setup-policy.service.ts";
import { redactEmail } from "./utils/redact.ts";
import { findNonCanonicalDomainNames } from "./modules/domains/services/domain.service.ts";

/**
 * The running version, from package.json. On the startup line and in the
 * OpenAPI document, so a postmortem can tell which release was running.
 */
export async function readAppVersion(): Promise<string> {
  try {
    const pkg: unknown = await Bun.file(
      new URL("../package.json", import.meta.url),
    ).json();
    const version: unknown =
      typeof pkg === "object" && pkg !== null ? Reflect.get(pkg, "version") : undefined;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

export async function checkDomainKeysDecrypt(): Promise<void> {
  /**
   * Every stored DKIM key must decrypt with the current key (#244). A wrong
   * `DKIM_ENCRYPTION_KEY` would hold every send from those domains (the
   * queue never sends unsigned in production), so production refuses to
   * start, naming the domains, like the other boot guards. Development
   * warns and sends unsigned.
   */
  const undecryptableKeys = await findUndecryptableDomainKeys();
  const undecryptableDomains = undecryptableKeys.active;
  if (undecryptableDomains.length > 0) {
    const detail = {
      domains: undecryptableDomains,
      hint: "DKIM_ENCRYPTION_KEY differs from the key these were encrypted with (SECURITY.md, Rotation)",
    };
    if (config.env === "production") {
      logger.error("[boot] DKIM private keys do not decrypt: refusing to start", detail);
      throw new Error(
        `[boot] DKIM private keys of ${undecryptableDomains.length} domain(s) do not decrypt with DKIM_ENCRYPTION_KEY`,
      );
    }
    logger.warn(
      "DKIM private keys do not decrypt: those domains send unsigned (development only)",
      detail,
    );
  }

  /**
   * A pending rotation key (#250) that does not decrypt holds no mail: mail
   * is signed with the active key, and completing the rotation refuses such
   * a key. Reported on its own, in every environment, so the boot goes on.
   */
  if (undecryptableKeys.pending.length > 0) {
    logger.warn(
      "Pending DKIM rotation keys do not decrypt: cancel those rotations and start new ones",
      {
        domains: undecryptableKeys.pending,
        hint: "DKIM_ENCRYPTION_KEY differs from the key these were encrypted with (SECURITY.md, Rotation)",
      },
    );
  }
}

/**
 * Domain names stored before names were checked on create (#406): one
 * `warn` per row that creation would now refuse, or store in another form
 * (a final dot, a Unicode IDN). Such a name can miss sender-domain lookups
 * and DNS checks. Nothing is changed and the boot goes on: the operator
 * deletes the domain and adds it again under its normalised name.
 */
export async function warnNonCanonicalDomainNames(): Promise<void> {
  try {
    for (const domain of await findNonCanonicalDomainNames()) {
      logger.warn(
        domain.normalized === null
          ? "Stored domain name is not a valid host name: domain creation would refuse it"
          : "Stored domain name is not in normalised form: domain creation would store it differently",
        {
          domainId: domain.id,
          name: domain.name,
          normalized: domain.normalized,
          hint: "delete the domain and add it again under a valid, normalised name (docs/domains.md)",
        },
      );
    }
  } catch (error: unknown) {
    /** The query binds no values, and the logger strips any a drizzle error carries. */
    logger.error("Stored domain name check failed; the boot goes on", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Owner bootstrap (#215): create the dashboard owner from
 * `BUNMAIL_OWNER_EMAIL`, or replace a still-unused setup link, and log the
 * one-time link. Runs on every boot and is idempotent (see
 * `bootstrapOwner`). Non-fatal: the API and mail delivery do not depend on
 * the dashboard owner, so a failure is logged and the boot continues; the
 * operator can retry with a restart or `bun run src/db/reset-owner.ts`.
 */
export async function runOwnerBootstrap(): Promise<void> {
  const ownerEmail = config.dashboard.ownerEmail;
  if (ownerEmail === null) {
    /** Only reachable in development: production refuses to boot (config.ts). */
    logger.warn(
      "BUNMAIL_OWNER_EMAIL is not set: owner bootstrap skipped; the dashboard has no account to sign in with until BUNMAIL_OWNER_EMAIL is set",
    );
    return;
  }

  try {
    const result = await bootstrapOwner(ownerEmail);
    switch (result.kind) {
      case "created":
      case "reissued": {
        /** Logged only now, after the transaction committed, and once per
         *  minted token. `warn` so LOG_LEVEL=warn does not hide it, raised to
         *  `error` when LOG_LEVEL=error so the link is never filtered out. */
        const { url, usedFallback } = buildSetupUrl(
          config.appBaseUrl,
          config.server.port,
          result.token,
        );
        const fields = {
          note: "single use, open it to set the owner password; only the most recent link works",
          url,
          owner: redactEmail(result.email),
          expiresAt: result.expiresAt.toISOString(),
          ...(usedFallback
            ? {
                hint: "APP_BASE_URL is not set to an http(s) URL: the link uses localhost, set it to this server's public URL",
              }
            : {}),
        };
        if (config.logLevel === "error") logger.error("Owner setup link", fields);
        else logger.warn("Owner setup link", fields);
        break;
      }
      case "complete":
        break;
      case "mismatch":
        logger.warn(
          "BUNMAIL_OWNER_EMAIL differs from the stored owner; ignored. Ownership moves only by transfer.",
          {
            configured: redactEmail(ownerEmail),
            stored: redactEmail(result.storedEmail),
          },
        );
        break;
      case "email-taken":
        logger.error(
          "Owner bootstrap skipped: BUNMAIL_OWNER_EMAIL belongs to an existing non-owner account, which is never promoted",
          { configured: redactEmail(ownerEmail) },
        );
        break;
    }
  } catch (error: unknown) {
    logger.error("Owner bootstrap failed; run `bun run src/db/reset-owner.ts` to retry", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function warnIgnoredSettings(): void {
  /**
   * Account login (#216) replaced the shared dashboard password and the HMAC
   * session secret. A value left in `.env` does nothing; say so once, so the
   * operator removes it instead of believing it still protects anything.
   */
  if (config.dashboard.legacyAuthEnv.length > 0) {
    logger.warn(
      "Dashboard auth env vars are no longer used since #216, remove from .env",
      {
        vars: config.dashboard.legacyAuthEnv,
        note: "the dashboard signs in with the owner account (BUNMAIL_OWNER_EMAIL and the setup link)",
      },
    );
  }

  /**
   * SSO (#224) builds its redirect URIs on `APP_BASE_URL`, which must be
   * `https://` (plain `http://` only on a loopback host). Providers
   * configured without one leave SSO off; say so once, as the operator
   * otherwise sees no reason.
   */
  if (config.sso.providers.length > 0 && config.sso.baseUrl === null) {
    logger.warn("SSO is off: APP_BASE_URL is not an https:// URL", {
      providers: config.sso.providers.map((provider) => provider.id),
      hint: "set APP_BASE_URL to this server's public https:// URL (http:// only for localhost)",
    });
  }

  /**
   * A provider listed in `SSO_PROVIDERS` without client credentials is left
   * out (#224): no button, no routes. Say so once per provider, naming the
   * missing variables (never values), so the missing button has a reason.
   */
  /**
   * DANE (#345) believes the AD bit of `DANE_RESOLVER`. From a resolver that
   * is not on this host or a private network, that bit crossed a network
   * unprotected and an on-path attacker could set it (RFC 7672 section
   * 2.1.1): warn once, never refuse (only the operator knows the path).
   */
  const resolver = config.dane.resolver;
  if (config.dane.enabled && resolver !== null && !daneResolverIsLocal(resolver)) {
    logger.warn("DANE_RESOLVER is not a local or private address", {
      resolver: resolver.address,
      port: resolver.port,
      hint: "the AD bit of a remote resolver is not trustworthy over plain DNS (RFC 7672 section 2.1.1); run a local validating resolver (the compose dane profile)",
    });
  }

  for (const skipped of config.sso.skipped) {
    logger.warn("SSO provider skipped: no client credentials", {
      provider: skipped.id,
      missing: skipped.missing,
      hint: "set both variables to show its sign-in button, or remove it from SSO_PROVIDERS",
    });
  }
}
