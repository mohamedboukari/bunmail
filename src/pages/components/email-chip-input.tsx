/**
 * Email chip input: Gmail-style multi-recipient field. Users type an
 * address and press comma / space / Enter / Tab; the address validates,
 * turns into a removable chip, and the underlying hidden input is
 * updated with the comma-joined value so the parent form submits the
 * right thing. (#85)
 *
 * Markup only: the behaviour lives in the dashboard script
 * (`assets/dashboard.js`, "Email chip input"), which wires up every
 * `[data-chip-input]` on the page (CC + BCC share it): comma / space /
 * Enter / Tab commits a chip, Backspace on an empty input pops the last
 * one back, a pasted list is split, and blur or submit commits the
 * in-flight token. Invalid syntax flashes the border red.
 *
 * Server side, the hidden input carries the same `name` the original
 * comma-separated text input carried (e.g. `cc`, `bcc`). The backend
 * sees an identical payload, so no DTO / service changes are needed.
 *
 * No-JS fallback intentionally not supported. The dashboard already
 * requires JS for dark mode + HTML preview iframes; keeping markup
 * simple beats wiring a degraded path that nobody hits.
 */

interface EmailChipInputProps {
  /** Form field name: what the backend reads (`cc` / `bcc`). */
  name: string;
  /** DOM id used by an associated `<label for="…">`. */
  id?: string;
  /** Placeholder shown on the (still-empty) text input. */
  placeholder?: string;
  /**
   * Pre-filled addresses rendered as chips on load (e.g. an API key's
   * existing allowed-senders when editing, #126). Omit for an empty field
   * (the CC/BCC create-time usage). The script seeds its chip list from
   * the `data-chip-input-initial` attribute so the hidden input submits
   * the current set even if the user doesn't touch it.
   */
  initial?: string[];
}

export function EmailChipInput({ name, id, placeholder, initial }: EmailChipInputProps) {
  const initialValue = (initial ?? []).join(",");
  return (
    <div
      data-chip-input
      data-chip-input-initial={initialValue}
      class="w-full px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 focus-within:ring-2 focus-within:ring-gray-400 dark:focus-within:ring-gray-500 flex flex-wrap gap-1.5 items-center min-h-[38px] cursor-text"
    >
      {/**
       * Visible text input. No `name=`: the hidden input below is what
       * the form actually submits. JS prepends chip spans before this
       * input as the user adds addresses.
       */}
      <input
        type="text"
        id={id}
        data-chip-input-text
        placeholder={placeholder ?? "address@example.com"}
        class="flex-1 min-w-[120px] px-1 py-0.5 bg-transparent text-sm text-gray-900 dark:text-gray-100 focus:outline-hidden"
      />
      {/**
       * The hidden form field: its `value` is the comma-joined list of
       * chip addresses, kept in sync by the script on every chip add /
       * remove. Backend reads `body[name]` and parses comma-separated.
       */}
      <input type="hidden" name={name} value={initialValue} data-chip-input-hidden />
    </div>
  );
}
