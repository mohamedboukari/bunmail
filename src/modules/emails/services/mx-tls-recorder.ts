import type { DeliveryTls } from "../models/email.schema.ts";

/**
 * The outbound TLS record of an MX session (#250): which transactions ran
 * over STARTTLS, read from nodemailer's own log events. Split from
 * `mx-transport.ts`, which re-exports it.
 */

/** Default stall limit: the outbound setup timeout (`SMTP_SETUP_TIMEOUT_MS`, `mx-transport.ts`). */
const DEFAULT_STALL_MS = 60_000;

/**
 * Nodemailer's own log line for a completed STARTTLS upgrade, written by
 * its SMTP connection right after the TLS callback. The real-server test
 * (`test/unit/mx-transport.test.ts`) pins it, so a wording change in a
 * nodemailer upgrade fails a test instead of silently recording no TLS.
 */
const STARTTLS_UPGRADED = "Connection upgraded with STARTTLS";

/** A bunyan-style logger, the shape nodemailer accepts as `logger`. */
export interface NodemailerLogger {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
}

/**
 * Watches one MX transport's nodemailer log events to learn whether each
 * transaction ran over STARTTLS (#250). Nothing is logged or stored from
 * those events (they carry addresses); only three facts are kept:
 *
 * - which connection is current (the `sid` nodemailer puts on every line
 *   of a connection: a new one means a new, not yet upgraded session);
 * - whether that connection reported the STARTTLS upgrade;
 * - whether the session became ready to send (the transport's `send`
 *   line, written once the greeting, EHLO and any STARTTLS restart are
 *   done).
 *
 * The upgrade line alone is not proof: under Bun the TLS callback can fire
 * for a handshake the peer refused (one offering only TLS below 1.2), and
 * the session then never answers. So a transaction counts as `starttls`
 * only when the session also became ready, which needs an EHLO reply read
 * over the new TLS layer; `plaintext` when it became ready without the
 * upgrade; and `null` (unknown) when it never became ready.
 */
export interface TlsRecorder {
  /** Pass as the transport's `logger` option. */
  logger: NodemailerLogger;
  /** Call before each transaction: a pooled connection keeps its upgrade, not its readiness. */
  beginTransaction(): void;
  /** What the transaction that just ran used, see the interface comment. */
  result(): DeliveryTls | null;
  /**
   * Rejects when a session reported the STARTTLS upgrade but did not become
   * ready within the stall limit: the handshake did not really complete,
   * and nodemailer's own setup timer was already cleared by the callback.
   * The error carries no SMTP reply, so the group is retried.
   */
  stalled: Promise<never>;
  /** Clears the stall timer. */
  dispose(): void;
}

/**
 * Creates a {@link TlsRecorder}; `stallMs` bounds the wait between the
 * STARTTLS upgrade and a ready session. `onUpgraded` runs on each upgrade
 * line, synchronously, before nodemailer sends anything over the new TLS
 * layer: an error it returns rejects `stalled` at once (the DANE guard
 * against a lost nodemailer patch, see {@link runMxSession}).
 */
export function createTlsRecorder(
  stallMs = DEFAULT_STALL_MS,
  onUpgraded?: () => Error | null,
): TlsRecorder {
  let sid: string | undefined;
  let upgraded = false;
  let ready = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let rejectStalled: (error: Error) => void = () => undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    rejectStalled = reject;
  });
  /** Nobody may be racing it when it fires; never an unhandled rejection. */
  stalled.catch(() => undefined);

  const clearStall = (): void => {
    if (stallTimer !== undefined) clearTimeout(stallTimer);
    stallTimer = undefined;
  };

  const observe = (entry: unknown, message: unknown): void => {
    if (typeof entry !== "object" || entry === null) return;
    const lineSid: unknown = Reflect.get(entry, "sid");
    const tnx: unknown = Reflect.get(entry, "tnx");
    if (typeof lineSid === "string" && lineSid !== sid) {
      /** A new connection: not upgraded until it says so. */
      sid = lineSid;
      upgraded = false;
    }
    if (tnx === "smtp" && message === STARTTLS_UPGRADED) {
      upgraded = true;
      ready = false;
      clearStall();
      const refused = onUpgraded?.() ?? null;
      if (refused !== null) {
        rejectStalled(refused);
        return;
      }
      stallTimer = setTimeout(() => {
        if (!ready) {
          rejectStalled(
            new Error(
              `STARTTLS handshake did not complete within ${Math.round(stallMs / 1000)} s`,
            ),
          );
        }
      }, stallMs);
      return;
    }
    if (tnx === "send") {
      ready = true;
      clearStall();
    }
  };

  const logger: NodemailerLogger = {
    trace: observe,
    debug: observe,
    info: observe,
    warn: observe,
    error: observe,
    fatal: observe,
  };

  return {
    logger,
    beginTransaction: () => {
      ready = false;
    },
    result: () => (ready ? (upgraded ? "starttls" : "plaintext") : null),
    stalled,
    dispose: clearStall,
  };
}
