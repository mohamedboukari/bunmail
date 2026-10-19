/**
 * A real `smtp-server` receiving MX for the outbound TLS tests (#250), run
 * under Node by `test/unit/mx-transport.test.ts`: Bun cannot upgrade an
 * accepted socket to TLS on the server side, so STARTTLS needs Node here.
 * The client side (nodemailer, the code under test) still runs under Bun.
 *
 * Usage: node smtp-tls-server.mjs <mode> [certificate name]
 *   starttls   offers STARTTLS (TLS 1.2 and up)
 *   plaintext  does not offer STARTTLS
 *   tls11      offers STARTTLS, but only TLS 1.0 and 1.1
 *   silent     accepts the TCP connection and never says anything (no smtp-server)
 *   mute-tls   greets, offers STARTTLS, answers it with 220, then never
 *              answers again: the TLS handshake never completes (no smtp-server)
 *   stall-data offers STARTTLS (TLS 1.2 and up), then never answers the end
 *              of DATA: a session stuck after a completed TLS handshake
 *   busy       greets every connection with `421` and closes it (#250)
 *   rcpt-codes offers STARTTLS and answers RCPT TO by local part (#250):
 *              `soft...` gets `450 4.2.1`, `hard...` gets `550 5.1.1`,
 *              anything else is accepted
 *   slow       does not offer STARTTLS, and answers the end of DATA after
 *              300 ms, so overlapping sessions show in `peak` (#250)
 *
 * Prints `{"port":N}` on one line once listening, then counts on stdout
 * each accepted message and connection, the open connections whenever
 * that number changes, the connections closed by either side, and the most
 * messages ever in DATA at once (`{"message":N}`, `{"connection":N}`,
 * `{"open":N}`, `{"closed":N}`, `{"peak":N}`). Exits when stdin
 * closes. The key and certificate are a test-only pair under
 * `test/fixtures/tls/`: `<certificate name>.key.pem` and `.cert.pem`,
 * `hook.example.test` (self-signed) by default. The MTA-STS tests (#250)
 * pass a name whose certificate the test CA (`test-ca.cert.pem`) signed.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { SMTPServer } from "smtp-server";

const mode = process.argv[2];
const certName = process.argv[3] ?? "hook.example.test";
const here = new URL(".", import.meta.url);
const key = readFileSync(new URL(`tls/${certName}.key.pem`, here));
const cert = readFileSync(new URL(`tls/${certName}.cert.pem`, here));

/** TLS 1.1 needs OpenSSL security level 0 in Node 17 and later. */
const tls11 = {
  minVersion: "TLSv1",
  maxVersion: "TLSv1.1",
  ciphers: "DEFAULT@SECLEVEL=0",
};

let messages = 0;
let connections = 0;
let closed = 0;
/** Messages between the start of DATA and its reply, now and at most. */
let inData = 0;
let peak = 0;

/** Writes one counter line. */
function report(line) {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/**
 * Reports the number of open TCP connections whenever it changes, from
 * the listening server's own count: smtp-server removes every listener
 * from a socket it upgrades to TLS, so a `close` listener would miss it.
 */
function reportOpen(netServer) {
  let last = -1;
  setInterval(() => {
    netServer.getConnections((error, count) => {
      if (error || count === last) return;
      if (count < last) {
        closed += last - count;
        report({ closed });
      }
      last = count;
      report({ open: count });
    });
  }, 20).unref();
}

/** A receiver that accepts and never answers, or stops after STARTTLS. */
function rawServer() {
  return createServer((socket) => {
    connections += 1;
    report({ connection: connections });
    socket.on("error", () => undefined);
    if (mode === "silent") return;
    socket.write("220 mute.example.test ESMTP\r\n");
    let buffered = "";
    let muted = false;
    socket.on("data", (chunk) => {
      if (muted) return;
      buffered += chunk.toString("latin1");
      let end = buffered.indexOf("\r\n");
      while (end >= 0 && !muted) {
        const command = buffered.slice(0, end).toUpperCase();
        buffered = buffered.slice(end + 2);
        end = buffered.indexOf("\r\n");
        if (command.startsWith("EHLO")) {
          socket.write("250-mute.example.test\r\n250 STARTTLS\r\n");
        } else if (command === "STARTTLS") {
          socket.write("220 Ready to start TLS\r\n");
          muted = true;
        } else {
          socket.write("502 Not implemented\r\n");
        }
      }
    });
  });
}

if (mode === "silent" || mode === "mute-tls") {
  const raw = rawServer();
  reportOpen(raw);
  raw.listen(0, "127.0.0.1", () => {
    const address = raw.address();
    report({ port: typeof address === "object" && address !== null ? address.port : 0 });
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
} else {
  startSmtpServer();
}

function startSmtpServer() {
  const server = new SMTPServer({
    key,
    cert,
    authOptional: true,
    logger: false,
    ...(mode === "plaintext" || mode === "slow"
      ? { disabledCommands: ["STARTTLS"] }
      : {}),
    ...(mode === "tls11" ? tls11 : {}),
    onConnect(_session, callback) {
      connections += 1;
      report({ connection: connections });
      if (mode === "busy") {
        const busy = new Error("4.3.2 Too busy, try another server");
        busy.responseCode = 421;
        callback(busy);
        return;
      }
      callback();
    },
    onRcptTo(address, _session, callback) {
      const local = address.address.split("@")[0] ?? "";
      if (mode === "rcpt-codes" && local.startsWith("soft")) {
        const soft = new Error("4.2.1 Mailbox busy, try later");
        soft.responseCode = 450;
        callback(soft);
        return;
      }
      if (mode === "rcpt-codes" && local.startsWith("hard")) {
        const hard = new Error("5.1.1 No such user");
        hard.responseCode = 550;
        callback(hard);
        return;
      }
      callback();
    },
    onData(stream, _session, callback) {
      inData += 1;
      if (inData > peak) {
        peak = inData;
        report({ peak });
      }
      stream.on("data", () => undefined);
      stream.on("end", () => {
        messages += 1;
        report({ message: messages });
        const reply = () => {
          inData -= 1;
          callback();
        };
        /** stall-data: the message is in, the reply never comes. */
        if (mode === "stall-data") return;
        if (mode === "slow") setTimeout(reply, 300);
        else reply();
      });
    },
  });

  reportOpen(server.server);

  /** A refused handshake is the point of the tls11 mode, not a crash. */
  server.on("error", () => undefined);

  server.listen(0, "127.0.0.1", () => {
    const address = server.server.address();
    report({ port: typeof address === "object" && address !== null ? address.port : 0 });
  });

  process.stdin.on("end", () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
  process.stdin.resume();
}
