import { hkdfSync } from "crypto";
import { config } from "../../../config.ts";
import { decryptSecret, encryptSecret } from "../../../utils/crypto.ts";
import {
  SSO_FLOW_PURPOSES,
  type SsoFlowPayload,
  type SsoFlowPurpose,
} from "../types/sso.types.ts";

/**
 * The encrypted SSO flow cookie `bm_sso` (#224).
 *
 * Between the redirect to the provider and its callback BunMail has to
 * remember `state`, `nonce` and the PKCE verifier. They travel in the
 * browser, encrypted and authenticated with AES-256-GCM (`encryptSecret`),
 * instead of in memory or a table: any replica can finish any flow, and
 * there is nothing to sweep. GCM makes the payload unreadable and
 * unforgeable without the key, and `exp` bounds its life to 10 minutes.
 *
 * Single use comes from three things together: the callback clears the
 * cookie, the provider's code is one-time, and PKCE binds that code to the
 * verifier in this cookie.
 *
 * The key is derived with HKDF-SHA256 from `DKIM_ENCRYPTION_KEY` under a
 * fixed label, like the unsubscribe tokens, so no new secret has to be
 * configured. Rotating `DKIM_ENCRYPTION_KEY` only fails the flows in
 * progress at that moment.
 */

/** HKDF `info` label: binds the derived key to this one use. */
const KEY_INFO = "bunmail sso flow v1";

/** How long a flow stays valid, in seconds: the cookie's `Max-Age` and the payload's `exp`. */
export const SSO_FLOW_TTL_SECONDS = 10 * 60;

/**
 * Longest cookie value read, in characters. A real one is about 500; the
 * bound keeps a forged oversized cookie from reaching the decryption.
 */
const MAX_FLOW_COOKIE_LENGTH = 4096;

/** Longest `state`, `nonce` or verifier accepted back (BunMail makes 43). */
const MAX_FLOW_FIELD_LENGTH = 128;

/** Derives the flow-cookie key from a master key (exported for tests). */
export function deriveSsoFlowKey(master: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), KEY_INFO, 32));
}

/** The key derived from `DKIM_ENCRYPTION_KEY`, computed once. */
let configuredKey: Buffer | null = null;

/** The flow-cookie key of this deployment. */
export function defaultSsoFlowKey(): Buffer {
  configuredKey ??= deriveSsoFlowKey(config.dkimEncryptionKey);
  return configuredKey;
}

/** Encrypts a flow payload into a `bm_sso` cookie value. */
export function sealSsoFlow(payload: SsoFlowPayload, key: Buffer): string {
  return encryptSecret(JSON.stringify(payload), key);
}

/** Narrows a string to a flow purpose. */
function isSsoFlowPurpose(value: unknown): value is SsoFlowPurpose {
  return (
    typeof value === "string" && SSO_FLOW_PURPOSES.some((purpose) => purpose === value)
  );
}

/** A non-empty string of at most `max` characters. */
function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * Decrypts and checks a `bm_sso` cookie value. `null` when it does not
 * decrypt (tampered, another key), does not parse, or does not have
 * exactly the payload's shape: a `link` flow must carry the session id
 * and a `login` flow must not. The expiry is the caller's check.
 */
export function openSsoFlow(value: string, key: Buffer): SsoFlowPayload | null {
  if (value.length === 0 || value.length > MAX_FLOW_COOKIE_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptSecret(value, key));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const v: unknown = Reflect.get(parsed, "v");
  const provider: unknown = Reflect.get(parsed, "provider");
  const purpose: unknown = Reflect.get(parsed, "purpose");
  const sessionId: unknown = Reflect.get(parsed, "sessionId");
  const state: unknown = Reflect.get(parsed, "state");
  const nonce: unknown = Reflect.get(parsed, "nonce");
  const codeVerifier: unknown = Reflect.get(parsed, "codeVerifier");
  const exp: unknown = Reflect.get(parsed, "exp");
  if (v !== 1) return null;
  if (!isBoundedString(provider, 32) || !isSsoFlowPurpose(purpose)) return null;
  if (
    !isBoundedString(state, MAX_FLOW_FIELD_LENGTH) ||
    !isBoundedString(nonce, MAX_FLOW_FIELD_LENGTH) ||
    !isBoundedString(codeVerifier, MAX_FLOW_FIELD_LENGTH)
  ) {
    return null;
  }
  if (typeof exp !== "number" || !Number.isSafeInteger(exp)) return null;
  const base: SsoFlowPayload = { v, provider, purpose, state, nonce, codeVerifier, exp };
  if (purpose === "link") {
    if (!isBoundedString(sessionId, 64)) return null;
    return { ...base, sessionId };
  }
  if (sessionId !== undefined) return null;
  return base;
}

/**
 * The purpose of a `bm_sso` cookie value, or `null` when there is none or
 * it does not open: what the callback reads first to tell a sign-in from
 * a link (#224). Nothing else is checked or trusted here (no expiry, no
 * provider, no `state`): the flow checks of the chosen half do that.
 */
export function ssoFlowPurposeOf(
  value: string | undefined,
  key: Buffer = defaultSsoFlowKey(),
): SsoFlowPurpose | null {
  return value === undefined ? null : (openSsoFlow(value, key)?.purpose ?? null);
}
