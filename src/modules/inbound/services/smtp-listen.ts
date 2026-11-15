/**
 * Shared helpers of BunMail's SMTP servers: their startup bind failures
 * (#167), the port they are bound to (#443) and their TLS errors (#414).
 *
 * Startup bind failures (#167):
 *
 * Both SMTP servers (inbound receiver and submission) report a failure to
 * bind their port through the same `error` event as runtime errors. Logged
 * and ignored, that left the process (and the container's HTTP health
 * check) up while no mail could arrive. Callers use these helpers to
 * recognise a bind failure, explain it, and exit instead.
 *
 * Shared by the inbound and smtp-submission modules. Kept pure (no logger,
 * no process.exit) so it unit-tests without mocks.
 */

import type { AddressInfo } from "net";

/** A Node/Bun socket error raised by `listen()` (EACCES, EADDRINUSE, ...). */
export type ListenError = Error & { syscall: "listen"; code?: string };

/**
 * True when a server `error` event is a failure to bind the listening port,
 * as opposed to a runtime error on an individual connection.
 *
 * @param err - Whatever the server's `error` event emitted
 */
export function isListenError(err: unknown): err is ListenError {
  return err instanceof Error && "syscall" in err && err.syscall === "listen";
}

/**
 * Human-readable explanation of a bind failure, including how to fix it.
 *
 * @param server - Which server failed, e.g. "Inbound SMTP"
 * @param port   - The port it tried to bind
 * @param code   - The socket error code, if any (e.g. "EACCES")
 * @returns A one-line message suitable for a fatal log entry
 */
export function describeListenError(server: string, port: number, code?: string): string {
  if (code === "EACCES") {
    return (
      `${server} can't listen on port ${port} (EACCES: permission denied). ` +
      "BunMail runs as a non-root user: set the sysctl net.ipv4.ip_unprivileged_port_start=0 " +
      "(pinned in docker-compose.yml) or use a port >= 1024."
    );
  }
  if (code === "EADDRINUSE") {
    return `${server} can't listen on port ${port} (EADDRINUSE): another process is already using it.`;
  }
  return `${server} can't listen on port ${port} (${code ?? "unknown error"}).`;
}

/** Anything that reports its bound address like a `net.Server` (or `tls.Server`). */
export interface BoundAddressSource {
  address(): AddressInfo | string | null;
}

/**
 * The TCP port a listening server is actually bound to (#443).
 *
 * Equal to the requested port whenever that is a real port, as in
 * production. With port `0` the OS picks a free port, and this reads it
 * back, so the tests can bind `0` and run side by side without colliding.
 *
 * @param server    - The listening server (its `address()` is read)
 * @param requested - The port passed to `listen()`, returned when the
 *                    server reports no TCP address (a pipe path, or not
 *                    listening yet)
 * @returns The bound port
 */
export function boundPort(server: BoundAddressSource, requested: number): number {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : requested;
}

/** What a client's TLS error carries for its log line (#414). */
export interface TlsSocketError {
  /** The client's address, as smtp-server records it on the error. */
  ip: string | null;
  /** The TLS error code (`ERR_SSL_WRONG_VERSION_NUMBER`, ...). */
  code: string;
  /**
   * Whether the error came from a connection smtp-server upgraded with
   * STARTTLS (it adds `meta.protocol: "smtp"` there), as opposed to a
   * socket whose TLS ended upstream (the submission server's implicit TLS).
   */
  starttls: boolean;
}

/** Error codes of a TLS failure (Node and Bun, and smtp-server's own). */
const TLS_ERROR_CODE_RE = /^(ERR_SSL_|ERR_TLS_|TLSError$)/;

/**
 * The details of a server `error` event that is a client's TLS error
 * (#414), or `null` for any other error. A client that sends plaintext
 * after `STARTTLS`, offers no protocol or cipher in common, or sends a
 * broken TLS record later in the session is an expected failure on a
 * public port, so callers log it at `warn`, not as a server error.
 *
 * It does not say whether the handshake had completed: under Bun 1.4.4 a
 * failed STARTTLS handshake and a bad record after a completed one reach
 * here alike (smtp-server's `meta.stage` is `connect` for both, and Bun
 * reports a protocol version even for the failed handshake), so the log
 * line stays neutral.
 *
 * @param err - Whatever the server's `error` event emitted
 */
export function tlsSocketError(err: unknown): TlsSocketError | null {
  if (!(err instanceof Error)) return null;
  const code: unknown = Reflect.get(err, "code");
  if (typeof code !== "string" || !TLS_ERROR_CODE_RE.test(code)) return null;
  const ip: unknown = Reflect.get(err, "remoteAddress");
  const meta: unknown = Reflect.get(err, "meta");
  const starttls =
    typeof meta === "object" && meta !== null && Reflect.get(meta, "protocol") === "smtp";
  return { ip: typeof ip === "string" ? ip : null, code, starttls };
}
