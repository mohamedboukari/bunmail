import type { PropsWithChildren } from "@kitajs/html";

/**
 * The markup a passkey ceremony (#223) needs; `dashboard.js` does the
 * rest, bound by `data-passkey-*` attributes (no inline script, no `on*=`
 * attribute, so the CSP stays `script-src 'self'`):
 *
 * - `data-passkey="create" | "get"` on the wrapper, with
 *   `data-passkey-options` (where the options are fetched, a same-origin
 *   POST) inside;
 * - the start control: a `<button data-passkey-start>` (get), or a
 *   `<form data-passkey-start>` whose fields are posted with the options
 *   request (create: the name and the current password);
 * - `[data-passkey-error]`, where a refusal or a cancelled prompt is
 *   written (as text);
 * - `[data-passkey-unsupported]`, shown when the browser has no WebAuthn;
 * - `<form data-passkey-finish>` with a hidden `credential` input: the
 *   browser's result as JSON goes in it and the form is submitted, so the
 *   server answers with a normal redirect.
 */

/** Where a ceremony's options come from and where its result goes. */
interface CeremonyProps {
  mode: "create" | "get";
  /** The options endpoint (POST, answers JSON). */
  optionsUrl: string;
  /** The finish endpoint (POST form, answers a redirect). */
  finishUrl: string;
  /** Extra classes on the wrapper. */
  class?: string;
}

/** The wrapper, the error line, the unsupported note and the finish form around a start control. */
export function PasskeyCeremony({
  mode,
  optionsUrl,
  finishUrl,
  class: extraClass,
  children,
}: PropsWithChildren<CeremonyProps>) {
  return (
    <div data-passkey={mode} data-passkey-options={optionsUrl} class={extraClass}>
      {children}
      <p
        data-passkey-error
        role="alert"
        class="hidden text-sm text-red-700 dark:text-red-400 mt-2"
      ></p>
      <p
        data-passkey-unsupported
        class="hidden text-xs text-gray-500 dark:text-gray-400 mt-2"
      >
        This browser does not support passkeys.
      </p>
      <form method="POST" action={finishUrl} data-passkey-finish class="hidden">
        <input type="hidden" name="credential" value="" />
      </form>
    </div>
  );
}
