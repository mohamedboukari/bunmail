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

/**
 * A DKIM selector that is not one lowercase DNS label (#250). Mapped to
 * `422 INVALID_DKIM_SELECTOR` by the global error handler; the REST DTO
 * rejects one first (`422 VALIDATION_ERROR`), so this covers the dashboard.
 */
export class InvalidDkimSelectorError extends Error {
  override readonly name = "InvalidDkimSelectorError";
  readonly code = "INVALID_DKIM_SELECTOR";

  constructor() {
    super(
      "The DKIM selector must be one lowercase DNS label: 1 to 63 letters, digits or inner hyphens.",
    );
  }
}

/** Why a DKIM key rotation step was refused (#250). */
export type DkimRotationErrorCode =
  /** Start while a rotation is already pending. */
  | "DKIM_ROTATION_PENDING"
  /** Complete or cancel with no rotation pending. */
  | "DKIM_NO_PENDING_ROTATION"
  /** Complete before the pending key's TXT record is published (or matches). */
  | "DKIM_PENDING_NOT_PUBLISHED"
  /** Complete while the pending private key does not decrypt with `DKIM_ENCRYPTION_KEY`. */
  | "DKIM_PENDING_KEY_UNREADABLE";

/**
 * A DKIM key rotation step refused on the domain's state (#250). Mapped to
 * `409` with its `code` by the global error handler; the dashboard shows
 * the message. Nothing changed.
 */
export class DkimRotationError extends Error {
  override readonly name = "DkimRotationError";
  readonly status = 409;

  constructor(
    readonly code: DkimRotationErrorCode,
    message: string,
  ) {
    super(message);
  }
}
