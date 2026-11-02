import { runWithLogContext, type LogContext } from "../../../utils/log-context.ts";
import { smtpSessionTracer } from "../../../utils/tracing.ts";
import {
  recordSmtpRejection,
  type SmtpRejection,
} from "../../metrics/services/metrics.service.ts";

/**
 * Maps an SMTP error to a response with a specific SMTP status code so the
 * submitting client sees a real rejection instead of a generic failure.
 */
export function smtpError(
  message: string,
  responseCode: number,
  reason: SmtpRejection,
): Error {
  /** Every refusal names its reason, counted in `bunmail_smtp_rejections_total` (#362). */
  recordSmtpRejection("submission", reason);
  /** `Object.assign` widens the type structurally, so no cast is needed. */
  return Object.assign(new Error(message), { responseCode });
}

/**
 * Per live connection, by `smtp-server` session id: when it started and how
 * many messages it sent, for the close summary (#284). Removed on close.
 */
export const sessionStats = new Map<string, { startedAt: number; messages: number }>();

/** The log context of one submission SMTP connection (#284). */
function sessionContext(session: { id: string }): LogContext {
  return { smtpSessionId: session.id, listener: "submission" };
}

/** The trace spans of submission connections and the messages they submit (#363). */
export const sessionSpans = smtpSessionTracer("submission");

/**
 * Runs `fn` in one connection's log context (#284) and, with tracing on,
 * with its span active (#363). smtp-server calls every handler on its own,
 * so each one enters both again.
 */
export function inSession<T>(session: { id: string }, fn: () => T): T {
  return runWithLogContext(sessionContext(session), () =>
    sessionSpans.run(session.id, fn),
  );
}
