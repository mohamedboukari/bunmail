import { Html } from "@kitajs/html";
import { splitToList } from "../../modules/emails/services/recipient-limits.ts";

/**
 * The `to` recipients of an email in a list row (#178): the first address,
 * then `+N` for the others; the full list is in the tooltip and on the
 * detail page. Every address is escaped.
 */
export function RecipientSummary({ toAddress }: { toAddress: string }) {
  const [first = toAddress, ...others] = splitToList(toAddress);
  if (others.length === 0) return <span safe>{first}</span>;
  return (
    /** Attributes escape only `"`: the tooltip is escaped whole. */
    <span title={Html.escapeHtml(toAddress)}>
      <span safe>{first}</span>{" "}
      <span class="text-xs text-gray-500 dark:text-gray-400" safe>
        {`+${others.length}`}
      </span>
    </span>
  );
}
