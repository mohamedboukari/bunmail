import { BaseLayout } from "../layouts/base.tsx";
import { StatusBadge } from "../components/status-badge.tsx";
import { HtmlPreview } from "../components/html-preview.tsx";
import { TimeDisplay } from "../components/time-display.tsx";
import { BackArrowIcon } from "../assets/icons.tsx";
import type { Email } from "../../modules/emails/types/email.types.ts";
import type { AttachmentMeta } from "../../modules/emails/services/attachment-storage.ts";
import {
  serializeDeliveryState,
  type SerializedDeliveryGroup,
} from "../../modules/emails/serializations/delivery-state.serialization.ts";

interface EmailDetailPageProps {
  email: Email;
  /** When true, the email is in trash: show Restore + Delete forever instead of Trash. */
  isTrashed: boolean;
  /** Attachment metadata (#181), in order; empty when none. Never the bytes. */
  attachments: AttachmentMeta[];
}

/**
 * Email detail page: shows all fields of a single email.
 * Includes HTML preview, text content, full metadata, and a destructive
 * action button that varies based on whether the row is in trash.
 */
export function EmailDetailPage({ email, isTrashed, attachments }: EmailDetailPageProps) {
  const backHref = isTrashed ? "/dashboard/emails/trash" : "/dashboard/emails";
  const backLabel = isTrashed ? "Back to trash" : "Back to emails";

  return (
    <BaseLayout title={`Email ${email.id}`} activeNav="emails">
      {/* Back link */}
      <a
        href={backHref}
        class="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 inline-flex items-center gap-1 mb-4"
      >
        <BackArrowIcon />
        {backLabel}
      </a>

      {/* Header: title + status + destructive actions on the right */}
      <div class="flex items-center justify-between gap-3 mb-6">
        <div class="flex items-center gap-3 min-w-0">
          <h1 class="text-xl font-semibold truncate" safe>
            {email.subject}
          </h1>
          <StatusBadge status={email.status} />
          {isTrashed && (
            <span class="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
              In trash
            </span>
          )}
        </div>

        <div class="flex items-center gap-2 shrink-0">
          {isTrashed ? (
            <>
              <form
                method="POST"
                action={`/dashboard/emails/${email.id}/restore`}
                class="inline"
              >
                <button
                  type="submit"
                  class="px-3 py-1.5 rounded-md bg-gray-900 hover:bg-gray-800 text-white dark:bg-gray-100 dark:hover:bg-gray-200 dark:text-gray-900 text-sm font-medium"
                >
                  Restore
                </button>
              </form>
              <form
                method="POST"
                action={`/dashboard/emails/${email.id}/permanent`}
                class="inline"
                data-confirm="Permanently delete this email? This cannot be undone."
              >
                <button
                  type="submit"
                  class="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
                >
                  Delete forever
                </button>
              </form>
            </>
          ) : (
            <form
              method="POST"
              action={`/dashboard/emails/${email.id}/trash`}
              class="inline"
              data-confirm="Move this email to trash?"
            >
              <button
                type="submit"
                class="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium"
              >
                Move to trash
              </button>
            </form>
          )}
        </div>
      </div>

      {/* Details grid */}
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 mb-6">
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          <DetailField label="ID" value={email.id} />
          <DetailField label="Status" value={email.status} />
          <DetailField label="From" value={email.fromAddress} />
          <DetailField label="To" value={email.toAddress} />
          {!!email.cc && <DetailField label="CC" value={email.cc} />}
          {!!email.bcc && <DetailField label="BCC" value={email.bcc} />}
          {!!email.replyTo && <DetailField label="Reply-To" value={email.replyTo} />}
          <DetailField label="Attempts" value={String(email.attempts)} />
          {!!email.lastError && (
            <DetailField label="Last Error" value={email.lastError} />
          )}
          {!!email.messageId && (
            <DetailField label="Message ID" value={email.messageId} />
          )}
          {email.tags !== null && Object.keys(email.tags).length > 0 && (
            <div>
              <p class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5">
                Tags
              </p>
              {/* Each tag links to the list filtered by it (#189). */}
              <ul class="flex flex-wrap gap-1.5">
                {Object.entries(email.tags).map(([key, value]) => (
                  <li>
                    <a
                      href={`/dashboard/emails?tag=${encodeURIComponent(`${key}:${value}`)}`}
                      class="inline-block px-2 py-0.5 text-xs rounded bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200 break-all hover:underline"
                      safe
                    >
                      {`${key}: ${value}`}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5">
              Created
            </p>
            <p class="text-gray-900 dark:text-gray-100 break-all">
              <TimeDisplay value={email.createdAt} />
            </p>
          </div>
          {email.sentAt != null && (
            <div>
              <p class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5">
                Sent At
              </p>
              <p class="text-gray-900 dark:text-gray-100 break-all">
                <TimeDisplay value={email.sentAt} />
              </p>
            </div>
          )}
        </div>
      </div>

      <DeliveryTable groups={serializeDeliveryState(email.deliveryState)} />

      <AttachmentsTable emailId={email.id} attachments={attachments} />

      {/* HTML preview */}
      {!!email.html && (
        <div class="mb-6">
          <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
            HTML Preview
          </h2>
          <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 overflow-auto">
            <HtmlPreview html={email.html} title="Email HTML preview" />
          </div>
        </div>
      )}

      {/* Text content */}
      {!!email.textContent && (
        <div>
          <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
            Text Content
          </h2>
          <pre
            class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4 text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap"
            safe
          >
            {email.textContent}
          </pre>
        </div>
      )}
    </BaseLayout>
  );
}

/**
 * Detail field: label + value pair used in the details grid.
 */
function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p
        class="text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wide mb-0.5"
        safe
      >
        {label}
      </p>
      <p class="text-gray-900 dark:text-gray-100 break-all" safe>
        {value}
      </p>
    </div>
  );
}

/**
 * Per-MX delivery state (#250): one row per recipient domain, or per
 * recipient when signed return paths (#236) or a partial `RCPT TO`
 * rejection (#250) split the group, labelled with the MX host it ended on. Every value is escaped: the MX name comes from the
 * recipient domain's DNS and the error from the remote server. A session
 * that ran without TLS gets a visible badge, and one under the recipient
 * domain's MTA-STS policy a note.
 */
function DeliveryTable({ groups }: { groups: SerializedDeliveryGroup[] }) {
  if (groups.length === 0) return <></>;
  return (
    <div class="mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
        Delivery by MX
      </h2>
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
              <th class="px-4 py-2 font-medium">MX</th>
              <th class="px-4 py-2 font-medium">Recipients</th>
              <th class="px-4 py-2 font-medium">Status</th>
              <th class="px-4 py-2 font-medium">Attempts</th>
              <th class="px-4 py-2 font-medium">TLS</th>
              <th class="px-4 py-2 font-medium">Last error</th>
              <th class="px-4 py-2 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <tr class="border-b last:border-b-0 border-gray-100 dark:border-gray-800 align-top">
                <td class="px-4 py-2 break-all" safe>
                  {group.mx ?? "No MX found"}
                </td>
                <td class="px-4 py-2 break-all" safe>
                  {group.recipients.join(", ")}
                </td>
                <td class="px-4 py-2">
                  <StatusBadge status={group.status} />
                </td>
                <td class="px-4 py-2" safe>
                  {String(group.attempts)}
                </td>
                <td class="px-4 py-2">
                  <TlsBadge group={group} />
                </td>
                <td class="px-4 py-2 break-all text-gray-700 dark:text-gray-300">
                  {group.failureCode !== null && (
                    <code class="mr-1" safe>
                      {group.failureCode}
                    </code>
                  )}
                  <span safe>{group.lastError ?? ""}</span>
                </td>
                <td class="px-4 py-2 whitespace-nowrap">
                  <TimeDisplay value={isoDate(group.updatedAt)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The TLS cell: a warning badge for a plaintext session, else the recorded
 * value, then the MTA-STS note (#250) when the domain has a policy.
 */
function TlsBadge({ group }: { group: SerializedDeliveryGroup }) {
  return (
    <>
      {group.tls === "plaintext" ? (
        <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">
          {group.status === "sent" ? "Sent without TLS" : "No TLS"}
        </span>
      ) : (
        <span class="text-gray-600 dark:text-gray-400">
          {group.tls === "starttls" ? "STARTTLS" : "Unknown"}
        </span>
      )}
      <MtaStsNote mode={group.mtaSts} />
    </>
  );
}

/** The MTA-STS note under the TLS cell (#250): nothing without a policy. */
function MtaStsNote({ mode }: { mode: SerializedDeliveryGroup["mtaSts"] }) {
  if (mode === null) return <></>;
  return (
    <span class="block mt-1 text-xs text-gray-500 dark:text-gray-400">
      {mode === "enforce" ? "MTA-STS enforced" : "MTA-STS testing"}
    </span>
  );
}

/** A stored ISO timestamp as a Date, or null when absent or unreadable. */
function isoDate(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** A byte count for people: B, KB or MB (of 1,000), one decimal above 1 KB. */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Attachments (#181): name, type, size, inline Content-ID, and a download
 * link while the bytes are stored. Every value is escaped: the filename
 * and Content-ID come from the sender. The download is always a forced
 * `attachment` (see the route), never rendered in the page.
 */
function AttachmentsTable({
  emailId,
  attachments,
}: {
  emailId: string;
  attachments: AttachmentMeta[];
}) {
  if (attachments.length === 0) return <></>;
  return (
    <div class="mb-6">
      <h2 class="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">
        Attachments
      </h2>
      <div class="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
              <th class="px-4 py-2 font-medium">File</th>
              <th class="px-4 py-2 font-medium">Type</th>
              <th class="px-4 py-2 font-medium">Size</th>
              <th class="px-4 py-2 font-medium">Inline</th>
              <th class="px-4 py-2 font-medium">Download</th>
            </tr>
          </thead>
          <tbody>
            {attachments.map((attachment) => (
              <tr class="border-b last:border-b-0 border-gray-100 dark:border-gray-800 align-top">
                <td class="px-4 py-2 break-all" safe>
                  {attachment.filename}
                </td>
                <td class="px-4 py-2 break-all" safe>
                  {attachment.contentType}
                </td>
                <td class="px-4 py-2 whitespace-nowrap" safe>
                  {formatBytes(attachment.sizeBytes)}
                </td>
                <td class="px-4 py-2 break-all" safe>
                  {attachment.contentId === null ? "" : `cid:${attachment.contentId}`}
                </td>
                <td class="px-4 py-2 whitespace-nowrap">
                  {attachment.available ? (
                    <a
                      href={`/dashboard/emails/${encodeURIComponent(emailId)}/attachments/${attachment.position}`}
                      class="text-gray-900 dark:text-gray-100 underline"
                    >
                      Download
                    </a>
                  ) : (
                    <span class="text-gray-500 dark:text-gray-400">No longer stored</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
