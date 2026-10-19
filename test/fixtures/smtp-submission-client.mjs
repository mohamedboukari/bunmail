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
 * subject of `send` from `SUBMISSION_SUBJECT`. Prints one JSON line with
 * the outcome and exits. The server's certificate is a self-signed test
 * one, so it is not verified.
 */
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import { createTransport } from "nodemailer";

const [mode, portArg] = process.argv.slice(2);
const port = Number(portArg);
const key = process.env["SUBMISSION_KEY"] ?? "";
const host = "127.0.0.1";

/** Writes the outcome line and exits. */
function done(result) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

/** Sends one message with nodemailer, implicit TLS or STARTTLS. */
async function sendWithNodemailer(implicit) {
  const transport = createTransport({
    host,
    port,
    secure: implicit,
    requireTLS: !implicit,
    auth: { user: "apikey", pass: key },
    tls: { rejectUnauthorized: false },
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
    done({ ok: false, code: error.code ?? null, message: error.message });
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

/** Opens TLS from the first byte and waits for the greeting. */
function tlsGreeting(next) {
  const socket = connectTls({ host, port, rejectUnauthorized: false });
  socket.setTimeout(5000, () => done({ ok: false, message: "timed out" }));
  socket.on("error", (error) => done({ ok: false, message: error.message }));
  readReply(socket, (greeting) => next(socket, greeting, socket.getProtocol()));
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
  done({ ok: false, message: `unknown mode ${mode}` });
}
