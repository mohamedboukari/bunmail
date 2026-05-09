import { BaseLayout } from "../layouts/base.tsx";
import { FlashMessage } from "../components/flash-message.tsx";
import type { WebhookDelivery } from "../../modules/webhooks/models/webhook-delivery.schema.ts";
import type { Webhook } from "../../modules/webhooks/types/webhook.types.ts";

interface WebhookDeliveryDetailPageProps {
  delivery: WebhookDelivery;
  webhook: Webhook;
  flash?: { message: string; type: "success" | "error" };
}

/**
 * Webhook delivery detail (#30) — full view of one attempt: payload
 * bytes that were POSTed, attempt counter, last error / HTTP status,
 * scheduled next attempt time, and a Replay button that flips a
 * `failed` row back to `pending` so the worker re-tries it.
 *
 * The payload is the exact JSON that gets re-signed per attempt; copying
 * from this page is the canonical way to debug "the receiver rejected
 * my signature" — paste the body bytes + the timestamp from the most
 * recent attempt's request log into your verifier.
 */
export function WebhookDeliveryDetailPage({
  delivery,
  webhook,
  flash,
}: WebhookDeliveryDetailPageProps) {
  /** Try to pretty-print the stored payload for display. The wire bytes
   *  remain compact (the field stores compact JSON) — this is just a
   *  visual aid. Falls back to raw if it's somehow not JSON. */
  let prettyPayload = delivery.payload;
  try {
    prettyPayload = JSON.stringify(JSON.parse(delivery.payload), null, 2);
  } catch {
    /* leave as-is */
  }

  return (
    <BaseLayout title={`Delivery ${delivery.id}`} activeNav="webhooks">
      <div class="mb-4">
        <a
          href={`/dashboard/webhooks/${webhook.id}/deliveries`}
          class="text-sm text-gray-600 dark:text-gray-400 hover:underline"
        >
          ← All deliveries for this webhook
        </a>
      </div>

      {flash && <FlashMessage message={flash.message} type={flash.type} />}

      <h1 class="text-xl font-semibold mb-1 font-mono">{delivery.event}</h1>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-6 break-all" safe>
        {webhook.url}
      </p>

      {/* Summary cards */}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <SummaryCard label="Status" value={delivery.status} mono />
        <SummaryCard label="Attempts" value={String(delivery.attempts)} />
        <SummaryCard
          label="Last HTTP"
          value={
            delivery.lastResponseStatus !== null
              ? String(delivery.lastResponseStatus)
              : "—"
          }
          mono
        />
        <SummaryCard
          label={delivery.deliveredAt ? "Delivered at" : "Next attempt"}
          value={
            delivery.deliveredAt
              ? delivery.deliveredAt.toISOString().slice(0, 19).replace("T", " ")
              : delivery.status === "pending"
                ? delivery.nextAttemptAt.toISOString().slice(0, 19).replace("T", " ")
                : "—"
          }
        />
      </div>

      {/* Replay action — only meaningful for non-delivered rows */}
      {delivery.status !== "delivered" && (
        <div class="mb-6">
          <form
            method="POST"
            action={`/dashboard/webhooks/deliveries/${delivery.id}/replay`}
          >
            <button
              type="submit"
              class="px-4 py-2 bg-gray-900 text-white text-sm rounded-lg hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-300"
            >
              Replay delivery
            </button>
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Resets attempts to 0 and queues for immediate re-delivery on the next worker
              tick.
            </p>
          </form>
        </div>
      )}

      {/* Last error */}
      {delivery.lastError && (
        <section class="mb-6">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
            Last error
          </h2>
          <div
            class="bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-800 dark:text-red-200 font-mono break-all"
            safe
          >
            {delivery.lastError}
          </div>
        </section>
      )}

      {/* Last response body preview */}
      {delivery.lastResponseBody?.bodyPreview && (
        <section class="mb-6">
          <h2 class="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
            Last response (preview)
          </h2>
          <pre
            class="p-4 text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded overflow-x-auto"
            safe
          >
            {delivery.lastResponseBody.bodyPreview}
          </pre>
        </section>
      )}

      {/* Payload (the exact bytes signed and POSTed) */}
      <section>
        <h2 class="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 mb-2">
          Payload (signed body)
        </h2>
        <pre
          class="p-4 text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded overflow-x-auto"
          safe
        >
          {prettyPayload}
        </pre>
      </section>
    </BaseLayout>
  );
}

function SummaryCard({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div class="border border-gray-200 dark:border-gray-800 rounded-lg p-4">
      <div class="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide">
        {label}
      </div>
      <div class={`text-lg font-semibold mt-1 ${mono ? "font-mono" : ""}`} safe>
        {value}
      </div>
    </div>
  );
}
