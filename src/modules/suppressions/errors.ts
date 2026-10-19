/**
 * Thrown by `email.service.createEmail` when the recipient is on the
 * suppression list for the calling API key. The global `.onError`
 * handler in `src/index.ts` recognises this class and maps it to
 * HTTP 422 with a structured body, without that handler, Elysia would
 * default to 500.
 *
 * Carrying `suppressionId` in the body lets clients pivot directly to
 * `DELETE /api/v1/suppressions/:id` when they want to undo (e.g. a
 * recipient who confirmed they want emails again). It is `null` when a
 * shared suppression applied (`SUPPRESSIONS_SHARED_HARD`, #250): that row
 * belongs to another API key, so neither its id nor its key is revealed.
 */
export class SuppressedRecipientError extends Error {
  override readonly name = "SuppressedRecipientError";
  readonly suppressionId: string | null;
  readonly recipient: string;

  constructor(args: { suppressionId: string | null; recipient: string }) {
    super(
      `Recipient is on the suppression list. Remove the suppression first if this is intentional.`,
    );
    this.suppressionId = args.suppressionId;
    this.recipient = args.recipient;
  }
}
