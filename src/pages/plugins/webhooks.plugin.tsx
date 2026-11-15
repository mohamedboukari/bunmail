import { t } from "elysia";
import { consumeRevealSecret, stashRevealSecret } from "../reveal-store.ts";
import { WebhooksPage } from "../routes/webhooks.tsx";
import { WebhookDeliveriesPage } from "../routes/webhook-deliveries.tsx";
import { WebhookDeliveryDetailPage } from "../routes/webhook-delivery-detail.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import { webhookCreateErrorFlash } from "../flash-errors.ts";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import * as webhookService from "../../modules/webhooks/services/webhook.service.ts";
import * as webhookDeliveryService from "../../modules/webhooks/services/webhook-delivery.service.ts";
import { setNoStore } from "../lib/responses.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import { recordActorOf, creatorNames } from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardAudit } from "../lib/audit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import { redactUrl } from "../../utils/redact.ts";
import { ReplayLimitReachedError } from "../../modules/webhooks/errors.ts";
import { isWebhookEventType } from "../../modules/webhooks/types/webhook.types.ts";
import { logger } from "../../utils/logger.ts";
import { loggableError } from "../../utils/db-error.ts";
import { FLASH_QUERY, flashUrl, toFlash } from "../lib/flash.ts";

/** Webhook pages (#291): list, create, delete, deliveries and replay. */
export function webhookPages(app: GuardedDashboard) {
  return (
    app
      .get(
        "/webhooks",
        async ({ query, auth, set }) => {
          setNoStore(set);
          const [hooks, creators] = await Promise.all([
            webhookService.listAllWebhooks(),
            creatorNames(auth),
          ]);
          const flash = toFlash(query.flash, query.flashN);
          /** One-time reveal of the webhook HMAC secret (#132): never in URL. */
          const secret = await consumeRevealSecret(
            query.reveal,
            "webhook_secret",
            revealOwnerOf(auth),
          );

          return (
            <WebhooksPage
              webhooks={hooks}
              flash={flash}
              secret={secret}
              creators={creators}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            ...FLASH_QUERY,
            reveal: t.Optional(t.String()),
          }),
        },
      )

      .post(
        "/webhooks",
        async ({ body, set, auth, request, server }) => {
          /**
           * The ticked events (#437): a browser sends one `events` field per
           * ticked checkbox, so one event arrives as a string and several as
           * an array; an empty string counts as no selection.
           */
          const submitted = Array.isArray(body.events)
            ? body.events
            : [body.events].filter(Boolean);
          /**
           * At least one event, as the REST DTO requires (`minItems: 1`): a
           * webhook subscribed to nothing would never fire.
           */
          if (submitted.length === 0) {
            logger.warn("Dashboard webhook not created: no event selected", {
              userId: auth.user.id,
            });
            set.status = 302;
            set.headers["location"] = flashUrl("/dashboard/webhooks", "webhook_no_event");
            return "";
          }
          /**
           * Only names from `WEBHOOK_EVENT_TYPES`, the list the REST DTO
           * validates against (#437): the guard narrows each entry, and a
           * single unknown name refuses the whole form, so nothing is
           * stored. Neither the flash (a code, #421) nor the log
           * line quotes the submitted names: the log carries a count only.
           */
          const events = submitted.filter(isWebhookEventType);
          if (events.length !== submitted.length) {
            logger.warn("Dashboard webhook not created: unknown event name", {
              userId: auth.user.id,
              unknownCount: submitted.length - events.length,
            });
            set.status = 302;
            set.headers["location"] = flashUrl(
              "/dashboard/webhooks",
              "webhook_unknown_event",
            );
            return "";
          }
          try {
            /**
             * The key the webhook is attached to (#219): the user's own active key;
             * admins and the owner fall back to anyone's, a member never does.
             */
            const activeKey = await apiKeyService.findDashboardKeyFor(
              recordActorOf(auth),
            );
            if (!activeKey) {
              set.status = 302;
              set.headers["location"] = flashUrl("/dashboard/webhooks", "no_usable_key");
              return "";
            }
            /** The admin-only events rule is enforced in the service, for both surfaces. */
            const { webhook, secret } = await webhookService.createWebhook(
              { url: body.url, events },
              activeKey.id,
              /** Attributed to the signed-in account (#219). */
              auth.user.id,
            );
            /** Labelled by origin only: the path or query may carry a credential (#260). */
            await recordAuditEvent({
              ...dashboardAudit(auth, request, server),
              action: "webhook.created",
              target: { type: "webhook", id: webhook.id, label: redactUrl(webhook.url) },
              metadata: { events: webhook.events },
            });
            /** One-time reveal token in the URL (#132): never the secret. */
            const reveal = await stashRevealSecret(
              secret,
              "webhook_secret",
              revealOwnerOf(auth),
            );
            set.status = 302;
            set.headers["location"] =
              `${flashUrl("/dashboard/webhooks", "webhook_created")}&reveal=${reveal}`;
          } catch (error) {
            const flash = webhookCreateErrorFlash(error);
            /**
             * The banner is a code (#421), so the error is logged here: a
             * typed refusal at `warn` with its class, anything else at
             * `error`. Never the URL (its path or query may carry a
             * credential, #260) nor the refusal's message (it names the host).
             */
            if (flash !== "webhook_create_failed") {
              logger.warn("Dashboard webhook not created: refused", {
                userId: auth.user.id,
                refusal: error instanceof Error ? error.name : "unknown",
              });
            } else {
              logger.error("Failed to create webhook via dashboard", {
                userId: auth.user.id,
                error: loggableError(error),
              });
            }
            set.status = 302;
            set.headers["location"] = flashUrl("/dashboard/webhooks", flash);
          }
          return "";
        },
        {
          beforeHandle: adminGuard,
          body: t.Object({
            url: t.String(),
            events: t.Union([t.String(), t.Array(t.String())]),
          }),
        },
      )

      .post(
        "/webhooks/:id/delete",
        async ({ params, set, auth, request, server }) => {
          try {
            const hooks = await webhookService.listAllWebhooks();
            const hook = hooks.find((h) => h.id === params.id);
            if (!hook) {
              set.status = 302;
              set.headers["location"] = flashUrl(
                "/dashboard/webhooks",
                "webhook_not_found",
              );
              return "";
            }
            const deleted = await webhookService.deleteWebhook(params.id, hook.apiKeyId);
            if (deleted) {
              await recordAuditEvent({
                ...dashboardAudit(auth, request, server),
                action: "webhook.deleted",
                target: {
                  type: "webhook",
                  id: deleted.id,
                  label: redactUrl(deleted.url),
                },
              });
            }
            set.status = 302;
            set.headers["location"] = flashUrl("/dashboard/webhooks", "webhook_deleted");
          } catch (error) {
            /** The banner is a code (#421): the error goes to the log only (#448). */
            logger.error("Failed to delete webhook via dashboard", {
              webhookId: params.id,
              userId: auth.user.id,
              error: loggableError(error),
            });
            set.status = 302;
            set.headers["location"] = flashUrl(
              "/dashboard/webhooks",
              "webhook_delete_failed",
            );
          }
          return "";
        },
        { beforeHandle: adminGuard, params: t.Object({ id: t.String() }) },
      )

      /**
       * GET /dashboard/webhooks/:id/deliveries, paginated history of every
       * delivery attempt for one webhook (#30). Operators land here from
       * the webhooks list to answer "did event X actually deliver?".
       *
       * The dashboard is admin-scoped (sees every api key's data), so we
       * resolve the webhook first to learn its `apiKeyId` and pass that to
       * the service: the service's per-api-key gate is for the REST path,
       * not the dashboard.
       */
      .get(
        "/webhooks/:id/deliveries",
        async ({ params, query, set }) => {
          const hooks = await webhookService.listAllWebhooks();
          const webhook = hooks.find((h) => h.id === params.id);
          if (!webhook) {
            set.status = 302;
            set.headers["location"] = flashUrl(
              "/dashboard/webhooks",
              "webhook_not_found",
            );
            return "";
          }

          const { page, limit } = parsePagination(query);
          const status =
            query.status === "pending" ||
            query.status === "delivered" ||
            query.status === "failed"
              ? query.status
              : undefined;

          const { data, total } = await webhookDeliveryService.listDeliveriesForWebhook({
            webhookId: webhook.id,
            apiKeyId: webhook.apiKeyId,
            status,
            page,
            limit,
          });

          return (
            <WebhookDeliveriesPage
              webhook={webhook}
              deliveries={data}
              total={total}
              page={page}
              limit={limit}
              statusFilter={status}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String() }),
          query: t.Object({
            page: t.Optional(t.String()),
            limit: t.Optional(t.String()),
            status: t.Optional(t.String()),
          }),
        },
      )

      /** GET /dashboard/webhooks/deliveries/:deliveryId, full delivery
       *  detail with payload + attempt history + replay button. */
      .get(
        "/webhooks/deliveries/:deliveryId",
        async ({ params, query, set }) => {
          const hooks = await webhookService.listAllWebhooks();
          /** Iterate to find the delivery's parent webhook: there's no
           *  `findWebhookForDelivery` helper, but the list is small (one
           *  row per registered hook) so a single fetch is fine. */
          let foundDelivery: Awaited<
            ReturnType<typeof webhookDeliveryService.getDeliveryById>
          > = undefined;
          let foundWebhook: (typeof hooks)[number] | undefined;
          for (const hook of hooks) {
            const row = await webhookDeliveryService.getDeliveryById({
              deliveryId: params.deliveryId,
              apiKeyId: hook.apiKeyId,
            });
            if (row) {
              foundDelivery = row;
              foundWebhook = hook;
              break;
            }
          }
          if (!foundDelivery || !foundWebhook) {
            set.status = 302;
            set.headers["location"] = flashUrl(
              "/dashboard/webhooks",
              "webhook_delivery_not_found",
            );
            return "";
          }

          const flash = toFlash(query.flash, query.flashN);

          return (
            <WebhookDeliveryDetailPage
              delivery={foundDelivery}
              webhook={foundWebhook}
              flash={flash}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ deliveryId: t.String() }),
          query: t.Object({
            ...FLASH_QUERY,
          }),
        },
      )

      /** POST /dashboard/webhooks/deliveries/:deliveryId/replay, flip a
       *  failed/pending delivery back to pending so the worker re-tries it
       *  on the next poll. Redirects to the detail page with a flash. Over
       *  the replay limit (#258) it answers 429 with `Retry-After` on the
       *  detail page instead. */
      .post(
        "/webhooks/deliveries/:deliveryId/replay",
        async ({ params, set }) => {
          const hooks = await webhookService.listAllWebhooks();
          let replayed = false;
          for (const hook of hooks) {
            let row: Awaited<ReturnType<typeof webhookDeliveryService.replayDelivery>>;
            try {
              row = await webhookDeliveryService.replayDelivery({
                deliveryId: params.deliveryId,
                apiKeyId: hook.apiKeyId,
              });
            } catch (error) {
              if (!(error instanceof ReplayLimitReachedError)) throw error;
              const delivery = await webhookDeliveryService.getDeliveryById({
                deliveryId: params.deliveryId,
                apiKeyId: hook.apiKeyId,
              });
              if (!delivery) throw error;
              set.status = error.status;
              set.headers["retry-after"] = String(error.retryAfterSec);
              return (
                <WebhookDeliveryDetailPage
                  delivery={delivery}
                  webhook={hook}
                  flash={{ message: error.message, type: "error" }}
                />
              );
            }
            if (row) {
              replayed = true;
              break;
            }
          }
          set.status = 302;
          set.headers["location"] = replayed
            ? flashUrl(
                `/dashboard/webhooks/deliveries/${params.deliveryId}`,
                "webhook_replay_queued",
              )
            : flashUrl("/dashboard/webhooks", "webhook_delivery_not_found");
          return "";
        },
        { beforeHandle: adminGuard, params: t.Object({ deliveryId: t.String() }) },
      )
  );
}
