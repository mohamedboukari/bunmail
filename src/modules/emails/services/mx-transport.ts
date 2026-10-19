import { connect, type Socket } from "node:net";
import { createTransport } from "nodemailer";
import type Mail from "nodemailer/lib/mailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { DeliveryTls } from "../models/email.schema.ts";

/**
 * Lowest TLS version an outbound STARTTLS session may negotiate (#250). A
 * peer that only offers older versions fails the handshake; the failure
 * carries no SMTP reply, so the group is retried, never bounced.
 */
export const OUTBOUND_TLS_MIN_VERSION = "TLSv1.2";

/** Connect, greeting and STARTTLS setup timeout for outbound SMTP (#250). */
export const SMTP_SETUP_TIMEOUT_MS = 60_000;

/**
 * Longest one outbound SMTP session may take (#250). Every step has its
 * own timeout, but a peer that keeps answering slowly could still hold
 * the MX lock for hours; this caps the whole attempt.
 */
export const SMTP_SESSION_DEADLINE_MS = 20 * 60_000;

/**
 * Nodemailer's own log line for a completed STARTTLS upgrade, written by
 * its SMTP connection right after the TLS callback. The real-server test
 * (`test/unit/mx-transport.test.ts`) pins it, so a wording change in a
 * nodemailer upgrade fails a test instead of silently recording no TLS.
 */
const STARTTLS_UPGRADED = "Connection upgraded with STARTTLS";

/** A bunyan-style logger, the shape nodemailer accepts as `logger`. */
interface NodemailerLogger {
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
 * STARTTLS upgrade and a ready session.
 */
export function createTlsRecorder(stallMs = SMTP_SETUP_TIMEOUT_MS): TlsRecorder {
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

/**
 * Verified TLS for a session to an MX host named by an MTA-STS policy in
 * enforce mode (#250, `mta-sts.ts`).
 */
export interface VerifiedTls {
  /** Trust anchors (PEM) instead of the system store: tests only. */
  ca?: string;
}

/**
 * Transport options for one destination MX (#250), without pooling.
 *
 * - Connects to the checked `address`; the MX name goes to TLS as SNI.
 * - Without `verifiedTls`: opportunistic STARTTLS, used when offered,
 *   never required, and certificates are not verified, as most MX
 *   certificates would fail a strict check.
 * - With `verifiedTls` (the recipient domain's MTA-STS policy is in
 *   enforce mode): STARTTLS is required (`requireTLS`, never a plaintext
 *   fallback) and the certificate must chain to a trusted root and name
 *   the MX host (`rejectUnauthorized`, `servername`). The connection stays
 *   pinned to the checked `address`.
 * - TLS 1.2 at least ({@link OUTBOUND_TLS_MIN_VERSION}).
 * - Setup timeouts of {@link SMTP_SETUP_TIMEOUT_MS}: connecting and the
 *   greeting come before anything is sent, so a dead or tarpitting MX
 *   gives up its MX lock quickly. The socket inactivity timeout stays at
 *   nodemailer's 10 minutes: RFC 5321 4.5.3.2 has the client wait that
 *   long for the reply to the final `.` of DATA, and a shorter one risks a
 *   retry and a duplicate.
 */
export function mxTransportOptions(args: {
  address: string;
  mxHost: string;
  /** EHLO name: `MAIL_HOSTNAME`. */
  heloName: string;
  logger: NodemailerLogger;
  verifiedTls?: VerifiedTls;
}): SMTPTransport.Options {
  const base = {
    host: args.address,
    port: 25,
    secure: false,
    name: args.heloName,
    connectionTimeout: SMTP_SETUP_TIMEOUT_MS,
    greetingTimeout: SMTP_SETUP_TIMEOUT_MS,
    logger: args.logger,
  };
  if (args.verifiedTls !== undefined) {
    const ca = args.verifiedTls.ca;
    return {
      ...base,
      requireTLS: true,
      opportunisticTLS: false,
      tls: {
        rejectUnauthorized: true,
        servername: args.mxHost,
        minVersion: OUTBOUND_TLS_MIN_VERSION,
        ...(ca === undefined ? {} : { ca }),
      },
    };
  }
  return {
    ...base,
    opportunisticTLS: true,
    tls: {
      rejectUnauthorized: false,
      servername: args.mxHost,
      minVersion: OUTBOUND_TLS_MIN_VERSION,
    },
  };
}

/** Error codes of a certificate or TLS failure on the socket (Node and Bun). */
const TLS_FAILURE_CODE_RE =
  /^(ERR_TLS|ERR_SSL|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_|HOSTNAME_MISMATCH)/;

/**
 * An enforce-mode TLS failure as an error with no SMTP reply (#250), so it
 * is retried and may fail over to the next matching MX host, never a
 * bounce: an MX that refuses `STARTTLS` (nodemailer's `ETLS`, which
 * carries the server's `5xx` refusal as `responseCode`), an `EHLO` that
 * fails when STARTTLS is required, or a certificate the check rejected.
 * The reason stays in the message, on one line, so no reply code starts a
 * line of it. Any other error is returned as it is.
 */
export function enforcedTlsFailure(error: unknown, mxHost: string): unknown {
  if (!(error instanceof Error)) return error;
  const code: unknown = Reflect.get(error, "code");
  const originalCode: unknown = Reflect.get(error, "originalCode");
  const command: unknown = Reflect.get(error, "command");
  const tlsFailure =
    code === "ETLS" ||
    command === "STARTTLS" ||
    (command === "EHLO" && /STARTTLS/.test(error.message)) ||
    (typeof code === "string" && TLS_FAILURE_CODE_RE.test(code)) ||
    (typeof originalCode === "string" && TLS_FAILURE_CODE_RE.test(originalCode));
  if (!tlsFailure) return error;
  const reason = error.message.replace(/\s+/g, " ").trim();
  return new Error(`MTA-STS: no verified TLS with ${mxHost} (${reason})`);
}

/** One SMTP transaction of a session: its delivery-state key and its message. */
export interface MxSessionTransaction {
  key: string;
  mail: Mail.Options;
}

/** A recipient the MX refused at `RCPT TO` while it accepted others (#250). */
export interface RejectedRecipient {
  /** The address as it was given in the envelope. */
  recipient: string;
  /** Nodemailer's error for it, carrying the reply (`responseCode`, `response`). */
  error: Error;
}

/** One transaction's outcome: no `error` means the MX accepted it. */
export interface MxSessionOutcome {
  key: string;
  error?: unknown;
  /** The session's encryption, see {@link TlsRecorder} (#250). */
  tls: DeliveryTls | null;
  /**
   * Accepted transactions only: the recipients the MX refused at `RCPT TO`
   * while it accepted at least one other (#250). Absent when every
   * recipient was accepted. When every recipient is refused, the
   * transaction fails instead, with `error`.
   */
  rejected?: RejectedRecipient[];
}

/**
 * Runs one SMTP session to one MX (#250): every transaction in turn over a
 * single pooled connection, under one deadline, with the TLS record.
 *
 * - **Verified TLS** (`verifiedTls`, an MTA-STS enforce policy): see
 *   {@link mxTransportOptions}; a TLS failure is reported through
 *   {@link enforcedTlsFailure}, so it is retried, never bounced.
 * - **One pooled connection** (`maxConnections: 1`), also for a single
 *   transaction, so there is one code path. Each message after the first
 *   goes after `RSET`. `maxRequeues: 0` keeps nodemailer from silently
 *   resending a message whose connection dropped: that failure is
 *   reported, and the queue's retry policy decides.
 * - **BunMail opens the socket** (nodemailer's `getSocket` hook), to the
 *   checked `address`, and keeps it. Closing the pool only ends connections
 *   that are idle: one stuck mid-session (a peer that never answers, a
 *   STARTTLS handshake that never completes) would stay open, possibly
 *   spinning, after the attempt was given up. So when the session ends,
 *   whatever the outcome, the pool is closed and every socket it used is
 *   destroyed. An unfriendly receiver cannot pile up open connections.
 * - **Deadline** {@link SMTP_SESSION_DEADLINE_MS} for the whole session,
 *   shared by its transactions, and the STARTTLS stall limit of the
 *   {@link TlsRecorder}. Both fail the attempt with an error that has no
 *   SMTP reply, so it is retried.
 *
 * The caller holds the MX lock around it. Never throws: every transaction
 * gets an outcome. `port` and the timeouts are only overridden by tests.
 */
export async function runMxSession(args: {
  address: string;
  mxHost: string;
  /** EHLO name: `MAIL_HOSTNAME`. */
  heloName: string;
  transactions: MxSessionTransaction[];
  /** Set when the recipient domain's MTA-STS policy is in enforce mode. */
  verifiedTls?: VerifiedTls;
  port?: number;
  deadlineMs?: number;
  stallMs?: number;
  setupTimeoutMs?: number;
}): Promise<MxSessionOutcome[]> {
  const port = args.port ?? 25;
  const deadlineMs = args.deadlineMs ?? SMTP_SESSION_DEADLINE_MS;
  const setupTimeoutMs = args.setupTimeoutMs ?? SMTP_SETUP_TIMEOUT_MS;
  /** Learns each transaction's encryption from nodemailer's own events. */
  const recorder = createTlsRecorder(args.stallMs ?? setupTimeoutMs);
  const sockets = new Set<Socket>();
  const transport = createTransport({
    ...mxTransportOptions({
      address: args.address,
      mxHost: args.mxHost,
      heloName: args.heloName,
      logger: recorder.logger,
      verifiedTls: args.verifiedTls,
    }),
    port,
    pool: true,
    maxConnections: 1,
    maxRequeues: 0,
    getSocket: openSocket(args.address, port, setupTimeoutMs, sockets),
  });

  /** One deadline for the whole session, shared by its transactions. */
  const deadlineAt = Date.now() + deadlineMs;
  const outcomes: MxSessionOutcome[] = [];
  try {
    for (const transaction of args.transactions) {
      const remainingMs = deadlineAt - Date.now();
      recorder.beginTransaction();
      try {
        if (remainingMs <= 0) throw sessionDeadlineError(deadlineMs);
        const info = await sendWithDeadline(
          transport,
          transaction.mail,
          remainingMs,
          recorder.stalled,
        );
        const rejected = rejectedRecipients(info);
        outcomes.push(
          rejected.length > 0
            ? { key: transaction.key, tls: recorder.result(), rejected }
            : { key: transaction.key, tls: recorder.result() },
        );
      } catch (error) {
        outcomes.push({
          key: transaction.key,
          error:
            args.verifiedTls === undefined
              ? error
              : enforcedTlsFailure(error, args.mxHost),
          tls: recorder.result(),
        });
      }
    }
  } finally {
    recorder.dispose();
    /**
     * Sockets first: under Bun, nodemailer's own close ends the plain socket
     * a STARTTLS session was upgraded from, which no longer carries the
     * connection, so a TLS session would stay open. Destroying the socket
     * before nodemailer touches it closes the connection, TLS or not, idle
     * or stuck. The pool is closed after, to release its state.
     */
    for (const socket of sockets) socket.destroy();
    transport.close();
  }
  return outcomes;
}

/**
 * The recipients an accepted transaction's MX refused (#250), from the
 * info nodemailer resolves with: `rejectedErrors` (one error per refused
 * recipient, with its reply), and any `rejected` address without one. A
 * fake or unusual transport may report neither: nobody was refused.
 */
function rejectedRecipients(info: unknown): RejectedRecipient[] {
  if (typeof info !== "object" || info === null) return [];
  const found: RejectedRecipient[] = [];
  const errors: unknown = Reflect.get(info, "rejectedErrors");
  if (Array.isArray(errors)) {
    for (const error of errors) {
      if (!(error instanceof Error)) continue;
      const recipient: unknown = Reflect.get(error, "recipient");
      if (typeof recipient === "string") found.push({ recipient, error });
    }
  }
  const rejected: unknown = Reflect.get(info, "rejected");
  if (Array.isArray(rejected)) {
    for (const recipient of rejected) {
      if (typeof recipient !== "string") continue;
      if (found.some((r) => r.recipient === recipient)) continue;
      found.push({ recipient, error: new Error("Recipient rejected without a reply") });
    }
  }
  return found;
}

/**
 * nodemailer's `getSocket` hook (#250): connects to `address` itself,
 * within `timeoutMs`, and records the socket in `sockets` so the session
 * can destroy it. An `error` listener stays on the socket for its whole
 * life: an error during teardown must never become an uncaught exception.
 */
function openSocket(
  address: string,
  port: number,
  timeoutMs: number,
  sockets: Set<Socket>,
): NonNullable<SMTPTransport.Options["getSocket"]> {
  return (_options, callback) => {
    const socket = connect({ host: address, port });
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let settled = false;
    const settle = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket.destroy();
        callback(error);
        return;
      }
      callback(null, { connection: socket });
    };
    const timer = setTimeout(
      () => settle(new Error(`Connection to ${address} timed out`)),
      timeoutMs,
    );
    socket.on("error", (error: Error) => settle(error));
    socket.once("connect", () => settle(null));
  };
}

/** The part of a Nodemailer transport {@link sendWithDeadline} uses. */
interface ClosableTransport {
  sendMail(options: Mail.Options): Promise<unknown>;
  close(): void;
}

/** The error of a session that ran past its deadline: no SMTP reply, so it is retried. */
function sessionDeadlineError(deadlineMs: number): Error {
  return new Error(
    `SMTP session exceeded ${Math.round(deadlineMs / 1000)} s and was closed`,
  );
}

/**
 * Sends with an overall deadline (#250): past `deadlineMs` the transport
 * is closed and the attempt fails with a plain error, which carries no
 * SMTP reply and is therefore retried later, not treated as a bounce.
 * `abort` (a stalled STARTTLS upgrade, see `TlsRecorder.stalled`) ends the
 * attempt the same way, earlier. {@link runMxSession} then destroys the
 * session's sockets. Resolves with what the transport resolved with (its
 * `info`, which lists refused recipients).
 */
export async function sendWithDeadline(
  transport: ClosableTransport,
  options: Mail.Options,
  deadlineMs: number,
  abort?: Promise<never>,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      transport.close();
      reject(sessionDeadlineError(deadlineMs));
    }, deadlineMs);
  });
  const racers: Array<Promise<unknown>> = [transport.sendMail(options), deadline];
  if (abort) {
    racers.push(
      abort.catch((error: unknown) => {
        transport.close();
        throw error;
      }),
    );
  }
  try {
    return await Promise.race(racers);
  } finally {
    clearTimeout(timer);
  }
}
