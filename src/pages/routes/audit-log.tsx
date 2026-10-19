import { BaseLayout } from "../layouts/base.tsx";
import { EmptyState } from "../components/empty-state.tsx";
import { Pagination } from "../components/pagination.tsx";
import {
  AUDIT_ACTION_LABELS,
  AUDIT_ACTIONS,
  isAuditAction,
  type AuditActorOption,
  type AuditEvent,
} from "../../modules/audit/types/audit.types.ts";

/** The page's current filter values, as the form submits them. */
interface AuditLogFilters {
  action?: string;
  /** `user:<id>`, `api_key:<id>` or `system`. */
  actor?: string;
  outcome?: string;
}

interface AuditLogPageProps {
  events: AuditEvent[];
  total: number;
  page: number;
  limit: number;
  filters: AuditLogFilters;
  /** Users and keys seen as actors, for the actor filter. */
  actors: AuditActorOption[];
}

/** Shared classes of the filter inputs. */
const INPUT_CLASS =
  "w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 text-sm focus:outline-hidden focus:ring-2 focus:ring-gray-400 dark:focus:ring-gray-500";

/** Shared classes of the table headers. */
const TH_CLASS = "text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400";

/** `2026-10-19 12:34:56 UTC`: exact and unambiguous, unlike the relative times elsewhere. */
function utcTime(value: Date): string {
  return `${value.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** The actor cell's main line. */
function actorText(event: AuditEvent): string {
  if (event.actorType === "system") return `BunMail (${event.actorLabel ?? "system"})`;
  if (event.actorType === "api_key") return `API key ${event.actorLabel ?? "(deleted)"}`;
  if (event.actorId === null) return "Unknown account";
  return event.actorLabel ?? "(deleted account)";
}

/** The target cell's main line, or null when the event has no target. */
function targetText(event: AuditEvent): string | null {
  if (event.targetType === null) return null;
  const label = event.targetLabel ?? event.targetId;
  return label === null ? event.targetType : `${event.targetType}: ${label}`;
}

/** The metadata as `key: value` lines; values that are not strings as JSON. */
function metadataLines(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [];
  return Object.entries(metadata).map(
    ([key, value]) =>
      `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
  );
}

/** The value of an actor option in the filter select. */
function actorValue(option: AuditActorOption): string {
  return `${option.type}:${option.id}`;
}

/**
 * Audit log page (#221): security-relevant actions, newest first, for the
 * owner and admins. Every value that comes from the log (labels, ids, IP,
 * user agent, metadata) is escaped: a user agent or a key name is
 * attacker-chosen.
 */
export function AuditLogPage({
  events,
  total,
  page,
  limit,
  filters,
  actors,
}: AuditLogPageProps) {
  const filtered = !!(filters.action || filters.actor || filters.outcome);
  const extraParams = new URLSearchParams(
    Object.entries(filters).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1] !== "",
    ),
  ).toString();

  return (
    <BaseLayout title="Audit log" activeNav="audit-log">
      <h1 class="text-xl font-semibold mb-2">Audit log</h1>
      <p class="text-sm text-gray-500 dark:text-gray-400 mb-6">
        Sign-ins, account, two-factor, API key, domain, webhook and suppression changes:
        who did what, when, and from which address. Entries cannot be edited; old ones are
        deleted after the retention period.
      </p>

      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 mb-6">
        <form
          method="GET"
          action="/dashboard/audit-log"
          class="flex flex-wrap gap-3 items-end"
        >
          <div class="min-w-[220px]">
            <label
              for="action"
              class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
            >
              Action
            </label>
            <select id="action" name="action" class={INPUT_CLASS}>
              <option value="">All actions</option>
              {AUDIT_ACTIONS.map((action) => (
                <option value={action} selected={action === filters.action} safe>
                  {AUDIT_ACTION_LABELS[action]}
                </option>
              ))}
            </select>
          </div>
          <div class="min-w-[220px]">
            <label
              for="actor"
              class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
            >
              Actor
            </label>
            <select id="actor" name="actor" class={INPUT_CLASS}>
              <option value="">All actors</option>
              <option value="system" selected={filters.actor === "system"}>
                BunMail (system)
              </option>
              {actors.map((option) => (
                <option
                  value={actorValue(option)}
                  selected={actorValue(option) === filters.actor}
                  safe
                >
                  {`${option.type === "api_key" ? "API key " : ""}${option.label ?? option.id}`}
                </option>
              ))}
            </select>
          </div>
          <div class="min-w-[160px]">
            <label
              for="outcome"
              class="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1"
            >
              Outcome
            </label>
            <select id="outcome" name="outcome" class={INPUT_CLASS}>
              <option value="">Any outcome</option>
              <option value="success" selected={filters.outcome === "success"}>
                Success
              </option>
              <option value="failure" selected={filters.outcome === "failure"}>
                Failure
              </option>
            </select>
          </div>
          <button
            type="submit"
            class="px-4 py-2 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-medium rounded-lg hover:bg-gray-800 dark:hover:bg-gray-200 transition-colors whitespace-nowrap"
          >
            Apply
          </button>
          {filtered && (
            <a
              href="/dashboard/audit-log"
              class="px-4 py-2 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors whitespace-nowrap"
            >
              Clear
            </a>
          )}
        </form>
      </div>

      {events.length === 0 ? (
        <EmptyState
          message={
            filtered
              ? "No audit entries match the current filters."
              : "No audit entries yet."
          }
        />
      ) : (
        <>
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-gray-200 dark:border-gray-800">
                  <th class={TH_CLASS}>Time (UTC)</th>
                  <th class={TH_CLASS}>Actor</th>
                  <th class={TH_CLASS}>Action</th>
                  <th class={TH_CLASS}>Target</th>
                  <th class={TH_CLASS}>Outcome</th>
                  <th class={TH_CLASS}>Client</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-gray-100 dark:divide-gray-800">
                {events.map((event) => {
                  const target = targetText(event);
                  const details = metadataLines(event.metadata);
                  return (
                    <tr class="align-top hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors">
                      <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        <time
                          datetime={event.occurredAt.toISOString()}
                          title={event.occurredAt.toISOString()}
                          safe
                        >
                          {utcTime(event.occurredAt)}
                        </time>
                      </td>
                      <td class="px-4 py-3 text-gray-900 dark:text-gray-100">
                        <span class="break-all" safe>
                          {actorText(event)}
                        </span>
                        {event.actorId !== null && (
                          <span
                            class="block font-mono text-xs text-gray-400 dark:text-gray-500"
                            safe
                          >
                            {event.actorId}
                          </span>
                        )}
                      </td>
                      <td class="px-4 py-3 text-gray-700 dark:text-gray-300">
                        <span safe>
                          {isAuditAction(event.action)
                            ? AUDIT_ACTION_LABELS[event.action]
                            : event.action}
                        </span>
                        <span
                          class="block font-mono text-xs text-gray-400 dark:text-gray-500"
                          safe
                        >
                          {event.action}
                        </span>
                        {details.map((line) => (
                          <span
                            class="block text-xs text-gray-500 dark:text-gray-400 break-all"
                            safe
                          >
                            {line}
                          </span>
                        ))}
                      </td>
                      <td class="px-4 py-3 text-gray-700 dark:text-gray-300">
                        {target === null ? (
                          <span class="text-gray-400 dark:text-gray-600">n/a</span>
                        ) : (
                          <span class="break-all" safe>
                            {target}
                          </span>
                        )}
                        {event.targetId !== null && (
                          <span
                            class="block font-mono text-xs text-gray-400 dark:text-gray-500"
                            safe
                          >
                            {event.targetId}
                          </span>
                        )}
                      </td>
                      <td class="px-4 py-3">
                        <span
                          class={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            event.outcome === "success"
                              ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                              : "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"
                          }`}
                          safe
                        >
                          {event.outcome}
                        </span>
                      </td>
                      <td class="px-4 py-3 text-xs text-gray-500 dark:text-gray-400 max-w-xs">
                        <span class="block font-mono" safe>
                          {event.ip ?? "n/a"}
                        </span>
                        {event.userAgent !== null && (
                          <span class="block break-all" safe>
                            {event.userAgent}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Pagination
            page={page}
            limit={limit}
            total={total}
            baseUrl="/dashboard/audit-log"
            extraParams={extraParams}
          />
        </>
      )}
    </BaseLayout>
  );
}
