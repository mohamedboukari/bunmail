import { encode } from "uqr";

/** Light modules around the code (the quiet zone the QR spec asks for: 4 modules). */
const QUIET_ZONE_MODULES = 4;

/**
 * A QR code as inline SVG, rendered on the server (#220): no script and no
 * image request, so it works under the dashboard's CSP and nothing
 * leaves the page.
 *
 * `uqr` (pinned, no dependencies) only computes the module matrix; the
 * SVG is built here from that matrix alone, so the markup is integers and
 * fixed strings: the encoded value (an `otpauth://` URI that carries the
 * TOTP secret) never appears in the page as text or in an attribute.
 * Dark modules on a white square, whatever the theme, as scanners expect.
 *
 * @param value - The text to encode. Never rendered.
 * @param label - Accessible name of the image (a fixed string).
 */
export function QrCode({ value, label }: { value: string; label: string }) {
  const { data, size } = encode(value, { ecc: "M", border: QUIET_ZONE_MODULES });
  let path = "";
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) path += `M${x},${y}h1v1h-1z`;
    });
  });
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${size} ${size}`}
      class="w-52 h-52 rounded"
      role="img"
      aria-label={label}
      shape-rendering="crispEdges"
    >
      <rect width={String(size)} height={String(size)} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
