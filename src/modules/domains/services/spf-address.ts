import { isIPv4, isIPv6 } from "net";

/**
 * IP address helpers of the SPF evaluator (#373): parsing to bytes, CIDR
 * matching, and the reverse and nibble forms SPF needs (RFC 7208 5.5, 5.6
 * and 7.3). Done by hand on bytes, no `net.BlockList`.
 */

/** An IP address as its network-order bytes (4 for IPv4, 16 for IPv6). */
export interface IpAddress {
  family: 4 | 6;
  bytes: Uint8Array;
}

/** The bytes of an IPv6 address `isIPv6` accepted (no zone index). */
function ipv6Bytes(text: string): Uint8Array {
  let value = text;
  /** A trailing dotted quad (`::ffff:192.0.2.1`) becomes two hex groups. */
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    value = `${value.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(":") : [];
  const zeros = Array.from({ length: 8 - left.length - right.length }, () => "0");
  const groups = halves.length > 1 ? [...left, ...zeros, ...right] : left;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const word = Number.parseInt(group, 16);
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

/** Parses an IPv4 or IPv6 address, `null` when it is neither (a zone index is refused). */
export function parseIp(text: string): IpAddress | null {
  if (isIPv4(text)) {
    return { family: 4, bytes: Uint8Array.from(text.split(".").map(Number)) };
  }
  if (text.includes("%") || !isIPv6(text)) return null;
  return { family: 6, bytes: ipv6Bytes(text) };
}

/**
 * The client address as SPF sees it: an IPv4-mapped IPv6 address
 * (`::ffff:0:0/96`, dotted or hex form) is the IPv4 address (RFC 7208 5),
 * so it matches `ip4` terms and `A` records, never `ip6` terms.
 */
export function clientAddress(text: string): IpAddress | null {
  const address = parseIp(text.trim());
  if (!address || address.family === 4) return address;
  const mapped =
    address.bytes.subarray(0, 10).every((byte) => byte === 0) &&
    address.bytes[10] === 0xff &&
    address.bytes[11] === 0xff;
  return mapped ? { family: 4, bytes: address.bytes.slice(12) } : address;
}

/** Whether `address` lies in `network/prefix` (same family only). */
export function inNetwork(
  address: IpAddress,
  network: IpAddress,
  prefix: number,
): boolean {
  if (address.family !== network.family) return false;
  const whole = Math.floor(prefix / 8);
  for (let i = 0; i < whole; i++) {
    if (address.bytes[i] !== network.bytes[i]) return false;
  }
  const bits = prefix % 8;
  if (bits === 0) return true;
  const mask = (0xff << (8 - bits)) & 0xff;
  return ((address.bytes[whole] ?? 0) & mask) === ((network.bytes[whole] ?? 0) & mask);
}

/** The address's nibbles, most significant first, in lowercase hex. */
function nibbles(address: IpAddress): string[] {
  return Array.from(address.bytes).flatMap((byte) => [
    (byte >> 4).toString(16),
    (byte & 0xf).toString(16),
  ]);
}

/** The PTR query name: `4.3.2.1.in-addr.arpa`, or the reversed nibbles under `ip6.arpa`. */
export function reverseName(address: IpAddress): string {
  if (address.family === 4)
    return `${Array.from(address.bytes).toReversed().join(".")}.in-addr.arpa`;
  return `${nibbles(address).toReversed().join(".")}.ip6.arpa`;
}

/**
 * The `%{i}` macro value (RFC 7208 7.3): the dotted quad for IPv4, the
 * 32 nibbles separated by dots for IPv6.
 */
export function macroIp(address: IpAddress): string {
  return address.family === 4
    ? Array.from(address.bytes).join(".")
    : nibbles(address).join(".");
}
