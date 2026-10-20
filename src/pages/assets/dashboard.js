/*
 * BunMail dashboard script (#255, part 2).
 *
 * Every page loads this one file from `/dashboard/assets/dashboard.js`
 * (`static-assets.tsx`), synchronously in `<head>`. The pages carry no
 * inline script and no `on*=` attribute, so the CSP can say
 * `script-src 'self'`: markup asks for behaviour with `data-*` attributes
 * and the listeners below pick it up.
 *
 * Plain browser JavaScript, served as written (no build step, no
 * modules). Keep every behaviour keyed on a `data-*` attribute, never on
 * a page.
 *
 *   data-action="toggle-theme"  button: switches light / dark, remembered in localStorage
 *   data-confirm="<message>"    button or link: asks before the click goes on;
 *                               form: asks before it submits
 *   data-navigate-on-change     select: opens the URL of the chosen option
 *   data-submit-once            on <body>: a submitted form's button is disabled (no double submit)
 *   data-bulk / -all / -row     bulk selection: a select-all box, row boxes, an action bar
 *   data-bulk-bar / -count      (with the count) shown while any row is checked
 *   data-chip-input             email chip input (`email-chip-input.tsx`)
 *   time[data-bm-time]          timestamps shown in the viewer's locale (`time-display.tsx`)
 *   iframe.html-preview-frame   email HTML preview (`html-preview.tsx`)
 *   iframe.live-html-preview-frame  template preview following a textarea
 *   data-passkey="create|get"   a passkey ceremony (`passkey-ceremony.tsx`, #223)
 */
(function () {
  "use strict";

  /* ─── Theme: runs now, before the first paint ─── */

  /*
   * The dark class goes on <html> before the body is parsed, so a dark
   * theme never flashes white. An explicit choice wins; otherwise the
   * system preference decides.
   */
  (function () {
    var theme = null;
    try {
      theme = localStorage.getItem("bm-theme");
    } catch {
      /* Storage blocked: fall back to the system preference. */
    }
    if (
      theme === "dark" ||
      (!theme && window.matchMedia("(prefers-color-scheme: dark)").matches)
    ) {
      document.documentElement.classList.add("dark");
    }
  })();

  /** Flips the theme and remembers the choice. */
  function toggleTheme() {
    var dark = document.documentElement.classList.toggle("dark");
    try {
      localStorage.setItem("bm-theme", dark ? "dark" : "light");
    } catch {
      /* Storage blocked: the choice lasts for this page only. */
    }
  }

  /* ─── Delegated listeners (the document exists already) ─── */

  /*
   * Registered in this order on purpose: the confirm check runs before
   * the double-submit guard, so a cancelled submit never leaves its
   * button disabled.
   */
  document.addEventListener("click", function (e) {
    var target = e.target instanceof Element ? e.target : null;
    if (!target) return;

    var toggle = target.closest('[data-action="toggle-theme"]');
    if (toggle) {
      toggleTheme();
      return;
    }

    /* A button or link asking first; a form's own prompt is handled on submit. */
    var asking = target.closest("[data-confirm]");
    if (asking && asking.tagName !== "FORM") {
      if (!window.confirm(asking.getAttribute("data-confirm") || "")) e.preventDefault();
    }
  });

  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.hasAttribute("data-confirm")) {
      if (!window.confirm(form.getAttribute("data-confirm") || "")) e.preventDefault();
    }
  });

  /*
   * Passkey ceremonies (#223): a `form[data-passkey-start]` (adding a
   * passkey: name and password) is sent to the options endpoint instead of
   * submitting. Registered before the double-submit guard, which then
   * sees the submit cancelled and leaves the button alone.
   */
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || e.defaultPrevented) return;
    if (!form.hasAttribute("data-passkey-start")) return;
    var scope = form.closest("[data-passkey]");
    if (!scope) return;
    e.preventDefault();
    runPasskey(scope, new URLSearchParams(new FormData(form)), form);
  });

  document.addEventListener("click", function (e) {
    var target = e.target instanceof Element ? e.target : null;
    var start = target ? target.closest("button[data-passkey-start]") : null;
    if (!start) return;
    var scope = start.closest("[data-passkey]");
    if (!scope) return;
    e.preventDefault();
    runPasskey(scope, new URLSearchParams(), start);
  });

  /* Prevent double form submissions: disables the button and shows "Processing…". */
  document.addEventListener("submit", function (e) {
    var form = e.target;
    if (!(form instanceof HTMLFormElement) || e.defaultPrevented) return;
    if (!form.closest("[data-submit-once]")) return;
    var btn = form.querySelector('button[type="submit"]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    btn.dataset.originalText = btn.textContent;
    btn.textContent = "Processing…";
    btn.classList.add("opacity-60", "cursor-not-allowed");
  });

  document.addEventListener("change", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    /*
     * A filter dropdown: each option's value is the URL to open. Only a
     * same-origin http(s) URL is followed, never another site or a
     * `javascript:` URL, whatever ends up in an option value.
     */
    if (
      target instanceof HTMLSelectElement &&
      target.hasAttribute("data-navigate-on-change")
    ) {
      var next = new URL(target.value, window.location.href);
      if (
        next.origin === window.location.origin &&
        (next.protocol === "http:" || next.protocol === "https:")
      ) {
        window.location.assign(next.href);
      }
      return;
    }

    /* Bulk selection: the select-all box sets every row, a row box refreshes the bar. */
    var scope = target.closest("[data-bulk]");
    if (!scope || !(target instanceof HTMLInputElement)) return;
    if (target.hasAttribute("data-bulk-all")) {
      bulkRows(scope).forEach(function (c) {
        c.checked = target.checked;
      });
      refreshBulk(scope);
    } else if (target.hasAttribute("data-bulk-row")) {
      refreshBulk(scope);
    }
  });

  /** The row checkboxes of one bulk-selection form. */
  function bulkRows(scope) {
    return Array.from(scope.querySelectorAll("[data-bulk-row]"));
  }

  /** Shows the action bar while any row is checked, with the count, and syncs select-all. */
  function refreshBulk(scope) {
    var rows = bulkRows(scope);
    var checked = rows.filter(function (c) {
      return c.checked;
    });
    var count = scope.querySelector("[data-bulk-count]");
    var bar = scope.querySelector("[data-bulk-bar]");
    var selectAll = scope.querySelector("[data-bulk-all]");
    if (count) count.textContent = String(checked.length);
    if (bar) bar.classList.toggle("hidden", checked.length === 0);
    if (selectAll) {
      selectAll.checked = checked.length > 0 && checked.length === rows.length;
    }
  }

  /* ─── Once the page is parsed ─── */

  function onReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  onReady(function () {
    markPasskeySupport();
    hydrateTimes();
    document.querySelectorAll("[data-chip-input]").forEach(initChipInput);
    initHtmlPreviews();
    initLiveHtmlPreviews();
  });

  /* ─── Passkeys (#223) ─── */

  /*
   * The browser half of a WebAuthn ceremony, without a library: fetch the
   * options (a same-origin POST; the session guard and the public routes
   * check the Origin header), turn their base64url fields into buffers,
   * call navigator.credentials.create / get, turn the result back into
   * base64url JSON and submit it in the hidden finish form, so the server
   * answers with a normal redirect. Messages are written as text, never
   * as HTML.
   */

  /** WebAuthn is available in this browser (and this is a secure context). */
  function passkeysSupported() {
    return (
      typeof window.PublicKeyCredential === "function" &&
      !!navigator.credentials &&
      typeof navigator.credentials.create === "function" &&
      typeof navigator.credentials.get === "function"
    );
  }

  /** Shows the "not supported" note of every ceremony when WebAuthn is missing. */
  function markPasskeySupport() {
    if (passkeysSupported()) return;
    document.querySelectorAll("[data-passkey-unsupported]").forEach(function (el) {
      el.classList.remove("hidden");
    });
  }

  function base64urlToBuffer(value) {
    var base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
    while (base64.length % 4) base64 += "=";
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  function bufferToBase64url(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = "";
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  /** A credential descriptor list with its ids as buffers. */
  function descriptors(list) {
    return (list || []).map(function (c) {
      return { type: c.type, id: base64urlToBuffer(c.id), transports: c.transports };
    });
  }

  /** Creation options (JSON from the server) as `navigator.credentials.create` wants them. */
  function creationOptions(o) {
    return {
      challenge: base64urlToBuffer(o.challenge),
      rp: o.rp,
      user: {
        id: base64urlToBuffer(o.user.id),
        name: o.user.name,
        displayName: o.user.displayName,
      },
      pubKeyCredParams: o.pubKeyCredParams,
      timeout: o.timeout,
      attestation: o.attestation,
      authenticatorSelection: o.authenticatorSelection,
      excludeCredentials: descriptors(o.excludeCredentials),
      extensions: o.extensions,
    };
  }

  /** Request options (JSON from the server) as `navigator.credentials.get` wants them. */
  function requestOptions(o) {
    var options = {
      challenge: base64urlToBuffer(o.challenge),
      rpId: o.rpId,
      timeout: o.timeout,
      userVerification: o.userVerification,
      extensions: o.extensions,
    };
    if (o.allowCredentials && o.allowCredentials.length > 0) {
      options.allowCredentials = descriptors(o.allowCredentials);
    }
    return options;
  }

  /** The browser's result as the JSON the server parses. */
  function credentialToJSON(credential) {
    var r = credential.response;
    var response = { clientDataJSON: bufferToBase64url(r.clientDataJSON) };
    if (r.attestationObject) {
      response.attestationObject = bufferToBase64url(r.attestationObject);
      if (typeof r.getTransports === "function") response.transports = r.getTransports();
    }
    if (r.authenticatorData) {
      response.authenticatorData = bufferToBase64url(r.authenticatorData);
      response.signature = bufferToBase64url(r.signature);
      if (r.userHandle) response.userHandle = bufferToBase64url(r.userHandle);
    }
    return {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: response,
      clientExtensionResults: {},
    };
  }

  /** Writes a message (as text) in the ceremony's error line, or hides it. */
  function showPasskeyError(scope, message) {
    var line = scope.querySelector("[data-passkey-error]");
    if (!line) return;
    line.textContent = message || "";
    line.classList.toggle("hidden", !message);
  }

  /** What to tell the user when the browser's prompt fails. */
  function promptErrorMessage(error, mode) {
    var name = error && error.name;
    if (name === "NotAllowedError" || name === "AbortError") {
      return "The passkey prompt was closed or timed out. Try again.";
    }
    if (name === "InvalidStateError" && mode === "create") {
      return "This passkey is already registered.";
    }
    return "The passkey could not be used. Try again.";
  }

  /** Runs one ceremony: options, the browser prompt, then the finish form. */
  function runPasskey(scope, params, control) {
    var mode = scope.getAttribute("data-passkey");
    var optionsUrl = new URL(
      scope.getAttribute("data-passkey-options") || "",
      window.location.href,
    );
    var finish = scope.querySelector("form[data-passkey-finish]");
    var field = finish ? finish.querySelector('input[name="credential"]') : null;
    if (!passkeysSupported()) {
      showPasskeyError(scope, "This browser does not support passkeys.");
      return;
    }
    if (optionsUrl.origin !== window.location.origin || !finish || !field) return;
    if (mode !== "create" && mode !== "get") return;
    var buttons =
      control.tagName === "FORM" ? control.querySelectorAll("button") : [control];
    function busy(on) {
      Array.prototype.forEach.call(buttons, function (b) {
        b.disabled = on;
      });
    }
    showPasskeyError(scope, "");
    busy(true);

    fetch(optionsUrl.href, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: params.toString(),
    })
      .then(function (res) {
        return res.json().then(
          function (data) {
            return { ok: res.ok, data: data };
          },
          function () {
            return { ok: false, data: {} };
          },
        );
      })
      .then(function (answer) {
        var data = answer.data || {};
        if (typeof data.redirect === "string" && data.redirect.charAt(0) === "/") {
          window.location.assign(data.redirect);
          return null;
        }
        if (!answer.ok || !data.options) {
          var refused = new Error(data.error || "Something went wrong. Try again.");
          refused.name = "ServerRefused";
          throw refused;
        }
        return mode === "create"
          ? navigator.credentials.create({ publicKey: creationOptions(data.options) })
          : navigator.credentials.get({ publicKey: requestOptions(data.options) });
      })
      .then(function (credential) {
        if (!credential) return;
        field.value = JSON.stringify(credentialToJSON(credential));
        finish.submit();
      })
      .catch(function (error) {
        busy(false);
        showPasskeyError(
          scope,
          error && error.name === "ServerRefused"
            ? error.message
            : promptErrorMessage(error, mode),
        );
      });
  }

  /* ─── Time display (#104) ─── */

  /*
   * Rewrites every <time data-bm-time> into a relative phrase ("5m ago",
   * "Yesterday 14:32", "Jan 5, 14:32") in the viewer's locale and
   * timezone; the title carries the full absolute timestamp. The server
   * rendered a UTC fallback, kept when formatting fails.
   */
  function fmtAbsolute(d, now, withYear) {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      year: withYear ? "numeric" : undefined,
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
  function fmtTime(d) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
  function fmtTooltip(d) {
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    }).format(d);
  }
  function relative(d, now) {
    var diffMs = now.getTime() - d.getTime();
    /* Future dates: skip relative, show absolute. */
    if (diffMs < 0) {
      return fmtAbsolute(d, now, d.getFullYear() !== now.getFullYear());
    }
    var diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    var diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin + "m ago";
    var diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr + "h ago";
    var diffDay = Math.floor(diffHr / 24);
    if (diffDay === 1) return "Yesterday " + fmtTime(d);
    if (diffDay < 7) {
      return new Intl.DateTimeFormat(undefined, {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      }).format(d);
    }
    return fmtAbsolute(d, now, d.getFullYear() !== now.getFullYear());
  }
  function hydrateTimes() {
    var now = new Date();
    document.querySelectorAll("time[data-bm-time]").forEach(function (el) {
      var iso = el.getAttribute("datetime");
      if (!iso) return;
      var d = new Date(iso);
      if (isNaN(d.getTime())) return;
      try {
        el.textContent = relative(d, now);
        el.setAttribute("title", fmtTooltip(d));
      } catch {
        /* Locale failure: leave the server fallback. */
      }
    });
  }
  /* Re-runnable if a future page injects new <time data-bm-time> elements. */
  window.bmHydrateTimes = hydrateTimes;

  /* ─── Email chip input (#85) ─── */

  /*
   * Gmail-style multi-recipient field. Comma / space / Enter / Tab
   * commits the typed address as a chip; Backspace on an empty input
   * pops the last chip back for editing; a pasted list is split into
   * chips; blur and submit commit the in-flight token. The hidden input
   * carries the comma-joined list. The regex is intentionally loose: the
   * server validates again.
   */
  var EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c];
    });
  }

  function initChipInput(wrapper) {
    var textInput = wrapper.querySelector("[data-chip-input-text]");
    var hiddenInput = wrapper.querySelector("[data-chip-input-hidden]");
    if (!textInput || !hiddenInput) return;

    /* Chip strings in insertion order; the hidden input is their join. */
    var chips = [];

    /* Seed from pre-filled initial values (edit mode, #126). */
    var initialAttr = wrapper.getAttribute("data-chip-input-initial") || "";
    if (initialAttr) {
      initialAttr
        .split(",")
        .map(function (s) {
          return s.trim();
        })
        .filter(Boolean)
        .forEach(function (addr) {
          if (chips.indexOf(addr) === -1) chips.push(addr);
        });
    }

    function syncHidden() {
      hiddenInput.value = chips.join(",");
    }

    function render() {
      /* Rebuild every chip on each change: cheap, keeps the remove handlers fresh. */
      wrapper.querySelectorAll(".chip").forEach(function (c) {
        c.remove();
      });
      chips.forEach(function (addr, idx) {
        var chip = document.createElement("span");
        chip.className =
          "chip inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100 text-sm rounded";
        chip.innerHTML =
          '<span class="chip-text">' +
          escapeHtml(addr) +
          "</span>" +
          '<button type="button" class="chip-remove text-gray-500 hover:text-red-600 dark:hover:text-red-400 leading-none" aria-label="Remove ' +
          escapeHtml(addr) +
          '">&times;</button>';
        chip.querySelector(".chip-remove").addEventListener("click", function () {
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
      wrapper.classList.add("border-red-500!");
      setTimeout(function () {
        wrapper.classList.remove("border-red-500!");
      }, 800);
    }

    function tryAddCurrent() {
      var raw = textInput.value.trim().replace(/,+$/, "").trim();
      if (!raw) return true;
      if (!EMAIL_RE.test(raw)) {
        flashInvalid();
        return false;
      }
      if (chips.indexOf(raw) === -1) chips.push(raw);
      textInput.value = "";
      render();
      return true;
    }

    textInput.addEventListener("keydown", function (e) {
      if (e.key === "," || e.key === " " || e.key === "Enter" || e.key === "Tab") {
        if (textInput.value.trim()) {
          e.preventDefault();
          tryAddCurrent();
        }
      } else if (e.key === "Backspace" && textInput.value === "" && chips.length > 0) {
        /* Pop the last chip back into the input: editing the token, not deleting it. */
        e.preventDefault();
        textInput.value = chips.pop();
        render();
      }
    });

    textInput.addEventListener("paste", function (e) {
      var text = (e.clipboardData || window.clipboardData).getData("text");
      if (/[,\s]/.test(text)) {
        e.preventDefault();
        text
          .split(/[,\s]+/)
          .map(function (s) {
            return s.trim();
          })
          .filter(Boolean)
          .forEach(function (addr) {
            if (EMAIL_RE.test(addr) && chips.indexOf(addr) === -1) chips.push(addr);
          });
        render();
      }
    });

    /* Commit an in-flight token on blur, or typing an address then clicking Send loses it. */
    textInput.addEventListener("blur", function () {
      if (textInput.value.trim()) tryAddCurrent();
    });

    /* Clicking anywhere in the wrapper focuses the input: one tappable field. */
    wrapper.addEventListener("click", function (e) {
      if (e.target === wrapper) textInput.focus();
    });

    /* Fold an in-flight token in on submit: Enter-to-submit can skip the blur. */
    var form = wrapper.closest("form");
    if (form) {
      form.addEventListener("submit", function () {
        if (textInput.value.trim()) tryAddCurrent();
      });
    }

    /* Paint any seeded initial chips (edit mode). */
    if (chips.length > 0) render();
  }

  /* ─── Email HTML previews ─── */

  /*
   * The previews are `srcdoc` iframes with `sandbox="allow-same-origin"`
   * (no scripts inside), so this page can reach their documents: it sets
   * `data-theme` on the preview's <html> to follow the dashboard theme
   * and sizes each iframe to its content.
   */
  function isDark() {
    return document.documentElement.classList.contains("dark");
  }
  function applyTheme(iframe) {
    try {
      var doc = iframe.contentDocument;
      if (doc && doc.documentElement) {
        doc.documentElement.setAttribute("data-theme", isDark() ? "dark" : "light");
      }
    } catch {
      /* Not reachable: leave it in its default (light) look. */
    }
  }
  function resize(iframe) {
    try {
      var doc = iframe.contentDocument;
      if (doc && doc.body) iframe.style.height = doc.body.scrollHeight + "px";
    } catch {
      /* Not reachable: keep the min-height. */
    }
  }
  /** Calls `fn` on every theme switch (the `class` of <html> changing). */
  function onThemeChange(fn) {
    new MutationObserver(function (mutations) {
      mutations.forEach(function (m) {
        if (m.attributeName === "class") fn();
      });
    }).observe(document.documentElement, { attributes: true });
  }

  /* Static previews (email and inbound detail pages). */
  function initHtmlPreviews() {
    var frames = Array.from(document.querySelectorAll("iframe.html-preview-frame"));
    if (frames.length === 0) return;
    function syncAll() {
      frames.forEach(applyTheme);
    }
    frames.forEach(function (iframe) {
      iframe.addEventListener("load", function () {
        setTimeout(function () {
          applyTheme(iframe);
          resize(iframe);
        }, 50);
      });
    });
    /*
     * A preview can finish loading before this runs (the script waits for
     * the whole page to be parsed), so sync and size everything once more
     * when the page has loaded.
     */
    window.addEventListener("load", function () {
      setTimeout(function () {
        syncAll();
        frames.forEach(resize);
      }, 100);
    });
    onThemeChange(syncAll);
  }

  /*
   * Live template previews: the iframe follows its `<textarea>` (named by
   * `data-source`), with `{{variable}}` placeholders filled from sample
   * values. The style block and the samples come from the server
   * (`<script type="application/json" id="bm-live-preview-data">`), so
   * the client renders exactly what the server's first paint did.
   */
  function initLiveHtmlPreviews() {
    var frames = Array.from(document.querySelectorAll("iframe.live-html-preview-frame"));
    var dataEl = document.getElementById("bm-live-preview-data");
    if (frames.length === 0 || !dataEl) return;
    var data;
    try {
      data = JSON.parse(dataEl.textContent || "");
    } catch {
      return;
    }
    var STYLE = data.style;
    var SAMPLES = data.samples;

    /* Mirrors renderPreviewSamples() in html-preview.tsx and renderTemplate()'s {{\w+}} matcher. */
    function substitute(html) {
      return html.replace(
        /\{\{\{(\w+)\}\}\}|\{\{(\w+)\}\}/g,
        function (match, rawKey, key) {
          var name = rawKey || key;
          return Object.prototype.hasOwnProperty.call(SAMPLES, name)
            ? SAMPLES[name]
            : name;
        },
      );
    }
    function wrap(html) {
      return (
        '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
        STYLE +
        "</head><body>" +
        html +
        "</body></html>"
      );
    }

    frames.forEach(function (iframe) {
      var sourceId = iframe.getAttribute("data-source");
      var source = sourceId ? document.getElementById(sourceId) : null;
      if (!source) return;

      var timer = null;
      function render() {
        iframe.srcdoc = wrap(substitute(source.value || ""));
      }
      /* Re-sync theme and height each time the (re)loaded srcdoc is ready. */
      iframe.addEventListener("load", function () {
        setTimeout(function () {
          applyTheme(iframe);
          resize(iframe);
        }, 30);
      });
      source.addEventListener("input", function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(render, 150);
      });
      /* The first paint is server-rendered: adopt the current theme and size. */
      applyTheme(iframe);
      resize(iframe);
    });

    onThemeChange(function () {
      frames.forEach(applyTheme);
    });
  }
})();
