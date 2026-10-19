import { describe, test, expect } from "bun:test";
import { readSubmissionTls, type SubmissionTlsSettings } from "../../src/config.ts";

/**
 * `SMTP_SUBMISSION_TLS_MODE` (#349): implicit TLS by default with a cert,
 * 465 as its default port, strict values, and `starttls` refused under
 * Bun, which cannot complete a server-side STARTTLS handshake.
 */
describe("readSubmissionTls", () => {
  const CERT = "/etc/bunmail/tls/cert.pem";
  const KEY = "/etc/bunmail/tls/key.pem";

  const read = (
    raw: { mode?: string; certPath?: string; keyPath?: string; port?: string },
    onBun = true,
  ): SubmissionTlsSettings =>
    readSubmissionTls(
      {
        mode: raw.mode,
        certPath: raw.certPath,
        keyPath: raw.keyPath,
        port: raw.port,
      },
      onBun,
    );

  test("no cert: mode none on 587", () => {
    expect(read({})).toEqual({ mode: "none", certPath: "", keyPath: "", port: 587 });
    expect(read({ mode: "", certPath: "", keyPath: " " }).mode).toBe("none");
  });

  test("a cert and key: implicit TLS by default, on 465", () => {
    expect(read({ certPath: CERT, keyPath: KEY })).toEqual({
      mode: "implicit",
      certPath: CERT,
      keyPath: KEY,
      port: 465,
    });
    expect(read({ mode: " ", certPath: CERT, keyPath: KEY }).mode).toBe("implicit");
  });

  test("implicit, explicitly", () => {
    expect(read({ mode: "implicit", certPath: CERT, keyPath: KEY })).toMatchObject({
      mode: "implicit",
      port: 465,
    });
  });

  test("an explicit port wins in every mode", () => {
    expect(read({ certPath: CERT, keyPath: KEY, port: "587" }).port).toBe(587);
    expect(read({ port: "2587" }).port).toBe(2587);
    expect(read({ port: " " }).port).toBe(587);
  });

  test.each(["0", "65536", "-1", "465.5", "abc", "0x1d1"])(
    "refuses the port %p",
    (port) => {
      expect(() => read({ certPath: CERT, keyPath: KEY, port })).toThrow(
        /SMTP_SUBMISSION_PORT must be a whole number from 1 to 65535/,
      );
    },
  );

  test("starttls is refused under Bun, pointing at implicit TLS on 465", () => {
    expect(() => read({ mode: "starttls", certPath: CERT, keyPath: KEY }, true)).toThrow(
      /SMTP_SUBMISSION_TLS_MODE=starttls is not supported on Bun[\s\S]*port 465/,
    );
  });

  test("starttls is allowed under Node, on 587", () => {
    expect(read({ mode: "starttls", certPath: CERT, keyPath: KEY }, false)).toMatchObject(
      {
        mode: "starttls",
        port: 587,
      },
    );
  });

  test.each(["IMPLICIT", "tls", "ssl", "none", "STARTTLS", "true", "465"])(
    "refuses the mode %p",
    (mode) => {
      expect(() => read({ mode, certPath: CERT, keyPath: KEY })).toThrow(
        /SMTP_SUBMISSION_TLS_MODE must be "implicit" or "starttls"/,
      );
    },
  );

  test.each(["implicit", "starttls"])("refuses the mode %p without a cert", (mode) => {
    expect(() => read({ mode }, false)).toThrow(/needs a certificate/);
  });

  test("refuses a cert without a key, and a key without a cert", () => {
    expect(() => read({ certPath: CERT })).toThrow(/must be set together/);
    expect(() => read({ keyPath: KEY })).toThrow(/must be set together/);
  });
});
