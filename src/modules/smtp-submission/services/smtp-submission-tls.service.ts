import { randomBytes } from "crypto";
import type { Socket } from "net";
import { createServer as createTlsServer, type Server as TlsServer } from "tls";
import type { SMTPServer } from "smtp-server";
import { logger } from "../../../utils/logger.ts";

/*
 * `SMTPServer#connect` (#349) is the method smtp-server itself calls with
 * each accepted socket; smtp-server types it since 3.20, so the module
 * augmentation it needed with `@types/smtp-server` is gone. Implicit TLS
 * hands it the sockets of a TLS server the runtime terminates itself,
 * because smtp-server's own implicit TLS (and STARTTLS) wraps an accepted
 * socket with `new tls.TLSSocket(socket, { isServer: true })`, which never
 * handshakes under Bun. `smtp-server` is pinned to an exact version in
 * package.json, and `test/integration/smtp-submission-tls.integration.test.ts`
 * fails if an upgrade breaks the handover.
 */

/**
 * How long a connection to the implicit-TLS port may take to finish its
 * TLS handshake (#349), the idle limit smtp-server gives any session
 * (60 s). Bun's TLS server ignores `handshakeTimeout`, so it is armed on
 * the socket by hand.
 */
const TLS_HANDSHAKE_TIMEOUT_MS = 60_000;

/** A session id in smtp-server's own format (10 random bytes in base 32). */
function newSessionId(): string {
  return BigInt(`0x${randomBytes(10).toString("hex")}`)
    .toString(32)
    .padStart(16, "0");
}

/** Sockets `closeWholeSocket` already guards (under Bun, accepted and TLS are one). */
const guardedSockets = new WeakSet<Socket>();

/**
 * Makes a socket of the implicit-TLS listener close in full whenever
 * either side ends it (#351), at every stage (handshake, handoff, session):
 * - Ending our side destroys the socket once everything written has been
 *   handed to the runtime. `_final` runs only after every pending write has
 *   completed, so the last reply (a `221`, a `421`) still goes out; Bun's
 *   own `_final` would half-close the socket instead, which is the state
 *   that leaks it (see `createImplicitTlsListener`).
 * - The client's FIN or a socket error destroys it at once: no half-open
 *   session, nothing left polling a dead socket. smtp-server's own `close`
 *   listener then closes its session, so `SMTP session closed` is logged.
 */
function closeWholeSocket(socket: Socket): void {
  if (guardedSockets.has(socket)) return;
  guardedSockets.add(socket);
  socket._final = (callback) => {
    socket.destroy();
    callback();
  };
  socket.once("end", () => {
    logger.debug("SMTP submission client hung up", { ip: socket.remoteAddress });
    socket.destroy();
  });
  socket.on("error", () => socket.destroy());
}

/**
 * The implicit-TLS listener (#349): the runtime's own TLS server, which
 * terminates TLS from the first byte and hands each decrypted socket to
 * `smtp`, so every session is TLS before its first SMTP byte.
 *
 * Bun quirks, both seen with Bun 1.3.14:
 * - `handshakeTimeout` is ignored, so a client that never finishes the
 *   handshake would hold its socket forever. The handshake gets the idle
 *   limit of any session by hand, on the accepted socket (which under Bun
 *   is the TLS socket itself; the session's own timeout replaces it).
 * - A plaintext client's failed handshake (it gets a TLS alert) can still
 *   reach the secure-connection callback. Nothing it sent is ever read as
 *   SMTP and nothing written to it reaches the wire, but it opens a
 *   session that closes at once: one `SMTP session closed` line, and one
 *   connection counted against its IP's connection limit, as any
 *   plaintext client is counted (one per TCP connection, never more).
 * - A TLS socket we end (smtp-server ends it on QUIT, a 421 or its idle
 *   timeout) and that is then paused (smtp-server unpipes its parser right
 *   after) never closes once the client's FIN arrives (#351): it sits in
 *   CLOSE_WAIT and the event loop keeps waking for it, a full CPU
 *   core on Linux. `destroy()` cannot close it after that point, so the
 *   socket must never be half-closed by us: see `closeWholeSocket`.
 */
export function createImplicitTlsListener(
  smtp: SMTPServer,
  material: { key: Buffer; cert: Buffer },
): TlsServer {
  const listener = createTlsServer(
    { ...material, handshakeTimeout: TLS_HANDSHAKE_TIMEOUT_MS },
    (socket) => {
      closeWholeSocket(socket);
      /**
       * The handshake is done: smtp-server arms its own idle timeout. The
       * handshake timeout's listener goes too, or the session's idle
       * timeout would destroy the socket before smtp-server sends its 421.
       */
      socket.setTimeout(0);
      socket.removeAllListeners("timeout");
      smtp.connect(socket, { id: newSessionId() });
    },
  );
  listener.on("connection", (socket: Socket) => {
    closeWholeSocket(socket);
    socket.setTimeout(TLS_HANDSHAKE_TIMEOUT_MS, () => {
      logger.warn("SMTP submission TLS handshake timed out", {
        ip: socket.remoteAddress,
        timeoutMs: TLS_HANDSHAKE_TIMEOUT_MS,
      });
      socket.destroy();
    });
  });
  listener.on("tlsClientError", (error: Error, socket: Socket) => {
    const code: unknown = Reflect.get(error, "code");
    logger.warn("SMTP submission TLS handshake failed", {
      ip: socket.remoteAddress,
      code: typeof code === "string" ? code : null,
      error: error.message,
    });
  });
  return listener;
}
