/**
 * Central schema re-export file.
 *
 * Each module defines its own Drizzle pgTable in models/ — this file
 * collects them into a single entry point so that:
 * 1. drizzle-kit can discover all tables for migrations
 * 2. The Drizzle client gets full schema for relational queries
 */
export { apiKeys } from "../modules/api-keys/models/api-key.schema.ts";
export { domains } from "../modules/domains/models/domain.schema.ts";
export { emails } from "../modules/emails/models/email.schema.ts";
export { emailTombstones } from "../modules/emails/models/email-tombstone.schema.ts";
export { webhooks } from "../modules/webhooks/models/webhook.schema.ts";
export { webhookDeliveries } from "../modules/webhooks/models/webhook-delivery.schema.ts";
export { templates } from "../modules/templates/models/template.schema.ts";
export { inboundEmails } from "../modules/inbound/models/inbound-email.schema.ts";
export { suppressions } from "../modules/suppressions/models/suppression.schema.ts";
export { dmarcReports } from "../modules/dmarc-reports/models/dmarc-report.schema.ts";
export { dmarcRecords } from "../modules/dmarc-reports/models/dmarc-record.schema.ts";
