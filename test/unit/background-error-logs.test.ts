import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  spyOn,
  type Mock,
} from "bun:test";
import { DrizzleQueryError } from "drizzle-orm";
import * as webhookDelivery from "../../src/modules/webhooks/services/webhook-delivery.service.ts";
import {
  runCleanupCycle,
  runPollCycle,
} from "../../src/modules/webhooks/services/webhook-delivery-worker.service.ts";
import * as domainService from "../../src/modules/domains/services/domain.service.ts";
import {
  notifyInboundReceived,
  type InboundNotifyDeps,
  type NotifyInboundInput,
} from "../../src/modules/inbound/services/inbound-notify.service.ts";
import { NotifyThrottle } from "../../src/modules/inbound/services/notify-throttle.ts";
import { DkimSigningFailedError } from "../../src/modules/emails/services/mailer.service.ts";
import type { Domain } from "../../src/modules/domains/types/domain.types.ts";
import { logger } from "../../src/utils/logger.ts";

/**
 * Background services never log a database error's raw message (#458): a
 * drizzle query error's message embeds the query and its bound values
 * (addresses, subjects, a consumer's reply), so the webhook worker and the
 * inbound notifications log it through `loggableError` (the SQLSTATE only).
 * A typed, expected failure logs at `warn` with its class. The logger is
 * spied, not mocked: the assertions read the raw arguments of each call,
 * so they check the call sites, not the logger's own redaction.
 */

const RECIPIENT = "reader@example.org";
const SUBJECT = "Quarterly numbers for the board";

/** A failed write as drizzle raises it: the message carries every parameter. */
function drizzleError(params: unknown[]): DrizzleQueryError {
  const cause = Object.assign(new Error("injected failure"), { errno: "23514" });
  return new DrizzleQueryError(
    "update webhook_deliveries set last_error = $1 where to_address = $2",
    params,
    cause,
  );
}

const SANITIZED = "Database query failed (SQLSTATE 23514)";

let spies: Mock<(message: string, data?: Record<string, unknown>) => void>[] = [];
let warnLog: Mock<(message: string, data?: Record<string, unknown>) => void>;
let errorLog: Mock<(message: string, data?: Record<string, unknown>) => void>;
let restore: (() => void)[] = [];

beforeEach(() => {
  spies = (["debug", "info", "warn", "error"] as const).map((level) =>
    spyOn(logger, level).mockImplementation(() => undefined),
  );
  warnLog = spies[2]!;
  errorLog = spies[3]!;
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
  for (const undo of restore) undo();
  restore = [];
});

/** Every call the logger received, as one string. */
function everythingLogged(): string {
  return JSON.stringify(spies.map((spy) => spy.mock.calls));
}

/** The data of the one call to `log` whose message is `message`. */
function lineData(
  log: Mock<(message: string, data?: Record<string, unknown>) => void>,
  message: string,
): Record<string, unknown> | undefined {
  const calls = log.mock.calls.filter(([text]) => text === message);
  expect(calls).toHaveLength(1);
  return calls[0]?.[1];
}

describe("webhook delivery worker", () => {
  test("a failed outcome write logs the SQLSTATE, never the parameters", async () => {
    const claim = spyOn(webhookDelivery, "claimDueDeliveries").mockResolvedValue([
      {
        id: "whd_1",
        webhookId: "wh_1",
        event: "email.sent",
        payload: "{}",
        attempts: 0,
        url: "https://hooks.example.com/a",
        secret: "s",
      },
    ]);
    const attempt = spyOn(webhookDelivery, "performHttpAttempt").mockResolvedValue({
      ok: true,
      status: 200,
      error: null,
      bodyPreview: null,
    });
    const record = spyOn(webhookDelivery, "recordAttempt").mockRejectedValue(
      drizzleError([`reply mentions ${RECIPIENT}`, RECIPIENT]),
    );
    restore = [
      () => claim.mockRestore(),
      () => attempt.mockRestore(),
      () => record.mockRestore(),
    ];

    expect(await runPollCycle()).toEqual({ claimed: 1 });

    expect(
      lineData(errorLog, "Webhook worker: failed to persist attempt outcome"),
    ).toEqual({ deliveryId: "whd_1", error: SANITIZED });
    expect(everythingLogged()).not.toContain(RECIPIENT);
  });

  test("a failed claim or cleanup logs the SQLSTATE, never the parameters", async () => {
    const claim = spyOn(webhookDelivery, "claimDueDeliveries").mockRejectedValue(
      drizzleError([RECIPIENT]),
    );
    const purge = spyOn(webhookDelivery, "purgeOldDeliveries").mockRejectedValue(
      drizzleError([RECIPIENT]),
    );
    restore = [() => claim.mockRestore(), () => purge.mockRestore()];

    expect(await runPollCycle()).toEqual({ claimed: 0 });
    expect(await runCleanupCycle()).toEqual({ deleted: 0 });

    expect(lineData(errorLog, "Webhook worker: claim failed")).toEqual({
      error: SANITIZED,
    });
    expect(lineData(errorLog, "Webhook worker: cleanup failed")).toMatchObject({
      error: SANITIZED,
    });
    expect(everythingLogged()).not.toContain(RECIPIENT);
  });
});

const DOMAIN: Domain = {
  id: "dom_1",
  name: "example.com",
  dkimPrivateKey: null,
  dkimPublicKey: null,
  dkimSelector: "bunmail",
  dkimPendingSelector: null,
  dkimPendingPrivateKey: null,
  dkimPendingPublicKey: null,
  dkimPendingCreatedAt: null,
  dkimPreviousSelector: null,
  dkimPreviousPublicKey: null,
  dkimRotatedAt: null,
  spfVerified: true,
  dkimVerified: true,
  dmarcVerified: true,
  verifiedAt: new Date(),
  lastCheckedAt: null,
  nextCheckAt: null,
  consecutiveFailures: 0,
  lastCheckResult: null,
  unsubscribeEmail: null,
  unsubscribeUrl: null,
  notifyEmail: "owner@example.com",
  trackOpens: false,
  trackClicks: false,
  trackingEpoch: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdByUserId: null,
};

const INBOUND: NotifyInboundInput = {
  inboundId: "inb_1",
  from: "sender@elsewhere.example.net",
  recipients: ["inbox@example.com"],
  subject: SUBJECT,
  text: "Hello",
  headerLines: [],
  returnPath: "sender@elsewhere.example.net",
  sizeBytes: 100,
};

/** Notification deps whose send throws `error`. */
function failingSend(error: Error): InboundNotifyDeps {
  return {
    send: async () => {
      throw error;
    },
    now: () => Date.now(),
    throttle: new NotifyThrottle(),
  };
}

describe("inbound notifications", () => {
  test("a DKIM key that cannot sign is expected: warn with the error class", async () => {
    const exists = spyOn(domainService, "domainExistsByName").mockResolvedValue(false);
    const byName = spyOn(domainService, "getDomainByName").mockResolvedValue(DOMAIN);
    restore = [() => exists.mockRestore(), () => byName.mockRestore()];

    await notifyInboundReceived(
      INBOUND,
      failingSend(new DkimSigningFailedError("example.com")),
    );

    expect(lineData(warnLog, "Inbound notification failed to send")).toEqual({
      inboundId: "inb_1",
      domain: "example.com",
      errorName: "DkimSigningFailedError",
      error: "DKIM key for example.com cannot be used to sign: not sent unsigned",
    });
    expect(errorLog).not.toHaveBeenCalled();
  });

  test("a failed domain lookup logs the SQLSTATE, never the parameters", async () => {
    const exists = spyOn(domainService, "domainExistsByName").mockResolvedValue(false);
    const byName = spyOn(domainService, "getDomainByName").mockRejectedValue(
      drizzleError([RECIPIENT, SUBJECT]),
    );
    restore = [() => exists.mockRestore(), () => byName.mockRestore()];

    await notifyInboundReceived(INBOUND, failingSend(new Error("never sent")));

    expect(lineData(errorLog, "Inbound notification handler error")).toEqual({
      inboundId: "inb_1",
      error: SANITIZED,
    });
    expect(everythingLogged()).not.toContain(RECIPIENT);
    expect(everythingLogged()).not.toContain(SUBJECT);
  });
});
