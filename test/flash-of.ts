import { toFlash, type FlashBanner } from "../src/pages/lib/flash.ts";

/**
 * The banner a redirect leads to (#421): the `flash` code and `flashN`
 * number of its `Location`, resolved exactly as the next page resolves
 * them. `undefined` when the location carries no known code. Tests assert
 * on the message the user sees, not on the code in the URL.
 */
export function flashOfLocation(location: string | null): FlashBanner | undefined {
  const params = new URL(location ?? "", "http://localhost").searchParams;
  return toFlash(params.get("flash") ?? undefined, params.get("flashN") ?? undefined);
}

/** {@link flashOfLocation} for a redirect response. */
export function flashOfResponse(response: Response): FlashBanner | undefined {
  return flashOfLocation(response.headers.get("location"));
}
