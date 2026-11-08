import { and, eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { suppressions } from "../../suppressions/models/suppression.schema.ts";
import { auditEvents } from "../../audit/models/audit-event.schema.ts";
import { dmarcReports } from "../../dmarc-reports/models/dmarc-report.schema.ts";
import { webhookDeliveries } from "../../webhooks/models/webhook-delivery.schema.ts";
import { allSuppressionsWhere } from "../../suppressions/services/suppression-unscoped.service.ts";
import { auditFilterClause } from "../../audit/services/audit.service.ts";
import type { AuditEventFilters } from "../../audit/types/audit.types.ts";
import { defineExportSource } from "./keyset.ts";
import type { ExportColumn, ExportSource, KeysetRow } from "../types/export.types.ts";

/**
 * CSV exports of the record tables (#430): suppressions, the audit log,
 * DMARC reports and one webhook's deliveries.
 *
 * As in `mail-exports.service.ts`, each `SELECT` names its fields: a
 * DMARC report's raw XML and a delivery's payload never leave the
 * database for an export.
 */

/* ─── Suppressions ─── */

/** One suppression as an export reads it. */
interface SuppressionExportRow extends KeysetRow {
  createdAt: Date;
  apiKeyId: string;
  email: string;
  reason: string;
  bounceType: string | null;
  diagnosticCode: string | null;
  sourceEmailId: string | null;
  expiresAt: Date | null;
}

/** The columns of the suppressions export. */
const SUPPRESSION_COLUMNS: readonly ExportColumn<SuppressionExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "api_key_id", value: (r) => r.apiKeyId },
  { header: "email", value: (r) => r.email },
  { header: "reason", value: (r) => r.reason },
  { header: "bounce_type", value: (r) => r.bounceType },
  { header: "diagnostic_code", value: (r) => r.diagnosticCode },
  { header: "source_email_id", value: (r) => r.sourceEmailId },
  { header: "expires_at", value: (r) => r.expiresAt },
];

/** The suppressions export, with the page's filters (email substring, API key). */
export function suppressionsExport(filters: {
  email?: string;
  apiKeyId?: string;
}): ExportSource {
  return defineExportSource({
    table: "suppressions",
    order: { at: suppressions.createdAt, id: suppressions.id, direction: "desc" },
    columns: SUPPRESSION_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: suppressions.id,
          createdAt: suppressions.createdAt,
          apiKeyId: suppressions.apiKeyId,
          email: suppressions.email,
          reason: suppressions.reason,
          bounceType: suppressions.bounceType,
          diagnosticCode: suppressions.diagnosticCode,
          sourceEmailId: suppressions.sourceEmailId,
          expiresAt: suppressions.expiresAt,
          cursorAt: page.cursorAt,
        })
        .from(suppressions)
        .where(and(allSuppressionsWhere(filters), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Audit log ─── */

/** One audit event as an export reads it: the whole row (it holds no secret by design, #221). */
interface AuditExportRow extends KeysetRow {
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  outcome: string;
  targetType: string | null;
  targetId: string | null;
  targetLabel: string | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown> | null;
}

/** The columns of the audit log export; `metadata` as compact JSON. */
const AUDIT_COLUMNS: readonly ExportColumn<AuditExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "occurred_at", value: (r) => r.occurredAt },
  { header: "actor_type", value: (r) => r.actorType },
  { header: "actor_id", value: (r) => r.actorId },
  { header: "actor_label", value: (r) => r.actorLabel },
  { header: "action", value: (r) => r.action },
  { header: "outcome", value: (r) => r.outcome },
  { header: "target_type", value: (r) => r.targetType },
  { header: "target_id", value: (r) => r.targetId },
  { header: "target_label", value: (r) => r.targetLabel },
  { header: "ip", value: (r) => r.ip },
  { header: "user_agent", value: (r) => r.userAgent },
  {
    header: "metadata",
    value: (r) => (r.metadata === null ? null : JSON.stringify(r.metadata)),
  },
];

/** The audit log export, with the page's filters (action, actor, outcome). */
export function auditLogExport(
  filters: Omit<AuditEventFilters, "page" | "limit">,
): ExportSource {
  return defineExportSource({
    table: "audit-log",
    order: { at: auditEvents.occurredAt, id: auditEvents.id, direction: "desc" },
    columns: AUDIT_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: auditEvents.id,
          occurredAt: auditEvents.occurredAt,
          actorType: auditEvents.actorType,
          actorId: auditEvents.actorId,
          actorLabel: auditEvents.actorLabel,
          action: auditEvents.action,
          outcome: auditEvents.outcome,
          targetType: auditEvents.targetType,
          targetId: auditEvents.targetId,
          targetLabel: auditEvents.targetLabel,
          ip: auditEvents.ip,
          userAgent: auditEvents.userAgent,
          metadata: auditEvents.metadata,
          cursorAt: page.cursorAt,
        })
        .from(auditEvents)
        .where(and(auditFilterClause(filters), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── DMARC reports ─── */

/** One DMARC report as an export reads it (never its raw XML). */
interface DmarcExportRow extends KeysetRow {
  dateEnd: Date;
  dateBegin: Date;
  domain: string;
  orgName: string;
  orgEmail: string;
  reportId: string;
  policyP: string;
  policyPct: number;
  receivedAt: Date;
}

/** The columns of the DMARC reports export. */
const DMARC_COLUMNS: readonly ExportColumn<DmarcExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "domain", value: (r) => r.domain },
  { header: "org_name", value: (r) => r.orgName },
  { header: "org_email", value: (r) => r.orgEmail },
  { header: "report_id", value: (r) => r.reportId },
  { header: "date_begin", value: (r) => r.dateBegin },
  { header: "date_end", value: (r) => r.dateEnd },
  { header: "policy_p", value: (r) => r.policyP },
  { header: "policy_pct", value: (r) => r.policyPct },
  { header: "received_at", value: (r) => r.receivedAt },
];

/** The DMARC reports export, with the page's optional domain filter; newest window first. */
export function dmarcReportsExport(domain: string | undefined): ExportSource {
  return defineExportSource({
    table: "dmarc-reports",
    order: { at: dmarcReports.dateEnd, id: dmarcReports.id, direction: "desc" },
    columns: DMARC_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: dmarcReports.id,
          dateEnd: dmarcReports.dateEnd,
          dateBegin: dmarcReports.dateBegin,
          domain: dmarcReports.domain,
          orgName: dmarcReports.orgName,
          orgEmail: dmarcReports.orgEmail,
          reportId: dmarcReports.reportId,
          policyP: dmarcReports.policyP,
          policyPct: dmarcReports.policyPct,
          receivedAt: dmarcReports.receivedAt,
          cursorAt: page.cursorAt,
        })
        .from(dmarcReports)
        .where(and(domain ? eq(dmarcReports.domain, domain) : undefined, page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Webhook deliveries ─── */

/** The delivery statuses the deliveries page filters on. */
type DeliveryStatus = "pending" | "delivered" | "failed";

/** One webhook delivery as an export reads it (never its payload). */
interface DeliveryExportRow extends KeysetRow {
  createdAt: Date;
  webhookId: string;
  event: string;
  status: string;
  attempts: number;
  lastResponseStatus: number | null;
  lastError: string | null;
  nextAttemptAt: Date | null;
  deliveredAt: Date | null;
}

/** The columns of the webhook deliveries export. */
const DELIVERY_COLUMNS: readonly ExportColumn<DeliveryExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "webhook_id", value: (r) => r.webhookId },
  { header: "event", value: (r) => r.event },
  { header: "status", value: (r) => r.status },
  { header: "attempts", value: (r) => r.attempts },
  { header: "last_response_status", value: (r) => r.lastResponseStatus },
  { header: "last_error", value: (r) => r.lastError },
  { header: "next_attempt_at", value: (r) => r.nextAttemptAt },
  { header: "delivered_at", value: (r) => r.deliveredAt },
];

/** One webhook's deliveries, with the page's optional status filter. */
export function webhookDeliveriesExport(
  webhookId: string,
  status: DeliveryStatus | undefined,
): ExportSource {
  return defineExportSource({
    table: "webhook-deliveries",
    order: {
      at: webhookDeliveries.createdAt,
      id: webhookDeliveries.id,
      direction: "desc",
    },
    columns: DELIVERY_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: webhookDeliveries.id,
          createdAt: webhookDeliveries.createdAt,
          webhookId: webhookDeliveries.webhookId,
          event: webhookDeliveries.event,
          status: webhookDeliveries.status,
          attempts: webhookDeliveries.attempts,
          lastResponseStatus: webhookDeliveries.lastResponseStatus,
          lastError: webhookDeliveries.lastError,
          nextAttemptAt: webhookDeliveries.nextAttemptAt,
          deliveredAt: webhookDeliveries.deliveredAt,
          cursorAt: page.cursorAt,
        })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.webhookId, webhookId),
            status ? eq(webhookDeliveries.status, status) : undefined,
            page.after,
          ),
        )
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}
