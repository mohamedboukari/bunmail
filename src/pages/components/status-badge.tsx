/**
 * Status badge — colored pill for email status.
 * Uses muted colors that work well in both light and dark mode.
 */
export function StatusBadge({ status }: { status: string }) {
  /** Map each status to its Tailwind color classes */
  const colors: Record<string, string> = {
    sent: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    queued: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    sending: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    failed: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  };

  const colorClass = colors[status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";

  return (
    <span class={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass}`}>
      {status}
    </span>
  );
}

/**
 * Verification badge — shows verified/not verified status for DNS records.
 * Used on the domains page and domain detail view.
 */
export function VerificationBadge({ verified, label }: { verified: boolean; label: string }) {
  if (verified) {
    return (
      <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clip-rule="evenodd" />
        </svg>
        {label}
      </span>
    );
  }

  return (
    <span class="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
      <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20">
        <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
      </svg>
      {label}
    </span>
  );
}
