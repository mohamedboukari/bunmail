/**
 * Email chip input — Gmail-style multi-recipient field. Users type an
 * address and press comma / space / Enter / Tab; the address validates,
 * turns into a removable chip, and the underlying hidden input is
 * updated with the comma-joined value so the parent form submits the
 * right thing. (#85)
 *
 * Markup-only on its own — the behaviour lives in {@link EmailChipInputScript}
 * which a parent page renders **once** alongside any number of inputs.
 * Multiple inputs on the same page (CC + BCC) reuse the single script.
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
  /** Form field name — what the backend reads (`cc` / `bcc`). */
  name: string;
  /** DOM id used by an associated `<label for="…">`. */
  id?: string;
  /** Placeholder shown on the (still-empty) text input. */
  placeholder?: string;
}

export function EmailChipInput({ name, id, placeholder }: EmailChipInputProps) {
  return (
    <div
      data-chip-input
      class="w-full px-2 py-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 focus-within:ring-2 focus-within:ring-gray-400 dark:focus-within:ring-gray-500 flex flex-wrap gap-1.5 items-center min-h-[38px] cursor-text"
    >
      {/**
       * Visible text input. No `name=` — the hidden input below is what
       * the form actually submits. JS prepends chip spans before this
       * input as the user adds addresses.
       */}
      <input
        type="text"
        id={id}
        data-chip-input-text
        placeholder={placeholder ?? "address@example.com"}
        class="flex-1 min-w-[120px] px-1 py-0.5 bg-transparent text-sm text-gray-900 dark:text-gray-100 focus:outline-none"
      />
      {/**
       * The hidden form field — its `value` is the comma-joined list of
       * chip addresses, kept in sync by the script on every chip add /
       * remove. Backend reads `body[name]` and parses comma-separated.
       */}
      <input type="hidden" name={name} data-chip-input-hidden />
    </div>
  );
}

/**
 * Single shared script block — wires up all `[data-chip-input]` widgets
 * on the page. Render once per page (e.g. just before `</form>`).
 *
 * Behaviour summary:
 * - Comma / space / Enter / Tab on the visible input → commits the
 *   typed token as a chip (if it parses as an email).
 * - Backspace on an *empty* input → pops the last chip back into the
 *   input as editable text. This matches Gmail's affordance for fixing
 *   typos without retyping.
 * - Paste of a comma- or whitespace-separated list → splits and adds
 *   each valid address as its own chip in one go.
 * - Blur with non-empty input → commits the in-flight token rather
 *   than silently dropping it on form submit.
 * - Invalid email syntax → input border turns red briefly; the chip
 *   isn't added. The regex here is intentionally loose (matches the
 *   shape `local@host.tld`, not the full RFC 5322 grammar) — anything
 *   that gets through here will still be re-validated by the server
 *   and nodemailer before going on the wire.
 */
export function EmailChipInputScript() {
  return (
    <script>
      {`
        (function() {
          var EMAIL_RE = /^[^\\s@,]+@[^\\s@,]+\\.[^\\s@,]+$/;

          function escapeHtml(s) {
            return String(s).replace(/[&<>"']/g, function(c) {
              return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[c];
            });
          }

          function initChipInput(wrapper) {
            var textInput = wrapper.querySelector('[data-chip-input-text]');
            var hiddenInput = wrapper.querySelector('[data-chip-input-hidden]');
            if (!textInput || !hiddenInput) return;

            /** Chip strings in insertion order; the hidden input is its join. */
            var chips = [];

            function syncHidden() {
              hiddenInput.value = chips.join(',');
            }

            function render() {
              /** Wipe existing chip elements (rebuild on every change —
               *  cheap, keeps the click-to-remove handlers fresh). */
              wrapper.querySelectorAll('.chip').forEach(function(c) { c.remove(); });
              chips.forEach(function(addr, idx) {
                var chip = document.createElement('span');
                chip.className = 'chip inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm rounded';
                chip.innerHTML =
                  '<span class="chip-text">' + escapeHtml(addr) + '</span>' +
                  '<button type="button" class="chip-remove text-gray-500 hover:text-red-600 dark:hover:text-red-400 leading-none" aria-label="Remove ' + escapeHtml(addr) + '">&times;</button>';
                chip.querySelector('.chip-remove').addEventListener('click', function() {
                  chips.splice(idx, 1);
                  syncHidden();
                  render();
                  textInput.focus();
                });
                wrapper.insertBefore(chip, textInput);
              });
              syncHidden();
            }

            function flashInvalid() {
              wrapper.classList.add('!border-red-500');
              setTimeout(function() {
                wrapper.classList.remove('!border-red-500');
              }, 800);
            }

            function tryAddCurrent() {
              var raw = textInput.value.trim().replace(/,+$/, '').trim();
              if (!raw) return true;
              if (!EMAIL_RE.test(raw)) {
                flashInvalid();
                return false;
              }
              if (chips.indexOf(raw) === -1) chips.push(raw);
              textInput.value = '';
              render();
              return true;
            }

            textInput.addEventListener('keydown', function(e) {
              if (e.key === ',' || e.key === ' ' || e.key === 'Enter' || e.key === 'Tab') {
                if (textInput.value.trim()) {
                  e.preventDefault();
                  tryAddCurrent();
                }
              } else if (e.key === 'Backspace' && textInput.value === '' && chips.length > 0) {
                /** Pop the last chip back into the input — feels like
                 *  editing the trailing token, not deleting it outright. */
                e.preventDefault();
                textInput.value = chips.pop();
                render();
              }
            });

            textInput.addEventListener('paste', function(e) {
              var text = (e.clipboardData || window.clipboardData).getData('text');
              if (/[,\\s]/.test(text)) {
                e.preventDefault();
                text.split(/[,\\s]+/).map(function(s) { return s.trim(); }).filter(Boolean).forEach(function(addr) {
                  if (EMAIL_RE.test(addr) && chips.indexOf(addr) === -1) chips.push(addr);
                });
                render();
              }
            });

            /** Commit any in-flight token on blur — otherwise a user who
             *  types an address then clicks Send would lose it. */
            textInput.addEventListener('blur', function() {
              if (textInput.value.trim()) tryAddCurrent();
            });

            /** Clicking anywhere in the wrapper focuses the input —
             *  the chip "field" should feel like a single tappable area. */
            wrapper.addEventListener('click', function(e) {
              if (e.target === wrapper) textInput.focus();
            });

            /** Belt-and-suspenders: on the parent form's submit, fold any
             *  in-flight token in. The blur handler usually catches it
             *  first, but Enter-to-submit can skip the blur. */
            var form = wrapper.closest('form');
            if (form) {
              form.addEventListener('submit', function() {
                if (textInput.value.trim()) tryAddCurrent();
              });
            }
          }

          document.querySelectorAll('[data-chip-input]').forEach(initChipInput);
        })();
      `}
    </script>
  );
}
