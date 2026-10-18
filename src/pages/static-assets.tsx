import { readFileSync } from "fs";
import { join } from "path";
import { config } from "../config.ts";
import { logger } from "../utils/logger.ts";

/**
 * The dashboard's own stylesheet and script (#255, part 2), served by
 * BunMail instead of the Tailwind CDN, so every page runs under a CSP
 * with `script-src 'self'` and no third-party code ever sees a token or
 * a password in the DOM.
 *
 * - `dashboard.css` is built from `assets/dashboard.input.css` by the
 *   Tailwind CLI (`bun run build:css`); the Docker image builds it.
 * - `dashboard.js` is hand-written browser JS (no build step): the theme
 *   toggle, confirm dialogs, bulk selection, chip inputs, time display
 *   and the email previews, wired by `data-*` attributes.
 *
 * Each URL carries `?v=<first 12 hex of its SHA-256>`, computed when the
 * process starts, so the files can be cached for a year (`immutable`)
 * and a deploy still reaches every browser at once. In development the
 * files are read again on every use, so `bun run dev:css` (the Tailwind
 * watcher) shows up on the next page load without a restart.
 *
 * A missing file (the CSS not built yet) is not fatal: the server starts,
 * logs a warning, and answers 404 for it; the pages render unstyled.
 */

/** Where the files live: next to this module, in `assets/`. */
const ASSETS_DIR = join(import.meta.dir, "assets");

/** The public URL prefix: the pages plugin mounts the routes under `/dashboard`. */
const ASSETS_PATH = "/dashboard/assets";

/** The served files and their content types. */
const CONTENT_TYPES = {
  "dashboard.css": "text/css; charset=utf-8",
  "dashboard.js": "text/javascript; charset=utf-8",
} as const;

/** Name of a served file. */
type AssetName = keyof typeof CONTENT_TYPES;

/** A served file as read from disk; `body` is null when it does not exist. */
interface LoadedAsset {
  body: Uint8Array | null;
  /** First 12 hex characters of the SHA-256 of `body`; empty when missing. */
  version: string;
}

/** One year, the longest lifetime browsers honour: the `?v=` hash busts it. */
const CACHE_CONTROL = "public, max-age=31536000, immutable";

/** Assets whose absence was already logged, so a development re-read does not repeat it. */
const reportedMissing = new Set<AssetName>();

/**
 * Reads one file and hashes it. Never throws: a missing file is logged
 * once (until it appears) and served as a 404.
 */
function loadAsset(name: AssetName): LoadedAsset {
  try {
    const body = new Uint8Array(readFileSync(join(ASSETS_DIR, name)));
    const version = new Bun.CryptoHasher("sha256")
      .update(body)
      .digest("hex")
      .slice(0, 12);
    reportedMissing.delete(name);
    return { body, version };
  } catch (error: unknown) {
    if (!reportedMissing.has(name)) {
      reportedMissing.add(name);
      const code =
        error instanceof Error && "code" in error ? String(error.code) : "unknown";
      logger.warn("Dashboard asset missing: pages render unstyled until it is built", {
        asset: name,
        code,
        hint: name === "dashboard.css" ? "run `bun run build:css`" : undefined,
      });
    }
    return { body: null, version: "" };
  }
}

/** Every file, read once at startup. */
const loaded: Record<AssetName, LoadedAsset> = {
  "dashboard.css": loadAsset("dashboard.css"),
  "dashboard.js": loadAsset("dashboard.js"),
};

/** The file as it should be served now: re-read in development, cached otherwise. */
function currentAsset(name: AssetName): LoadedAsset {
  if (config.env === "development") loaded[name] = loadAsset(name);
  return loaded[name];
}

/** The cache-busted URL of a served file, e.g. `/dashboard/assets/dashboard.css?v=1a2b3c4d5e6f`. */
function assetUrl(name: AssetName): string {
  const { version } = currentAsset(name);
  return version ? `${ASSETS_PATH}/${name}?v=${version}` : `${ASSETS_PATH}/${name}`;
}

/**
 * The response for `GET /dashboard/assets/<name>`: the file with its
 * content type and a one-year `immutable` cache (overriding the
 * dashboard's `no-store`, see `security-headers.ts`), or a plain 404 when
 * the file was not built.
 */
export function assetResponse(name: AssetName): Response {
  const { body } = currentAsset(name);
  if (!body) {
    return new Response("Not found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return new Response(body, {
    headers: { "content-type": CONTENT_TYPES[name], "cache-control": CACHE_CONTROL },
  });
}

/**
 * The `<head>` tags every page carries: the stylesheet, then the script.
 *
 * The script is loaded synchronously (no `defer`) on purpose: its first
 * lines put the `dark` class on `<html>` before the first paint, so a dark
 * theme never flashes white. Everything else in it waits for
 * `DOMContentLoaded`. One small file, cached for a year, so the blocking
 * fetch happens once.
 */
export function PageAssets() {
  return (
    <>
      <link rel="stylesheet" href={assetUrl("dashboard.css")} />
      <script src={assetUrl("dashboard.js")}></script>
    </>
  );
}
