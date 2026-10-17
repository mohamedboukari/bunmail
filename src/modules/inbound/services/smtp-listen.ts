/**
 * Startup bind failures for BunMail's SMTP servers (#167).
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
