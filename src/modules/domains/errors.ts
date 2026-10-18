/**
 * A domain whose name (compared case-insensitively: DNS names are) is
 * already registered. Mapped to `409 DOMAIN_ALREADY_REGISTERED` by the
 * global error handler; the dashboard shows the message as is. Before,
 * a duplicate hit the unique constraint and surfaced as a masked 500.
 */
export class DomainAlreadyRegisteredError extends Error {
  override readonly name = "DomainAlreadyRegisteredError";
  readonly code = "DOMAIN_ALREADY_REGISTERED";

  constructor(domain: string) {
    super(`Domain "${domain}" is already registered.`);
  }
}
