import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { DomainsPage } from "../routes/domains.tsx";
import { DomainDetailPage } from "../routes/domain-detail.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import { dkimRotationErrorFlash, domainAddErrorFlash } from "../flash-errors.ts";
import {
  DkimRotationError,
  DomainAlreadyRegisteredError,
  InvalidDkimSelectorError,
  InvalidDomainNameError,
  TrackingEpochExhaustedError,
} from "../../modules/domains/errors.ts";
import * as domainService from "../../modules/domains/services/domain.service.ts";
import { verifyDomain } from "../../modules/domains/services/dns-verification.service.ts";
import {
  cancelDkimRotation,
  completeDkimRotation,
  startDkimRotation,
} from "../../modules/domains/services/dkim-rotation.service.ts";
import { revokeTrackingLinks } from "../../modules/domains/services/tracking-revocation.service.ts";
import { getDomainDnsStatus } from "../../modules/domains/services/domain-dns-status.service.ts";
import { getRequiredDnsRecords } from "../../modules/domains/services/required-dns-records.ts";
import { FLASH_QUERY, flashUrl, toFlash, type Flash } from "../lib/flash.ts";
import type { FlashCode } from "../lib/flash-codes.ts";
import { isDnsVerifyThrottled } from "../lib/dns-verify-throttle.ts";
import { creatorNames } from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardAudit } from "../lib/audit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import { config } from "../../config.ts";

/** The domain page with a flash banner (#421: a code, never text). */
function domainFlashUrl(id: string, flash: Flash): string {
  return flashUrl(`/dashboard/domains/${id}`, flash);
}

/**
 * Runs one DKIM rotation step (#250) for the dashboard: the step's own
 * refusal (`DkimRotationError`) becomes its error flash on the domain
 * page, an unknown domain one on the list, anything else is logged and
 * shown as `fallback`.
 */
async function dkimRotationStep(
  id: string,
  step: () => Promise<unknown>,
  success: FlashCode,
  fallback: FlashCode,
): Promise<string> {
  try {
    const domain = await step();
    if (domain === undefined) {
      return flashUrl("/dashboard/domains", "domain_not_found");
    }
    return domainFlashUrl(id, success);
  } catch (error) {
    if (error instanceof DkimRotationError) {
      /** The banner is a code (#421): the refusal is logged with its code. */
      logger.warn("DKIM rotation step refused via dashboard", {
        domainId: id,
        code: error.code,
      });
    } else {
      logger.error("DKIM rotation step failed via dashboard", {
        domainId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return domainFlashUrl(id, dkimRotationErrorFlash(error, fallback));
  }
}

/**
 * Domain pages (#291): list, add, delete, DNS verify, DKIM rotation,
 * settings, tracking link revocation (#424), detail.
 */
export function domainPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/domains
       * Domains list with add form. Shows flash messages from query params.
       */
      .get(
        "/domains",
        async ({ query, auth }) => {
          const [domainList, creators] = await Promise.all([
            domainService.listDomains(),
            creatorNames(auth),
          ]);

          const flash = toFlash(query.flash, query.flashN);

          return <DomainsPage domains={domainList} flash={flash} creators={creators} />;
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            ...FLASH_QUERY,
          }),
        },
      )

      /**
       * POST /dashboard/domains
       * Adds a new domain via form submission.
       */
      .post(
        "/domains",
        async ({ body, set, auth, request, server }) => {
          try {
            /** Attributed to the signed-in account (#219). */
            /** Empty means the default selector (#250). */
            const selector = (body.dkimSelector ?? "").trim();
            const domain = await domainService.createDomain({
              name: body.name,
              createdByUserId: auth.user.id,
              dkimSelector: selector === "" ? undefined : selector,
            });
            await recordAuditEvent({
              ...dashboardAudit(auth, request, server),
              action: "domain.created",
              target: { type: "domain", id: domain.id, label: domain.name },
            });

            logger.info("Domain added via dashboard", {
              name: domain.name,
              userId: auth.user.id,
            });
            set.status = 302;
            set.headers["location"] = flashUrl("/dashboard/domains", "domain_added");
          } catch (error) {
            if (error instanceof DomainAlreadyRegisteredError) {
              logger.warn("Domain not added via dashboard: already registered");
            } else if (error instanceof InvalidDomainNameError) {
              logger.warn("Domain not added via dashboard: invalid name");
            } else if (error instanceof InvalidDkimSelectorError) {
              logger.warn("Domain not added via dashboard: invalid DKIM selector");
            } else {
              logger.error("Failed to add domain via dashboard", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            set.status = 302;
            set.headers["location"] = flashUrl(
              "/dashboard/domains",
              domainAddErrorFlash(error),
            );
          }
          return "";
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            name: t.String(),
            dkimSelector: t.Optional(t.String({ maxLength: 255 })),
          }),
        },
      )

      /**
       * POST /dashboard/domains/:id/delete
       * Deletes a domain via form submission.
       */
      .post(
        "/domains/:id/delete",
        async ({ params, set, auth, request, server }) => {
          const domain = await domainService.deleteDomain(params.id);

          if (!domain) {
            set.status = 302;
            set.headers["location"] = flashUrl("/dashboard/domains", "domain_not_found");
            return "";
          }
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.deleted",
            target: { type: "domain", id: domain.id, label: domain.name },
          });

          logger.info("Domain deleted via dashboard", { id: params.id });
          set.status = 302;
          set.headers["location"] = flashUrl("/dashboard/domains", "domain_deleted");
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({
            id: t.String(),
          }),
        },
      )

      /**
       * POST /dashboard/domains/:id/verify
       * Triggers DNS verification and redirects back to domain detail.
       */
      .post(
        "/domains/:id/verify",
        async ({ params, set, auth, request, server }) => {
          const domain = await domainService.getDomainById(params.id);

          if (!domain) {
            set.status = 302;
            set.headers["location"] = flashUrl("/dashboard/domains", "domain_not_found");
            return "";
          }

          /** Throttle live DNS lookups per domain (#133). */
          if (await isDnsVerifyThrottled(params.id)) {
            logger.warn("Domain DNS verification throttled", { id: params.id });
            set.status = 302;
            set.headers["location"] = domainFlashUrl(
              params.id,
              "domain_verify_throttled",
            );
            return "";
          }

          const result = await verifyDomain(domain);
          const allPassed = result.spf && result.dkim && result.dmarc;
          /**
           * One code each way (#421): the page shows every record's own status
           * (a failed lookup as unknown, #250), so the banner names none.
           */
          const code = allPassed ? "domain_verified" : "domain_verify_incomplete";

          logger.info("Domain DNS verification via dashboard", {
            id: params.id,
            spf: result.spf,
            dkim: result.dkim,
            dmarc: result.dmarc,
          });
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.verified",
            target: { type: "domain", id: domain.id, label: domain.name },
            metadata: { spf: result.spf, dkim: result.dkim, dmarc: result.dmarc },
          });

          set.status = 302;
          set.headers["location"] = domainFlashUrl(params.id, code);
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({
            id: t.String(),
          }),
        },
      )

      /**
       * POST /dashboard/domains/:id/dkim/rotate
       * Starts a DKIM key rotation (#250): a new key under a dated selector,
       * pending until completed. Mail stays signed with the active key.
       */
      .post(
        "/domains/:id/dkim/rotate",
        async ({ params, set, auth, request, server }) => {
          set.status = 302;
          set.headers["location"] = await dkimRotationStep(
            params.id,
            () => startDkimRotation(params.id, dashboardAudit(auth, request, server)),
            "dkim_rotation_started",
            "dkim_rotation_start_failed",
          );
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
        },
      )

      /**
       * POST /dashboard/domains/:id/dkim/rotate/complete
       * Switches to the pending key once its TXT record is published (#250).
       * Looks up DNS, so it shares the Verify throttle.
       */
      .post(
        "/domains/:id/dkim/rotate/complete",
        async ({ params, set, auth, request, server }) => {
          set.status = 302;
          if (await isDnsVerifyThrottled(params.id)) {
            logger.warn("DKIM rotation complete throttled", { id: params.id });
            set.headers["location"] = domainFlashUrl(params.id, "dkim_dns_throttled");
            return "";
          }
          set.headers["location"] = await dkimRotationStep(
            params.id,
            () => completeDkimRotation(params.id, dashboardAudit(auth, request, server)),
            "dkim_rotation_completed",
            "dkim_rotation_complete_failed",
          );
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
        },
      )

      /**
       * POST /dashboard/domains/:id/dkim/rotate/cancel
       * Drops the pending key (#250); the active key is untouched. A form
       * cannot send DELETE, hence a POST route.
       */
      .post(
        "/domains/:id/dkim/rotate/cancel",
        async ({ params, set, auth, request, server }) => {
          set.status = 302;
          set.headers["location"] = await dkimRotationStep(
            params.id,
            () => cancelDkimRotation(params.id, dashboardAudit(auth, request, server)),
            "dkim_rotation_cancelled",
            "dkim_rotation_cancel_failed",
          );
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
        },
      )

      /**
       * POST /dashboard/domains/:id/notify-email
       * Sets or clears the inbound-notification address for a domain (#106).
       * An empty submission clears it (disables notifications).
       */
      .post(
        "/domains/:id/notify-email",
        async ({ params, body, set, auth, request, server }) => {
          const raw = (body.notifyEmail ?? "").trim();
          /** Empty clears the address; otherwise require a plausible email. */
          const value = raw === "" ? null : raw;
          if (value !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            set.status = 302;
            set.headers["location"] = domainFlashUrl(params.id, "domain_notify_invalid");
            return "";
          }

          const updated = await domainService.updateDomainNotifyEmail(params.id, value);

          if (!updated) {
            set.status = 302;
            set.headers["location"] = flashUrl("/dashboard/domains", "domain_not_found");
            return "";
          }
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.updated",
            target: { type: "domain", id: updated.id, label: updated.name },
            metadata: { fields: ["notifyEmail"] },
          });

          const code = value ? "domain_notify_enabled" : "domain_notify_disabled";
          set.status = 302;
          set.headers["location"] = domainFlashUrl(params.id, code);
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
          body: t.Object({ notifyEmail: t.Optional(t.String({ maxLength: 255 })) }),
        },
      )

      /**
       * POST /dashboard/domains/:id/unsubscribe
       * Sets or clears the domain's `List-Unsubscribe` overrides (#243). An
       * empty field clears that override.
       */
      .post(
        "/domains/:id/unsubscribe",
        async ({ params, body, set, auth, request, server }) => {
          const email = (body.unsubscribeEmail ?? "").trim() || null;
          const url = (body.unsubscribeUrl ?? "").trim() || null;
          const back = (code: FlashCode): string => {
            set.status = 302;
            set.headers["location"] = domainFlashUrl(params.id, code);
            return "";
          };

          if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return back("domain_unsubscribe_email_invalid");
          }
          if (url !== null && (!URL.canParse(url) || !url.startsWith("https://"))) {
            return back("domain_unsubscribe_url_invalid");
          }

          const updated = await domainService.updateDomainSettings(params.id, {
            unsubscribeEmail: email,
            unsubscribeUrl: url,
          });
          if (!updated) {
            set.status = 302;
            set.headers["location"] = flashUrl("/dashboard/domains", "domain_not_found");
            return "";
          }
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.updated",
            target: { type: "domain", id: updated.id, label: updated.name },
            metadata: { fields: ["unsubscribeEmail", "unsubscribeUrl"] },
          });
          return back("domain_unsubscribe_saved");
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
          body: t.Object({
            unsubscribeEmail: t.Optional(t.String({ maxLength: 254 })),
            unsubscribeUrl: t.Optional(t.String({ maxLength: 2048 })),
          }),
        },
      )

      /**
       * POST /dashboard/domains/:id/tracking
       * Turns open and click tracking on or off for mail from the domain
       * (#187). Checkboxes: a box left unticked is absent from the form,
       * which means off. Audited as `domain.updated`. Tracking also needs
       * `TRACKING_ENABLED`; the flash says so while it is off.
       */
      .post(
        "/domains/:id/tracking",
        async ({ params, body, set, auth, request, server }) => {
          const trackOpens = body.trackOpens === "true";
          const trackClicks = body.trackClicks === "true";
          const updated = await domainService.updateDomainSettings(params.id, {
            trackOpens,
            trackClicks,
          });
          set.status = 302;
          if (!updated) {
            set.headers["location"] = flashUrl("/dashboard/domains", "domain_not_found");
            return "";
          }
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.updated",
            target: { type: "domain", id: updated.id, label: updated.name },
            metadata: { fields: ["trackOpens", "trackClicks"] },
          });
          const code = config.tracking.enabled
            ? "domain_tracking_saved"
            : "domain_tracking_saved_off";
          set.headers["location"] = domainFlashUrl(params.id, code);
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
          body: t.Object({
            trackOpens: t.Optional(t.Literal("true")),
            trackClicks: t.Optional(t.Literal("true")),
          }),
        },
      )

      /**
       * POST /dashboard/domains/:id/tracking-revoke
       * Revokes every click tracking link already sent from the domain
       * (#424): bumps its tracking epoch, so those links stop redirecting.
       * The button asks for confirmation. Audited as
       * `domain.tracking_links_revoked` by the service.
       */
      .post(
        "/domains/:id/tracking-revoke",
        async ({ params, set, auth, request, server }) => {
          set.status = 302;
          try {
            const domain = await revokeTrackingLinks(
              params.id,
              dashboardAudit(auth, request, server),
            );
            set.headers["location"] =
              domain === undefined
                ? flashUrl("/dashboard/domains", "domain_not_found")
                : domainFlashUrl(params.id, "tracking_links_revoked");
          } catch (error) {
            /**
             * The highest epoch is refused and logged (`warn`) by the
             * service; anything else is unexpected and logged here, by
             * name only, since the banner no longer shows it.
             */
            if (error instanceof TrackingEpochExhaustedError) {
              set.headers["location"] = domainFlashUrl(
                params.id,
                "tracking_epoch_exhausted",
              );
            } else {
              logger.error("Tracking links not revoked via dashboard", {
                domainId: params.id,
                errorName: error instanceof Error ? error.name : typeof error,
              });
              set.headers["location"] = domainFlashUrl(
                params.id,
                "tracking_revoke_failed",
              );
            }
          }
          return "";
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
        },
      )

      /**
       * GET /dashboard/domains/:id
       * Single domain detail view with DNS verification status.
       */
      .get(
        "/domains/:id",
        async ({ params, set, query }) => {
          const domain = await domainService.getDomainById(params.id);

          if (!domain) {
            set.status = 404;
            return "Domain not found";
          }

          const flash = toFlash(query.flash, query.flashN);

          const dns = await getDomainDnsStatus(domain.name);

          return (
            <DomainDetailPage
              domain={domain}
              dnsRecords={getRequiredDnsRecords(domain)}
              dns={dns}
              smtpEnabled={config.smtp.enabled}
              trackingEnabled={config.tracking.enabled}
              flash={flash}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({
            id: t.String(),
          }),
          query: t.Object({
            ...FLASH_QUERY,
          }),
        },
      )
  );
}
