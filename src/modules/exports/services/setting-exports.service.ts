import { and, eq } from "drizzle-orm";
import { db } from "../../../db/index.ts";
import { apiKeys } from "../../api-keys/models/api-key.schema.ts";
import { domains } from "../../domains/models/domain.schema.ts";
import { templates } from "../../templates/models/template.schema.ts";
import { webhooks } from "../../webhooks/models/webhook.schema.ts";
import { users } from "../../users/models/user.schema.ts";
import { userTokens } from "../../users/models/user-token.schema.ts";
import { liveInvite } from "../../users/services/invite-store.service.ts";
import { redactUrl } from "../../../utils/redact.ts";
import { defineExportSource, listCell } from "./keyset.ts";
import type { ExportColumn, ExportSource, KeysetRow } from "../types/export.types.ts";

/**
 * CSV exports of the settings tables (#430): API keys, domains,
 * templates, webhooks, users and invitations.
 *
 * Each `SELECT` names its fields, so a key hash, a DKIM private (or
 * pending private) key, a template body, a webhook secret or an
 * invitation token hash never leaves the database for an export.
 */

/* ─── API keys ─── */

/** One API key as an export reads it (never `key_hash`). */
interface ApiKeyExportRow extends KeysetRow {
  createdAt: Date;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  isAdmin: boolean;
  allowedSenders: string[];
  disabledReason: string | null;
  lastUsedAt: Date | null;
  createdByUserId: string | null;
}

/** The columns of the API keys export. `key_prefix` is the public start shown on the page. */
const API_KEY_COLUMNS: readonly ExportColumn<ApiKeyExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "name", value: (r) => r.name },
  { header: "key_prefix", value: (r) => r.keyPrefix },
  { header: "is_active", value: (r) => r.isActive },
  { header: "is_admin", value: (r) => r.isAdmin },
  { header: "allowed_senders", value: (r) => listCell(r.allowedSenders) },
  { header: "disabled_reason", value: (r) => r.disabledReason },
  { header: "last_used_at", value: (r) => r.lastUsedAt },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "created_by_user_id", value: (r) => r.createdByUserId },
];

/**
 * The API keys of one tab of the page (#431), every creator's (admins
 * manage all keys): `active` the keys in use, `revoked` the revoked keys
 * and the keys disabled with their creator.
 */
export function apiKeysExport(tab: "active" | "revoked"): ExportSource {
  return defineExportSource({
    table: "api-keys",
    order: { at: apiKeys.createdAt, id: apiKeys.id, direction: "desc" },
    columns: API_KEY_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: apiKeys.id,
          createdAt: apiKeys.createdAt,
          name: apiKeys.name,
          keyPrefix: apiKeys.keyPrefix,
          isActive: apiKeys.isActive,
          isAdmin: apiKeys.isAdmin,
          allowedSenders: apiKeys.allowedSenders,
          disabledReason: apiKeys.disabledReason,
          lastUsedAt: apiKeys.lastUsedAt,
          createdByUserId: apiKeys.createdByUserId,
          cursorAt: page.cursorAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.isActive, tab === "active"), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Domains ─── */

/** One domain as an export reads it (no DKIM key material, private or public). */
interface DomainExportRow extends KeysetRow {
  createdAt: Date;
  name: string;
  spfVerified: boolean;
  dkimVerified: boolean;
  dmarcVerified: boolean;
  verifiedAt: Date | null;
  lastCheckedAt: Date | null;
  consecutiveFailures: number;
  dkimSelector: string;
  dkimPendingSelector: string | null;
  dkimRotatedAt: Date | null;
  notifyEmail: string | null;
  unsubscribeEmail: string | null;
  trackOpens: boolean;
  trackClicks: boolean;
  createdByUserId: string | null;
}

/** The columns of the domains export. */
const DOMAIN_COLUMNS: readonly ExportColumn<DomainExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "name", value: (r) => r.name },
  { header: "spf_verified", value: (r) => r.spfVerified },
  { header: "dkim_verified", value: (r) => r.dkimVerified },
  { header: "dmarc_verified", value: (r) => r.dmarcVerified },
  { header: "verified_at", value: (r) => r.verifiedAt },
  { header: "last_checked_at", value: (r) => r.lastCheckedAt },
  { header: "consecutive_failures", value: (r) => r.consecutiveFailures },
  { header: "dkim_selector", value: (r) => r.dkimSelector },
  { header: "dkim_pending_selector", value: (r) => r.dkimPendingSelector },
  { header: "dkim_rotated_at", value: (r) => r.dkimRotatedAt },
  { header: "notify_email", value: (r) => r.notifyEmail },
  { header: "unsubscribe_email", value: (r) => r.unsubscribeEmail },
  { header: "track_opens", value: (r) => r.trackOpens },
  { header: "track_clicks", value: (r) => r.trackClicks },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "created_by_user_id", value: (r) => r.createdByUserId },
];

/** Every domain, newest first. */
export function domainsExport(): ExportSource {
  return defineExportSource({
    table: "domains",
    order: { at: domains.createdAt, id: domains.id, direction: "desc" },
    columns: DOMAIN_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: domains.id,
          createdAt: domains.createdAt,
          name: domains.name,
          spfVerified: domains.spfVerified,
          dkimVerified: domains.dkimVerified,
          dmarcVerified: domains.dmarcVerified,
          verifiedAt: domains.verifiedAt,
          lastCheckedAt: domains.lastCheckedAt,
          consecutiveFailures: domains.consecutiveFailures,
          dkimSelector: domains.dkimSelector,
          dkimPendingSelector: domains.dkimPendingSelector,
          dkimRotatedAt: domains.dkimRotatedAt,
          notifyEmail: domains.notifyEmail,
          unsubscribeEmail: domains.unsubscribeEmail,
          trackOpens: domains.trackOpens,
          trackClicks: domains.trackClicks,
          createdByUserId: domains.createdByUserId,
          cursorAt: page.cursorAt,
        })
        .from(domains)
        .where(page.after)
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Templates ─── */

/** One template as an export reads it (never its HTML or text body). */
interface TemplateExportRow extends KeysetRow {
  createdAt: Date;
  updatedAt: Date;
  apiKeyId: string;
  name: string;
  subject: string;
  variables: string[] | null;
  createdByUserId: string | null;
}

/** The columns of the templates export. */
const TEMPLATE_COLUMNS: readonly ExportColumn<TemplateExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "name", value: (r) => r.name },
  { header: "subject", value: (r) => r.subject },
  { header: "variables", value: (r) => listCell(r.variables) },
  { header: "api_key_id", value: (r) => r.apiKeyId },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "updated_at", value: (r) => r.updatedAt },
  { header: "created_by_user_id", value: (r) => r.createdByUserId },
];

/** Every template, across every API key, newest first. */
export function templatesExport(): ExportSource {
  return defineExportSource({
    table: "templates",
    order: { at: templates.createdAt, id: templates.id, direction: "desc" },
    columns: TEMPLATE_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: templates.id,
          createdAt: templates.createdAt,
          updatedAt: templates.updatedAt,
          apiKeyId: templates.apiKeyId,
          name: templates.name,
          subject: templates.subject,
          variables: templates.variables,
          createdByUserId: templates.createdByUserId,
          cursorAt: page.cursorAt,
        })
        .from(templates)
        .where(page.after)
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Webhooks ─── */

/** One webhook as an export reads it (never its signing secret). */
interface WebhookExportRow extends KeysetRow {
  createdAt: Date;
  updatedAt: Date;
  apiKeyId: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdByUserId: string | null;
}

/** The columns of the webhooks export. */
const WEBHOOK_COLUMNS: readonly ExportColumn<WebhookExportRow>[] = [
  { header: "id", value: (r) => r.id },
  /**
   * The origin only (`redactUrl`, the policy of the webhook audit label
   * and log lines, #260): Slack, Discord, Teams, Mattermost and Zapier put
   * the receiver's secret in the path, others in the query or user info.
   */
  { header: "url_origin", value: (r) => redactUrl(r.url) },
  { header: "events", value: (r) => listCell(r.events) },
  { header: "is_active", value: (r) => r.isActive },
  { header: "api_key_id", value: (r) => r.apiKeyId },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "updated_at", value: (r) => r.updatedAt },
  { header: "created_by_user_id", value: (r) => r.createdByUserId },
];

/** Every webhook, across every API key, newest first. */
export function webhooksExport(): ExportSource {
  return defineExportSource({
    table: "webhooks",
    order: { at: webhooks.createdAt, id: webhooks.id, direction: "desc" },
    columns: WEBHOOK_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: webhooks.id,
          createdAt: webhooks.createdAt,
          updatedAt: webhooks.updatedAt,
          apiKeyId: webhooks.apiKeyId,
          url: webhooks.url,
          events: webhooks.events,
          isActive: webhooks.isActive,
          createdByUserId: webhooks.createdByUserId,
          cursorAt: page.cursorAt,
        })
        .from(webhooks)
        .where(page.after)
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Users ─── */

/** One account as an export reads it (credentials live in another table and are never read). */
interface UserExportRow extends KeysetRow {
  createdAt: Date;
  email: string;
  name: string | null;
  role: string;
  disabledAt: Date | null;
  emailVerifiedAt: Date | null;
}

/** The columns of the users export. */
const USER_COLUMNS: readonly ExportColumn<UserExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "email", value: (r) => r.email },
  { header: "name", value: (r) => r.name },
  { header: "role", value: (r) => r.role },
  { header: "disabled", value: (r) => r.disabledAt !== null },
  { header: "disabled_at", value: (r) => r.disabledAt },
  { header: "email_verified_at", value: (r) => r.emailVerifiedAt },
  { header: "created_at", value: (r) => r.createdAt },
];

/** Every account, oldest first like the Users page. */
export function usersExport(): ExportSource {
  return defineExportSource({
    table: "users",
    order: { at: users.createdAt, id: users.id, direction: "asc" },
    columns: USER_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: users.id,
          createdAt: users.createdAt,
          email: users.email,
          name: users.name,
          role: users.role,
          disabledAt: users.disabledAt,
          emailVerifiedAt: users.emailVerifiedAt,
          cursorAt: page.cursorAt,
        })
        .from(users)
        .where(page.after)
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}

/* ─── Invitations ─── */

/** One pending invitation as an export reads it (never its token hash). */
interface InvitationExportRow extends KeysetRow {
  createdAt: Date;
  email: string | null;
  role: string | null;
  expiresAt: Date;
  invitedBy: string | null;
  inviterEmail: string | null;
}

/** The columns of the invitations export. */
const INVITATION_COLUMNS: readonly ExportColumn<InvitationExportRow>[] = [
  { header: "id", value: (r) => r.id },
  { header: "email", value: (r) => r.email },
  { header: "role", value: (r) => r.role },
  { header: "invited_by_user_id", value: (r) => r.invitedBy },
  { header: "invited_by_email", value: (r) => r.inviterEmail },
  { header: "created_at", value: (r) => r.createdAt },
  { header: "expires_at", value: (r) => r.expiresAt },
];

/** The pending invitations, like the Invitations page (open and not expired), newest first. */
export function invitationsExport(): ExportSource {
  return defineExportSource({
    table: "invitations",
    order: { at: userTokens.createdAt, id: userTokens.id, direction: "desc" },
    columns: INVITATION_COLUMNS,
    rows: (page) =>
      db
        .select({
          id: userTokens.id,
          createdAt: userTokens.createdAt,
          email: userTokens.email,
          role: userTokens.role,
          expiresAt: userTokens.expiresAt,
          invitedBy: userTokens.invitedBy,
          inviterEmail: users.email,
          cursorAt: page.cursorAt,
        })
        .from(userTokens)
        .leftJoin(users, eq(users.id, userTokens.invitedBy))
        .where(and(liveInvite(), page.after))
        .orderBy(...page.orderBy)
        .limit(page.limit),
  });
}
