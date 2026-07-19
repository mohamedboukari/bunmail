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
