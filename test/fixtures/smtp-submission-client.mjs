/**
 * A real SMTP client for the submission TLS tests (#349), run under Node by
 * `test/integration/smtp-submission-tls.integration.test.ts`, so the client
 * is never the thing under test: the BunMail submission server runs under
 * Bun in the test process.
 *
 * Usage: node smtp-submission-client.mjs <mode> <port>
 *   send       nodemailer with implicit TLS ("SSL/TLS"): AUTH, one message
 *   starttls   nodemailer in STARTTLS mode (plaintext first, requireTLS)
 *   ehlo       TLS from the first byte, then the greeting and EHLO reply
 *   hangup     TLS, the greeting, then drops the connection without QUIT
 *   plaintext  no TLS at all: sends EHLO and AUTH PLAIN in the clear
 *
 * The API key comes from the `SUBMISSION_KEY` environment variable and the
 * subject of `send` from `SUBMISSION_SUBJECT`. The server presents
 * `mx1.example.test`, a leaf of the test CA (`test/fixtures/tls/`), and the
 * client verifies it against that CA under that name.
 *
 * Always prints exactly one JSON line and exits: the outcome, or
 * `{ ok: false, error, ... }` with what the server said when it refused,
 * closed early or never answered, so a failing test shows its cause.
 */
import { readFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import { createTransport } from "nodemailer";

const [mode, portArg] = process.argv.slice(2);
const port = Number(portArg);
const key = process.env["SUBMISSION_KEY"] ?? "";
const host = "127.0.0.1";

/** The test CA and the name on the server's certificate. */
const ca = readFileSync(new URL("tls/test-ca.cert.pem", import.meta.url));
const servername = "mx1.example.test";

let finished = false;

/** Writes the one outcome line and exits; later calls do nothing. */
function done(result) {
  if (finished) return;
  finished = true;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

process.on("uncaughtException", (error) =>
  done({ ok: false, error: `uncaught: ${error.message}` }),
);
/** A fixture that hangs still reports, before the test's own timeout. */
setTimeout(() => done({ ok: false, error: "client timed out" }), 10_000).unref();

/** Sends one message with nodemailer, implicit TLS or STARTTLS. */
async function sendWithNodemailer(implicit) {
  const transport = createTransport({
    host,
    port,
    secure: implicit,
    requireTLS: !implicit,
    auth: { user: "apikey", pass: key },
    tls: { ca, servername },
    connectionTimeout: 3000,
    greetingTimeout: 3000,
    socketTimeout: 5000,
  });
  try {
    const info = await transport.sendMail({
      from: "hello@unregistered.test",
      to: "user@example.org",
      subject: process.env["SUBMISSION_SUBJECT"] ?? "over implicit TLS",
      text: "hi",
    });
    done({ ok: true, response: info.response });
  } catch (error) {
    done({
      ok: false,
      error: error.message,
      code: error.code ?? null,
      response: error.response ?? null,
    });
  }
}

/**
 * Collects the SMTP reply lines on `socket` until a final line (`NNN `),
 * then calls `next` with them.
 */
function readReply(socket, next) {
  let buffered = "";
  const lines = [];
  const onData = (chunk) => {
    buffered += chunk.toString("latin1");
    let end = buffered.indexOf("\r\n");
    while (end >= 0) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      end = buffered.indexOf("\r\n");
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        socket.off("data", onData);
        next(lines);
        return;
      }
    }
  };
  socket.on("data", onData);
}

/**
 * Opens TLS from the first byte and waits for a `220` greeting. Anything
 * else (a `421` from the connection limit, a close, an error) ends the
 * run with that cause.
 */
function tlsGreeting(next) {
  const socket = connectTls({ host, port, ca, servername });
  let greeting = [];
  socket.setTimeout(5000, () => done({ ok: false, error: "timed out", greeting }));
  socket.on("error", (error) => done({ ok: false, error: error.message, greeting }));
  socket.on("close", () =>
    done({ ok: false, error: "server closed the connection", greeting }),
  );
  readReply(socket, (lines) => {
    greeting = lines;
    if (!(lines.at(-1) ?? "").startsWith("220 ")) {
      done({ ok: false, error: "no 220 greeting", greeting });
      return;
    }
    next(socket, lines, socket.getProtocol());
  });
}

if (mode === "send") {
  await sendWithNodemailer(true);
} else if (mode === "starttls") {
  await sendWithNodemailer(false);
} else if (mode === "ehlo") {
  tlsGreeting((socket, greeting, protocol) => {
    socket.write("EHLO client.example.test\r\n");
    readReply(socket, (ehlo) => {
      socket.end("QUIT\r\n");
      done({ ok: true, protocol, greeting, ehlo });
    });
  });
} else if (mode === "hangup") {
  tlsGreeting((socket, greeting) => {
    socket.destroy();
    done({ ok: true, greeting });
  });
} else if (mode === "plaintext") {
  const socket = connectTcp({ host, port });
  const received = [];
  const auth = Buffer.from(`\0apikey\0${key}`).toString("base64");
  socket.on("connect", () => {
    socket.write(`EHLO client.example.test\r\nAUTH PLAIN ${auth}\r\n`);
  });
  socket.on("data", (chunk) => received.push(chunk));
  socket.on("error", () => undefined);
  const finish = () => {
    const bytes = Buffer.concat(received);
    done({ ok: true, hex: bytes.toString("hex"), text: bytes.toString("latin1") });
  };
  socket.on("close", finish);
  setTimeout(finish, 2000);
} else {
  done({ ok: false, error: `unknown mode ${mode}` });
}
