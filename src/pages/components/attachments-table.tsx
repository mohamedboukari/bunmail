/**
 * Attachments table of an email detail page, outbound (#181) and inbound
 * (#486): name, type, size, inline Content-ID, and a download link. Every
 * value is escaped: the filename, type and Content-ID come from the
 * sender. The download is always a forced `attachment` (see the routes),
 * never rendered in the page.
 */

/** One row of the table. */
export interface AttachmentRow {
  /** 0-based position, the download key. */
  position: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
  /** Whether the bytes can still be downloaded; outbound drops them at a final state. */
  available: boolean;
}

interface AttachmentsTableProps {
  attachments: AttachmentRow[];
  /** The download URL of the attachment at `position`. */
  downloadHref: (position: number) => string;
}

/** A byte count for people: B, KB or MB (of 1,000), one decimal above 1 KB. */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Renders nothing when there are no attachments. */
export function AttachmentsTable({ attachments, downloadHref }: AttachmentsTableProps) {
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
                      href={downloadHref(attachment.position)}
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
