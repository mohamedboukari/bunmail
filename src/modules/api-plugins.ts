import { emailsPlugin } from "./emails/emails.plugin.ts";
import { apiKeysPlugin } from "./api-keys/api-keys.plugin.ts";
import { domainsPlugin } from "./domains/domains.plugin.ts";
import { webhooksPlugin } from "./webhooks/webhooks.plugin.ts";
import { templatesPlugin } from "./templates/templates.plugin.ts";
import { inboundPlugin } from "./inbound/inbound.plugin.ts";
import { suppressionsPlugin } from "./suppressions/suppressions.plugin.ts";
import { smtpSubmissionPlugin } from "./smtp-submission/smtp-submission.plugin.ts";
import { dmarcReportsPlugin } from "./dmarc-reports/dmarc-reports.plugin.ts";

/**
 * Every REST API plugin (`/api/v1/...`), in mount order. `src/index.ts`
 * mounts exactly this list, and the authorization matrix test (#228)
 * mounts the same list, so a new API module is covered by that test as
 * soon as it is added here.
 */
export const apiPlugins = [
  emailsPlugin,
  apiKeysPlugin,
  domainsPlugin,
  webhooksPlugin,
  templatesPlugin,
  inboundPlugin,
  suppressionsPlugin,
  smtpSubmissionPlugin,
  dmarcReportsPlugin,
];
