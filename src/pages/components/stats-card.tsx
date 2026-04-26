/**
 * Props for the stat card component.
 */
interface StatsCardProps {
  /** Label shown above the value (e.g. "Total Emails") */
  label: string;
  /**
   * The numeric value to display. When `displayValue` is also provided,
   * it overrides the formatted number so callers can render percentages,
   * "—" for null, etc. without losing the locale-formatted default.
   */
  value: number;
  /** Optional preformatted display string (e.g. "98.4%", "—"). */
  displayValue?: string;
  /** Optional small caption rendered under the value (e.g. "last 24h"). */
  hint?: string;
  /** Optional accent color class for the left border (e.g. "border-emerald-500") */
  accent?: string;
}

/**
 * Stat card — displays a single metric on the dashboard home page.
 * Used in a grid to show overview stats (total emails, sent, failed, etc.)
 */
export function StatsCard({
  label,
  value,
  displayValue,
  hint,
  accent = "border-gray-300 dark:border-gray-700",
}: StatsCardProps) {
  return (
    <div
      class={`bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-5 border-l-4 ${accent}`}
    >
      <p class="text-sm text-gray-500 dark:text-gray-400" safe>
        {label}
      </p>
      <p class="text-2xl font-semibold mt-1" safe>
        {displayValue ?? value.toLocaleString()}
      </p>
      {hint && (
        <p class="text-xs text-gray-500 dark:text-gray-400 mt-1" safe>
          {hint}
        </p>
      )}
    </div>
  );
}
