import { runWithLogContext, type LogContext } from "../../../utils/log-context.ts";
import { smtpSessionTracer } from "../../../utils/tracing.ts";
import {
  recordSmtpRejection,
  type SmtpRejection,
} from "../../metrics/services/metrics.service.ts";

/**
 * Per live connection, by `smtp-server` session id: when it started and how
 * many messages it sent, for the close summary (#284). Removed on close.
 */
export const sessionStats = new Map<string, { startedAt: number; messages: number }>();

/** The log context of one inbound SMTP connection (#284). */
function sessionContext(session: { id: string }): LogContext {
  return { smtpSessionId: session.id, listener: "inbound" };
}

/** The trace spans of inbound connections and the messages they deliver (#363). */
export const sessionSpans = smtpSessionTracer("inbound");

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

/**
 * Builds the error shape `smtp-server` callbacks expect: a standard
 * `Error` carrying the SMTP reply code the library writes back to the
 * client. `Object.assign` widens the type structurally, so call sites
 * don't need an `as Error & { responseCode: number }` cast. Every refusal
 * names its `reason`, counted in `bunmail_smtp_rejections_total` (#362).
 */
export function smtpError(
  message: string,
  responseCode: number,
  reason: SmtpRejection,
): Error {
  recordSmtpRejection("inbound", reason);
  return Object.assign(new Error(message), { responseCode });
}
