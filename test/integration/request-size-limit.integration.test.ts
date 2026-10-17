/**
 * The HTTP server rejects oversized request bodies before reading them.
 *
 * Bun's default limit is 128 MB, and Elysia parses a body before the auth
 * hooks run, so without a lower limit anyone could make the server buffer
 * and parse 128 MB per request without credentials. `app.handle()` does
 * not go through Bun's server, so this boots the real app (`src/index.ts`)
 * against the test database and talks to it over HTTP.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "path";

const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const BASE = `http://127.0.0.1:${PORT}`;

let app: ReturnType<typeof Bun.spawn> | undefined;
let appLog = "";

beforeAll(async () => {
  app = Bun.spawn(
    [process.execPath, join(import.meta.dir, "..", "..", "src", "index.ts")],
    {
      env: {
        ...process.env,
        PORT: String(PORT),
        HOST: "127.0.0.1",
        SMTP_ENABLED: "false",
        SMTP_SUBMISSION_ENABLED: "false",
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  /** Wait for the server to answer. */
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`${BASE}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await Bun.sleep(100);
  }
  throw new Error("app did not start");
});

afterAll(() => {
  app?.kill();
});

/** A request body that passes validation: only the API key is missing. */
function validSend(htmlBytes: number): string {
  return JSON.stringify({
    from: "hello@example.com",
    to: "user@example.com",
    subject: "x",
    html: "x".repeat(htmlBytes),
  });
}

function post(body: string): Promise<Response> {
  return fetch(`${BASE}/api/v1/emails/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("request body size limit", () => {
  test("a body over 12 MB is rejected with 413 before auth", async () => {
    expect((await post(validSend(13 * 1024 * 1024))).status).toBe(413);
  });

  test("a valid body under the limit reaches auth (401 without a key)", async () => {
    expect((await post(validSend(1024 * 1024))).status).toBe(401);
  });
});

describe("request validation errors (reachable without a key)", () => {
  test("an invalid body gets 422 that names the field but never echoes the input", async () => {
    const marker = "ECHO_MARKER_" + "y".repeat(2000);
    const res = await post(JSON.stringify({ html: marker }));
    const text = await res.text();

    expect(res.status).toBe(422);
    expect(text).toContain("VALIDATION_ERROR");
    expect(text).toContain("/from");
    expect(text).not.toContain("ECHO_MARKER_");
    /** Not logged as a server error, and the body is not written to the log. */
    await Bun.sleep(200);
    expect(appLog).not.toContain("ECHO_MARKER_");
    expect(appLog).not.toContain("Unhandled error");
  });

  test("malformed JSON gets 400", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("INVALID_BODY");
  });
});
