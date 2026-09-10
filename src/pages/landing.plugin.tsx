import { Elysia } from "elysia";
import { LandingPage } from "./routes/landing.tsx";

/**
 * Landing page plugin — serves the developer-focused home page at GET /.
 * Returns raw HTML via Response to avoid html() plugin conflicts.
 */
export const landingPlugin = new Elysia().get(
  "/",
  async () => {
    return new Response("<!doctype html>" + (await LandingPage()), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
  { detail: { hide: true } },
);
