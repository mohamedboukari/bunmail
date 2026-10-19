/**
 * A real `smtp-server` receiving MX for the outbound TLS tests (#250), run
 * under Node by `test/unit/mx-transport.test.ts`: Bun cannot upgrade an
 * accepted socket to TLS on the server side, so STARTTLS needs Node here.
 * The client side (nodemailer, the code under test) still runs under Bun.
 *
 * Usage: node smtp-tls-server.mjs <starttls|plaintext|tls11>
 *   starttls   offers STARTTLS (TLS 1.2 and up)
 *   plaintext  does not offer STARTTLS
 *   tls11      offers STARTTLS, but only TLS 1.0 and 1.1
 *
 * Prints `{"port":N}` on one line once listening, then counts each
 * accepted message and connection on stdout (`{"message":N}`,
 * `{"connection":N}`). Exits when stdin closes. The key and certificate are
 * the test-only pair under `test/fixtures/tls/`.
 */
import { readFileSync } from "node:fs";
import { SMTPServer } from "smtp-server";

const mode = process.argv[2];
const here = new URL(".", import.meta.url);
const key = readFileSync(new URL("tls/hook.example.test.key.pem", here));
const cert = readFileSync(new URL("tls/hook.example.test.cert.pem", here));

/** TLS 1.1 needs OpenSSL security level 0 in Node 17 and later. */
const tls11 = {
  minVersion: "TLSv1",
  maxVersion: "TLSv1.1",
  ciphers: "DEFAULT@SECLEVEL=0",
};

let messages = 0;
let connections = 0;

const server = new SMTPServer({
  key,
  cert,
  authOptional: true,
  logger: false,
  ...(mode === "plaintext" ? { disabledCommands: ["STARTTLS"] } : {}),
  ...(mode === "tls11" ? tls11 : {}),
  onConnect(_session, callback) {
    connections += 1;
    process.stdout.write(`${JSON.stringify({ connection: connections })}\n`);
    callback();
  },
  onData(stream, _session, callback) {
    stream.on("data", () => undefined);
    stream.on("end", () => {
      messages += 1;
      process.stdout.write(`${JSON.stringify({ message: messages })}\n`);
      callback();
    });
  },
});

/** A refused handshake is the point of the tls11 mode, not a crash. */
server.on("error", () => undefined);

server.listen(0, "127.0.0.1", () => {
  const address = server.server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  process.stdout.write(`${JSON.stringify({ port })}\n`);
});

process.stdin.on("end", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
process.stdin.resume();
