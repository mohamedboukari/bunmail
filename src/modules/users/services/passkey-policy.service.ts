import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { RelyingParty } from "../types/user.types.ts";

/**
 * Passkey (WebAuthn, #223) rules that need no I/O: the relying party
 * derived from `APP_BASE_URL`, the name policy, the signature counter
 * rule, the transports allowlist, and the parsing of a browser's
 * credential JSON into the shapes `@simplewebauthn/server` verifies.
 * Pure: no config, no database (the callers pass `config.appBaseUrl` in).
 */

/** Longest passkey name, in characters. */
export const PASSKEY_NAME_MAX_LENGTH = 64;

/** How long a challenge stays usable: 5 minutes. */
export const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * How long the browser may take for a ceremony, in milliseconds (the
 * `timeout` hint in the options): a little under the challenge TTL.
 */
export const PASSKEY_CEREMONY_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * Longest credential JSON a finish form may post, in characters: a
 * generous bound (attestation objects of real authenticators are a few
 * kilobytes) that still keeps parsing cheap.
 */
export const PASSKEY_RESPONSE_MAX_LENGTH = 64 * 1024;

/** The relying party name browsers show in the passkey prompt. */
export const PASSKEY_RP_NAME = "BunMail";

/**
 * The relying party passkeys are bound to, from `APP_BASE_URL`: the RP ID
 * is its hostname, the expected origin its origin (scheme, host, port),
 * matched exactly. `null` (passkeys disabled) when the value is empty,
 * not a URL, not `http(s)`, or plain `http://` on anything but
 * `localhost` (browsers allow WebAuthn only in a secure context).
 */
export function relyingPartyFrom(appBaseUrl: string): RelyingParty | null {
  const trimmed = appBaseUrl.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.protocol === "http:" && url.hostname !== "localhost") return null;
  if (url.hostname === "") return null;
  return { rpID: url.hostname, origin: url.origin };
}

/**
 * Why a passkey name is not acceptable, or `null`. The name is trimmed by
 * the caller; it must be 1 to 64 characters with no control characters.
 * It is rendered escaped, never trusted.
 */
export function passkeyNameProblem(name: string): string | null {
  if (name.length === 0) return "Give the passkey a name.";
  /** UTF-16 units, as the form's `maxlength` counts them. */
  if (name.length > PASSKEY_NAME_MAX_LENGTH) {
    return `The name can be at most ${PASSKEY_NAME_MAX_LENGTH} characters.`;
  }
  if (/\p{Cc}/u.test(name)) return "The name cannot contain control characters.";
  return null;
}

/**
 * The clone-detection rule (WebAuthn, "signature counter"): when either
 * the stored or the received counter is non-zero, the received one must
 * be greater, or the assertion is refused as a possible cloned
 * authenticator. Authenticators whose counter stays 0 (many platform
 * passkeys, which sync between devices) are allowed.
 */
export function counterRegressed(stored: number, received: number): boolean {
  return (stored > 0 || received > 0) && received <= stored;
}

/** Transports a browser may report (WebAuthn Level 3); anything else is dropped. */
const KNOWN_TRANSPORTS = [
  "ble",
  "cable",
  "hybrid",
  "internal",
  "nfc",
  "smart-card",
  "usb",
] as const;

/** A transport an authenticator may report. */
type PasskeyTransport = (typeof KNOWN_TRANSPORTS)[number];

/** Narrows a value to a known transport. */
function isKnownTransport(value: unknown): value is PasskeyTransport {
  return KNOWN_TRANSPORTS.some((known) => known === value);
}

/** The known transports of a list, deduplicated, in a stable order. */
function knownTransports(values: readonly unknown[]): PasskeyTransport[] {
  return KNOWN_TRANSPORTS.filter((known) => values.includes(known));
}

/** The transports column value: known values joined by commas, or null. */
export function transportsToColumn(
  values: readonly unknown[] | undefined,
): string | null {
  const list = knownTransports(values ?? []);
  return list.length === 0 ? null : list.join(",");
}

/** The transports column read back as a list (unknown values dropped). */
export function transportsFromColumn(value: string | null): PasskeyTransport[] {
  return value === null ? [] : knownTransports(value.split(","));
}

/** Narrows a value to a plain JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A base64url string (no padding), the encoding every WebAuthn field uses. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/** The value when it is a non-empty base64url string, else undefined. */
function base64url(value: unknown): string | undefined {
  return typeof value === "string" && BASE64URL_RE.test(value) ? value : undefined;
}

/** Parses JSON text into an object, or null (malformed, too long, not an object). */
function parseObject(raw: string): Record<string, unknown> | null {
  if (raw.length === 0 || raw.length > PASSKEY_RESPONSE_MAX_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** The fields every credential carries: `id`, `rawId` (equal), `type: "public-key"`. */
function credentialHeader(
  value: Record<string, unknown>,
): { id: string; rawId: string; response: Record<string, unknown> } | null {
  const id = base64url(value["id"]);
  const rawId = base64url(value["rawId"]);
  const response = value["response"];
  if (!id || rawId !== id || value["type"] !== "public-key" || !isRecord(response)) {
    return null;
  }
  return { id, rawId, response };
}

/**
 * The browser's registration result (`navigator.credentials.create`, as
 * the dashboard script serializes it) as `RegistrationResponseJSON`, or
 * null when it has not that shape. Only the fields verification reads are
 * kept; extension results are dropped (none are requested).
 */
export function parseRegistrationResponse(raw: string): RegistrationResponseJSON | null {
  const value = parseObject(raw);
  if (!value) return null;
  const header = credentialHeader(value);
  if (!header) return null;
  const clientDataJSON = base64url(header.response["clientDataJSON"]);
  const attestationObject = base64url(header.response["attestationObject"]);
  if (!clientDataJSON || !attestationObject) return null;
  const transports = header.response["transports"];
  return {
    id: header.id,
    rawId: header.rawId,
    type: "public-key",
    response: {
      clientDataJSON,
      attestationObject,
      transports: Array.isArray(transports)
        ? transports.filter(isKnownTransport)
        : undefined,
    },
    clientExtensionResults: {},
  };
}

/**
 * The browser's assertion (`navigator.credentials.get`) as
 * `AuthenticationResponseJSON`, or null when it has not that shape.
 */
export function parseAuthenticationResponse(
  raw: string,
): AuthenticationResponseJSON | null {
  const value = parseObject(raw);
  if (!value) return null;
  const header = credentialHeader(value);
  if (!header) return null;
  const clientDataJSON = base64url(header.response["clientDataJSON"]);
  const authenticatorData = base64url(header.response["authenticatorData"]);
  const signature = base64url(header.response["signature"]);
  if (!clientDataJSON || !authenticatorData || !signature) return null;
  const rawHandle = header.response["userHandle"];
  const userHandle = base64url(rawHandle);
  /** Absent, null or empty is fine (a non-discoverable key); anything else must be base64url. */
  if (rawHandle !== undefined && rawHandle !== null && rawHandle !== "" && !userHandle) {
    return null;
  }
  return {
    id: header.id,
    rawId: header.rawId,
    type: "public-key",
    response: { clientDataJSON, authenticatorData, signature, userHandle },
    clientExtensionResults: {},
  };
}

/**
 * The WebAuthn user handle of an account: the bytes of its `users.id`
 * (`usr_...`, not personal data). A passwordless assertion must carry it
 * back, and it must match the owner of the credential.
 */
export function userHandleOf(userId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(userId);
}
