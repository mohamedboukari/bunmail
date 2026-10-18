/**
 * Thrown by `email.service.createEmail` when the calling API key has a
 * non-empty `allowedSenders` allowlist and the message's `From` address
 * isn't on it (#126). The global `.onError` handler in `src/index.ts`
 * maps this to HTTP 403 with `code: "UNAUTHORIZED_SENDER"`; the SMTP
 * submission server maps it to SMTP 550.
 *
 * This is the control that stops a key from spoofing arbitrary identities
 * (e.g. a `noreply@` key sending as `ceo@`) even though the domain is
 * registered and DKIM-signed.
 */
export class UnauthorizedSenderError extends Error {
  override readonly name = "UnauthorizedSenderError";
  /** The `From` address that was rejected. */
  readonly sender: string;

  constructor(sender: string) {
    super(`Sender address "${sender}" is not in this API key's allowed-senders list.`);
    this.sender = sender;
  }
}

/**
 * Thrown by `email.service.createEmail` when the sending API key is
 * revoked or no longer exists. REST requests with a revoked key are
 * already rejected by `authMiddleware`; this covers the paths that hold a
 * key id across time: an SMTP submission session authenticated before the
 * key was revoked (mapped to SMTP 550), and the dashboard. Mapped to HTTP
 * 401 with `code: "API_KEY_REVOKED"`.
 */
export class InactiveApiKeyError extends Error {
  override readonly name = "InactiveApiKeyError";

  constructor() {
    super("This API key has been revoked.");
  }
}

/**
 * Thrown by `createApiKey` when the key's creator (#219: the signed-in
 * dashboard user, or over REST the calling key's user) no longer exists
 * or is deactivated, checked on the live row under `FOR SHARE`. Mapped to
 * HTTP 403 with `code: "API_KEY_CREATOR_INACTIVE"`; the dashboard shows a
 * flash.
 */
export class ApiKeyCreatorInactiveError extends Error {
  override readonly name = "ApiKeyCreatorInactiveError";

  constructor() {
    super("The account this API key would belong to is deactivated or gone.");
  }
}
