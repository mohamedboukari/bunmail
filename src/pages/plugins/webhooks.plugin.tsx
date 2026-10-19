import { t } from "elysia";
import { consumeRevealSecret, stashRevealSecret } from "../reveal-store.ts";
import { WebhooksPage } from "../routes/webhooks.tsx";
import { WebhookDeliveriesPage } from "../routes/webhook-deliveries.tsx";
import { WebhookDeliveryDetailPage } from "../routes/webhook-delivery-detail.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import { parsePagination } from "../pagination.ts";
import { flashMessageFor } from "../flash-errors.ts";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import * as webhookService from "../../modules/webhooks/services/webhook.service.ts";
import * as webhookDeliveryService from "../../modules/webhooks/services/webhook-delivery.service.ts";
import { setNoStore, toFlash } from "../lib/responses.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import {
  recordActorOf,
  creatorNames,
  NO_USABLE_KEY_TEXT,
} from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardAudit } from "../lib/audit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";
import { redactUrl } from "../../utils/redact.ts";
import { ReplayLimitReachedError } from "../../modules/webhooks/errors.ts";

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
          const flash = toFlash(query.flash, query.flashType);
          /** One-time reveal of the webhook HMAC secret (#132): never in URL. */
          const secret = consumeRevealSecret(
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
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
            reveal: t.Optional(t.String()),
          }),
        },
      )

      .post(
        "/webhooks",
        async ({ body, set, auth, request, server }) => {
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
              set.headers["location"] =
                `/dashboard/webhooks?flash=${encodeURIComponent(NO_USABLE_KEY_TEXT)}&flashType=error`;
              return "";
            }
            const events = Array.isArray(body.events)
              ? body.events
              : [body.events].filter(Boolean);
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
            const reveal = stashRevealSecret(
              secret,
              "webhook_secret",
              revealOwnerOf(auth),
            );
            set.status = 302;
            set.headers["location"] =
              `/dashboard/webhooks?flash=${encodeURIComponent("Webhook created")}&reveal=${reveal}`;
          } catch (error) {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/webhooks?flash=${encodeURIComponent(flashMessageFor(error, "Failed to create webhook"))}&flashType=error`;
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
              set.headers["location"] =
                `/dashboard/webhooks?flash=${encodeURIComponent("Webhook not found")}&flashType=error`;
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
            set.headers["location"] =
              `/dashboard/webhooks?flash=${encodeURIComponent("Webhook deleted")}`;
          } catch {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/webhooks?flash=${encodeURIComponent("Failed to delete webhook")}&flashType=error`;
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
            set.headers["location"] =
              `/dashboard/webhooks?flash=${encodeURIComponent("Webhook not found")}&flashType=error`;
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
            set.headers["location"] =
              `/dashboard/webhooks?flash=${encodeURIComponent("Delivery not found")}&flashType=error`;
            return "";
          }

          const flash = toFlash(query.flash, query.flashType);

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
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
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
            ? `/dashboard/webhooks/deliveries/${params.deliveryId}?flash=${encodeURIComponent(
                "Replay queued: worker will re-attempt on next poll",
              )}`
            : `/dashboard/webhooks?flash=${encodeURIComponent("Delivery not found")}&flashType=error`;
          return "";
        },
        { beforeHandle: adminGuard, params: t.Object({ deliveryId: t.String() }) },
      )
  );
}
