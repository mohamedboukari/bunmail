import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { DomainsPage } from "../routes/domains.tsx";
import { DomainDetailPage } from "../routes/domain-detail.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import { flashMessageFor } from "../flash-errors.ts";
import {
  DkimRotationError,
  DomainAlreadyRegisteredError,
  InvalidDkimSelectorError,
} from "../../modules/domains/errors.ts";
import * as domainService from "../../modules/domains/services/domain.service.ts";
import { verifyDomain } from "../../modules/domains/services/dns-verification.service.ts";
import {
  cancelDkimRotation,
  completeDkimRotation,
  startDkimRotation,
} from "../../modules/domains/services/dkim-rotation.service.ts";
import { getDomainDnsStatus } from "../../modules/domains/services/domain-dns-status.service.ts";
import { getRequiredDnsRecords } from "../../modules/domains/services/required-dns-records.ts";
import { toFlash } from "../lib/responses.ts";
import { creatorNames } from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardAudit } from "../lib/audit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import { config } from "../../config.ts";

/* ─── DNS-verify throttle (#133) ─── */

/**
 * `POST /dashboard/domains/:id/verify` runs live DNS lookups (SPF/DKIM/DMARC)
 * with no throttle; the API rate-limiter only covers `/api/v1/*`. A rapid
 * click-loop (or a same-origin script) could hammer the resolver. This is a
 * lightweight per-domain sliding window: at most `DNS_VERIFY_MAX` verifies
 * per `DNS_VERIFY_WINDOW_MS` per domain id. In-memory/per-process (same
 * caveat as the other dashboard limiters). Keyed by domain id, not IP, since
 * the dashboard is a single shared operator: the resource we're protecting
 * is the DNS lookup for that domain.
 */
const DNS_VERIFY_MAX = 5;
const DNS_VERIFY_WINDOW_MS = 60_000;
const dnsVerifyHits = new Map<string, number[]>();

/**
 * Records a verify attempt for `domainId` and returns true if it exceeds the
 * window budget (i.e. the caller should be throttled). Prunes timestamps
 * outside the window on each call so the map self-trims.
 */
function isDnsVerifyThrottled(domainId: string): boolean {
  const now = Date.now();
  const cutoff = now - DNS_VERIFY_WINDOW_MS;
  const recent = (dnsVerifyHits.get(domainId) ?? []).filter((ts) => ts > cutoff);
  recent.push(now);
  dnsVerifyHits.set(domainId, recent);
  return recent.length > DNS_VERIFY_MAX;
}

/** Where a DKIM rotation step lands: the domain page with a flash. */
function domainFlashUrl(id: string, message: string, type: "success" | "error"): string {
  return `/dashboard/domains/${id}?flash=${encodeURIComponent(message)}&flashType=${type}`;
}

/**
 * Runs one DKIM rotation step (#250) for the dashboard: the step's own
 * refusal (`DkimRotationError`) becomes an error flash on the domain page,
 * an unknown domain one on the list, anything else is logged and shown
 * as `fallback`.
 */
async function dkimRotationStep(
  id: string,
  step: () => Promise<unknown>,
  success: string,
  fallback: string,
): Promise<string> {
  try {
    const domain = await step();
    if (domain === undefined) {
      return `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
    }
    return domainFlashUrl(id, success, "success");
  } catch (error) {
    if (!(error instanceof DkimRotationError)) {
      logger.error("DKIM rotation step failed via dashboard", {
        domainId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return domainFlashUrl(id, flashMessageFor(error, fallback), "error");
  }
}

/** Domain pages (#291): list, add, delete, DNS verify, DKIM rotation, settings, detail. */
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

          const flash = toFlash(query.flash, query.flashType);

          return <DomainsPage domains={domainList} flash={flash} creators={creators} />;
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
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
              name: body.name,
              userId: auth.user.id,
            });
            set.status = 302;
            set.headers["location"] =
              `/dashboard/domains?flash=${encodeURIComponent("Domain added successfully")}`;
          } catch (error) {
            if (error instanceof DomainAlreadyRegisteredError) {
              logger.warn("Domain not added via dashboard: already registered");
            } else if (error instanceof InvalidDkimSelectorError) {
              logger.warn("Domain not added via dashboard: invalid DKIM selector");
            } else {
              logger.error("Failed to add domain via dashboard", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            set.status = 302;
            set.headers["location"] =
              `/dashboard/domains?flash=${encodeURIComponent(flashMessageFor(error, "Failed to add domain"))}&flashType=error`;
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
            set.headers["location"] =
              `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
            return "";
          }
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.deleted",
            target: { type: "domain", id: domain.id, label: domain.name },
          });

          logger.info("Domain deleted via dashboard", { id: params.id });
          set.status = 302;
          set.headers["location"] =
            `/dashboard/domains?flash=${encodeURIComponent("Domain deleted")}`;
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
            set.headers["location"] =
              `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
            return "";
          }

          /** Throttle live DNS lookups per domain (#133). */
          if (isDnsVerifyThrottled(params.id)) {
            logger.warn("Domain DNS verification throttled", { id: params.id });
            set.status = 302;
            set.headers["location"] =
              `/dashboard/domains/${params.id}?flash=${encodeURIComponent("Too many verification attempts: wait a minute and try again")}&flashType=error`;
            return "";
          }

          const result = await verifyDomain(domain);
          const allPassed = result.spf && result.dkim && result.dmarc;
          const message = allPassed
            ? "All DNS records verified successfully!"
            : `Verification: SPF ${result.spf ? "✓" : "✗"}, DKIM ${result.dkim ? "✓" : "✗"}, DMARC ${result.dmarc ? "✓" : "✗"}`;

          logger.info("Domain DNS verification via dashboard", {
            id: params.id,
            ...result,
          });
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.verified",
            target: { type: "domain", id: domain.id, label: domain.name },
            metadata: { spf: result.spf, dkim: result.dkim, dmarc: result.dmarc },
          });

          set.status = 302;
          set.headers["location"] =
            `/dashboard/domains/${params.id}?flash=${encodeURIComponent(message)}&flashType=${allPassed ? "success" : "error"}`;
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
            "DKIM key rotation started: publish the pending DKIM record, then complete the rotation",
            "Failed to start the DKIM key rotation",
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
          if (isDnsVerifyThrottled(params.id)) {
            logger.warn("DKIM rotation complete throttled", { id: params.id });
            set.headers["location"] = domainFlashUrl(
              params.id,
              "Too many DNS checks: wait a minute and try again",
              "error",
            );
            return "";
          }
          set.headers["location"] = await dkimRotationStep(
            params.id,
            () => completeDkimRotation(params.id, dashboardAudit(auth, request, server)),
            "DKIM key rotation completed: mail is now signed with the new key",
            "Failed to complete the DKIM key rotation",
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
            "DKIM key rotation cancelled",
            "Failed to cancel the DKIM key rotation",
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
            set.headers["location"] =
              `/dashboard/domains/${params.id}?flash=${encodeURIComponent("Enter a valid email address")}&flashType=error`;
            return "";
          }

          const updated = await domainService.updateDomainNotifyEmail(params.id, value);

          if (!updated) {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
            return "";
          }
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.updated",
            target: { type: "domain", id: updated.id, label: updated.name },
            metadata: { fields: ["notifyEmail"] },
          });

          const message = value
            ? "Inbound notifications enabled"
            : "Inbound notifications disabled";
          set.status = 302;
          set.headers["location"] =
            `/dashboard/domains/${params.id}?flash=${encodeURIComponent(message)}&flashType=success`;
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
          const back = (message: string, type: "success" | "error"): string => {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/domains/${params.id}?flash=${encodeURIComponent(message)}&flashType=${type}`;
            return "";
          };

          if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return back("Enter a valid unsubscribe email address", "error");
          }
          if (url !== null && (!URL.canParse(url) || !url.startsWith("https://"))) {
            return back("The unsubscribe URL must be an https:// address", "error");
          }

          const updated = await domainService.updateDomainUnsubscribe(params.id, {
            unsubscribeEmail: email,
            unsubscribeUrl: url,
          });
          if (!updated) {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/domains?flash=${encodeURIComponent("Domain not found")}&flashType=error`;
            return "";
          }
          await recordAuditEvent({
            ...dashboardAudit(auth, request, server),
            action: "domain.updated",
            target: { type: "domain", id: updated.id, label: updated.name },
            metadata: { fields: ["unsubscribeEmail", "unsubscribeUrl"] },
          });
          return back("Unsubscribe settings saved", "success");
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

          const flash = toFlash(query.flash, query.flashType);

          const dns = await getDomainDnsStatus(domain.name);

          return (
            <DomainDetailPage
              domain={domain}
              dnsRecords={getRequiredDnsRecords(domain)}
              dns={dns}
              smtpEnabled={config.smtp.enabled}
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
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
          }),
        },
      )
  );
}
