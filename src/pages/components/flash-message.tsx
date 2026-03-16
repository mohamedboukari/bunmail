/**
 * Props for the flash message component.
 */
interface FlashMessageProps {
  /** The message text to display */
  message: string;
  /** Type determines the color scheme: success (green) or error (red) */
  type: "success" | "error";
}

/**
 * Flash message — success/error banner shown after form actions.
 * Used to display feedback like "API key created" or "Invalid password".
 */
export function FlashMessage({ message, type }: FlashMessageProps) {
  const colors =
    type === "success"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800"
      : "bg-red-50 text-red-800 border-red-200 dark:bg-red-950 dark:text-red-200 dark:border-red-800";

  return (
    <div class={`rounded-lg border px-4 py-3 text-sm mb-4 ${colors}`}>{message}</div>
  );
}
