/**
 * A submitted message refused on its content (no sender, no recipients,
 * headers naming nobody in the envelope, a message that does not parse).
 * The client must not retry it: answered with SMTP `550` and this fixed
 * message. Any error that is not typed is unexpected and answered with a
 * temporary `451` instead, so internal error text never reaches the
 * client.
 */
export class SubmissionRejectedError extends Error {
  override readonly name = "SubmissionRejectedError";
}
