/**
 * A real STARTTLS client for the inbound STARTTLS tests (#414), run under
 * Node by `test/integration/inbound-starttls.integration.test.ts`, so the
 * client is never the thing under test: the BunMail receiver runs under Bun
 * in the test process.
 *
 * Usage: node smtp-starttls-client.mjs <mode> <port>
 *   deliver        EHLO, STARTTLS, EHLO again over TLS, then one message
 *   plaintext      EHLO, then one message without STARTTLS
 *   bad-handshake  EHLO, STARTTLS, then plaintext instead of a ClientHello
 *
 * Hang-up modes, each after STARTTLS and EHLO over TLS, repeated
 * `STARTTLS_REPEAT` times (default 1), one connection after the other:
 *   hangup      drops the connection without QUIT
 *   half-close  `end()`: waits for the server to close
 *   quit        QUIT, then drops the connection on the `221`
 *
 * The recipient comes from `STARTTLS_RCPT` and the subject from
 * `STARTTLS_SUBJECT`. The server presents `mx1.example.test`, a leaf of
 * the test CA (`test/fixtures/tls/`), and the client verifies it against
 * that CA under that name.
 *
 * Always prints exactly one JSON line and exits: the outcome, or
 * `{ ok: false, error, ... }` with what went wrong.
 */
import { readFileSync } from "node:fs";
import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";

const [mode, portArg] = process.argv.slice(2);
const port = Number(portArg);
const host = "127.0.0.1";
const rcpt = process.env["STARTTLS_RCPT"] ?? "inbox@example.org";
const subject = process.env["STARTTLS_SUBJECT"] ?? "over STARTTLS";
const repeat = Number(process.env["STARTTLS_REPEAT"] ?? "1");

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
setTimeout(() => done({ ok: false, error: "client timed out" }), 20_000).unref();

/** Resolves with the reply lines on `socket`, up to a final line (`NNN `). */
function readReply(socket) {
  return new Promise((resolve, reject) => {
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
          cleanup();
          resolve(lines);
          return;
        }
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error(`server closed the connection after ${JSON.stringify(lines)}`));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

/** Writes `line` and resolves with the reply lines. */
function command(socket, line) {
  const reply = readReply(socket);
  socket.write(`${line}\r\n`);
  return reply;
}

/** Throws unless the last reply line starts with `code`. */
function expectCode(lines, code, what) {
  const last = lines.at(-1) ?? "";
  if (!last.startsWith(`${code} `)) throw new Error(`${what}: ${last}`);
}

/** Opens a plaintext connection and resolves after the `220` greeting and EHLO. */
async function plaintextSession() {
  const socket = connectTcp({ host, port });
  socket.on("error", () => undefined);
  const greeting = await readReply(socket);
  expectCode(greeting, 220, "greeting");
  const ehlo = await command(socket, "EHLO client.example.test");
  expectCode(ehlo, 250, "EHLO");
  return { socket, ehlo };
}

/** Upgrades `socket` after `STARTTLS` and resolves with the TLS socket. */
function upgrade(socket) {
  return new Promise((resolve, reject) => {
    const secure = connectTls({ socket, ca, servername });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", reject);
  });
}

/** One message through the session on `socket`; resolves with the final reply. */
async function deliver(socket) {
  expectCode(await command(socket, "MAIL FROM:<sender@example.net>"), 250, "MAIL FROM");
  expectCode(await command(socket, `RCPT TO:<${rcpt}>`), 250, "RCPT TO");
  expectCode(await command(socket, "DATA"), 354, "DATA");
  const body =
    `From: sender@example.net\r\nTo: ${rcpt}\r\nSubject: ${subject}\r\n` +
    `Message-ID: <${Date.now()}.${Math.random()}@example.net>\r\n\r\nhello\r\n.`;
  const reply = await command(socket, body);
  expectCode(reply, 250, "end of DATA");
  return reply.at(-1);
}

/** EHLO, STARTTLS, the handshake and EHLO again over TLS. */
async function secureSession() {
  const { socket, ehlo: ehloBefore } = await plaintextSession();
  expectCode(await command(socket, "STARTTLS"), 220, "STARTTLS");
  const secure = await upgrade(socket);
  secure.on("error", () => undefined);
  const ehloAfter = await command(secure, "EHLO client.example.test");
  expectCode(ehloAfter, 250, "EHLO over TLS");
  return { secure, ehloBefore, ehloAfter, protocol: secure.getProtocol() };
}

/** Resolves once `socket` is closed, with whether the server ended it first. */
function closed(socket) {
  return new Promise((resolve, reject) => {
    let serverEnded = false;
    socket.on("end", () => (serverEnded = true));
    if (socket.destroyed) return resolve({ serverEnded });
    const timer = setTimeout(() => reject(new Error("socket never closed")), 5000);
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ serverEnded });
    });
  });
}

/** The hang-up modes: one connection each, resolved once it is gone. */
const HANG_UPS = {
  hangup: async () => {
    const { secure } = await secureSession();
    secure.destroy();
    return closed(secure);
  },
  "half-close": async () => {
    const { secure } = await secureSession();
    secure.end();
    return closed(secure);
  },
  quit: async () => {
    const { secure } = await secureSession();
    const serverEnded = new Promise((resolve) => {
      secure.once("end", resolve);
      secure.once("close", resolve);
    });
    const reply = await command(secure, "QUIT");
    await serverEnded;
    secure.destroy();
    return { response: reply.at(-1), ...(await closed(secure)) };
  },
};

try {
  if (mode === "deliver") {
    const { secure, ehloBefore, ehloAfter, protocol } = await secureSession();
    const response = await deliver(secure);
    await command(secure, "QUIT");
    secure.destroy();
    done({ ok: true, protocol, ehloBefore, ehloAfter, response });
  } else if (mode === "plaintext") {
    const { socket, ehlo } = await plaintextSession();
    const response = await deliver(socket);
    await command(socket, "QUIT");
    socket.destroy();
    done({ ok: true, ehloBefore: ehlo, response });
  } else if (mode === "bad-handshake") {
    const { socket } = await plaintextSession();
    expectCode(await command(socket, "STARTTLS"), 220, "STARTTLS");
    const received = [];
    socket.on("data", (chunk) => received.push(chunk));
    socket.write("EHLO not-a-client-hello.example.test\r\n");
    const result = await closed(socket);
    const text = Buffer.concat(received).toString("latin1");
    done({ ok: true, serverEnded: result.serverEnded, text });
  } else if (mode in HANG_UPS) {
    let last = {};
    for (let run = 0; run < repeat; run++) last = await HANG_UPS[mode]();
    done({ ok: true, runs: repeat, ...last });
  } else {
    done({ ok: false, error: `unknown mode ${mode}` });
  }
} catch (error) {
  done({ ok: false, error: error.message });
}
