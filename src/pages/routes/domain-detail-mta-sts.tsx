import type { Domain } from "../../modules/domains/types/domain.types.ts";
import type { DnsCheckOutcome } from "../../modules/domains/types/domain-check.types.ts";
import {
  mtaStsPolicyUrl,
  mtaStsTxtValue,
  servedMtaStsPolicy,
} from "../../modules/domains/services/mta-sts-served-policy.ts";
import { DetailField } from "./domain-detail-dns.tsx";

/** What the last MTA-STS check found, in a few words. */
function checkText(check: DnsCheckOutcome): string {
  switch (check.status) {
    case "pass":
      return `Last check: passed: ${check.reason}`;
    case "fail":
      return `Last check: failed: ${check.reason}`;
    case "unknown":
      return `Last check: DNS lookup failed: ${check.reason}`;
  }
}

/**
 * The domain's inbound MTA-STS setting (#472): the mode (`none`, `testing`,
 * `enforce`), saved by `POST /dashboard/domains/:id/mta-sts` (admins
 * only), and, while it is not `none`, what to publish: the `_mta-sts`
 * TXT record with the current policy id, the `mta-sts` host and its
 * certificate, the policy text, and the last Verify check. Says when the
 * policy is not served (the domain is not verified) and when this server
 * offers no inbound STARTTLS, which an enforce policy needs.
 */
export function MtaStsPanel({
  domain,
  inboundStarttls,
}: {
  domain: Pick<Domain, "id" | "name" | "mtaStsMode" | "verifiedAt" | "lastCheckResult">;
  /** `SMTP_ENABLED` with `SMTP_TLS_CERT`: the receiver offers STARTTLS. */
  inboundStarttls: boolean;
}) {
  const mode = domain.mtaStsMode;
  const policy = mode === "none" ? null : servedMtaStsPolicy(mode);
  const check = domain.lastCheckResult?.mtaSts ?? null;
  return (
    <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">
        MTA-STS (Inbound TLS)
      </h2>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-2">
        Off by default. Tells senders to deliver this domain's mail only over TLS with a
        valid certificate for the MX host (RFC 8461), so an attacker cannot strip
        STARTTLS. Start with testing (senders still deliver and report problems), then
        switch to enforce once the check below passes.
      </p>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Turning it off stops serving the policy, but senders keep a cached policy until
        its max_age runs out: go back to testing for that long before turning it off.
      </p>
      {!inboundStarttls && (
        <p class="text-sm text-amber-700 dark:text-amber-400 mb-4">
          This server offers no inbound STARTTLS (SMTP_ENABLED and SMTP_TLS_CERT). If the
          policy's MX hosts are this server, senders that honour an enforce policy cannot
          deliver here.
        </p>
      )}
      {policy !== null && domain.verifiedAt == null && (
        <p class="text-sm text-amber-700 dark:text-amber-400 mb-4">
          Not served yet: BunMail serves the policy only while the domain is verified.
        </p>
      )}
      <form
        method="POST"
        action={`/dashboard/domains/${domain.id}/mta-sts`}
        class="flex flex-col sm:flex-row gap-3 sm:items-center mb-4"
      >
        <select
          name="mode"
          class="px-3 py-2 text-sm bg-white dark:bg-gray-950 border border-gray-300 dark:border-gray-700 rounded-lg text-gray-900 dark:text-gray-100"
        >
          <option value="none" selected={mode === "none"}>
            Off (no policy)
          </option>
          <option value="testing" selected={mode === "testing"}>
            Testing
          </option>
          <option value="enforce" selected={mode === "enforce"}>
            Enforce
          </option>
        </select>
        <button
          type="submit"
          class="self-start px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
        >
          Save
        </button>
      </form>
      {policy !== null && (
        <div class="flex flex-col gap-4">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <DetailField label="TXT host" value={`_mta-sts.${domain.name}`} />
            <DetailField label="TXT value" value={mtaStsTxtValue(policy)} />
            <DetailField label="Policy URL" value={mtaStsPolicyUrl(domain.name)} />
            <DetailField label="Max age (seconds)" value={String(policy.maxAge)} />
          </div>
          <p class="text-sm text-gray-500 dark:text-gray-400" safe>
            {`Point mta-sts.${domain.name} at your reverse proxy (see Required DNS Records), give it a certificate valid for mta-sts.${domain.name}, and have it pass the original Host header to BunMail. The certificate senders see on port 25 must also be valid for each MX host below.`}
          </p>
          <pre
            class="text-xs bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 rounded-lg p-3 overflow-x-auto"
            safe
          >
            {policy.text}
          </pre>
          {check == null ? (
            <p class="text-sm text-gray-500 dark:text-gray-400">
              Not checked yet: click Verify DNS Records.
            </p>
          ) : (
            <p
              class={`text-sm ${check.status === "fail" ? "text-red-600 dark:text-red-400" : "text-gray-700 dark:text-gray-300"}`}
              safe
            >
              {checkText(check)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
