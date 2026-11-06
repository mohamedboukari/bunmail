import { mailFlowFeatures } from "../../modules/domains/services/domain-dns-status.service.ts";
import type { MxStatus } from "../../modules/bounces/services/return-path-mx.ts";

/** What the MX status means, in one line. */
function mxSummary(mx: MxStatus): string {
  switch (mx.status) {
    case "here":
      return "The MX points at this server.";
    case "elsewhere":
      return "The MX points at another mail host. That is fine for sending; it decides where replies and bounces go.";
    case "none":
      return "The domain has no MX record. Sending works without one.";
    case "error":
      return "The MX lookup failed. Sending is unaffected; reload in a few minutes.";
  }
}

/**
 * Where the domain's MX points and which mail flows BunMail handles for it
 * (#250). Informational: nothing here gates sending.
 */
export function MailFlowPanel({
  mx,
  smtpEnabled,
}: {
  mx: MxStatus;
  smtpEnabled: boolean;
}) {
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
        MX and Mail Flow
      </h2>
      <p class="text-sm text-gray-700 dark:text-gray-300 mb-1" safe>
        {mxSummary(mx)}
      </p>
      {mx.hosts.length > 0 && (
        <p class="text-xs font-mono text-gray-500 dark:text-gray-400 break-all mb-4" safe>
          {`MX: ${mx.hosts.join(", ")}`}
        </p>
      )}
      <ul class="space-y-2 text-sm mt-3">
        {mailFlowFeatures(mx, smtpEnabled).map((feature) => (
          <li class="flex gap-2">
            <span
              class={`shrink-0 w-14 text-xs font-medium ${feature.active ? "text-emerald-700 dark:text-emerald-400" : "text-gray-500 dark:text-gray-400"}`}
            >
              {feature.active ? "Active" : "Off"}
            </span>
            <span>
              <span class="font-medium text-gray-900 dark:text-gray-100" safe>
                {feature.name}
              </span>
              <span class="text-gray-600 dark:text-gray-400" safe>
                {`: ${feature.explanation}`}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
