import type {
  SMTPServerOptions,
  SMTPServerAuthentication,
  SMTPServerSession,
  SMTPServerAuthenticationResponse,
} from "smtp-server";
import { config } from "../../../config.ts";
import { logger } from "../../../utils/logger.ts";
import { loggableError } from "../../../utils/db-error.ts";
import { sharedStoreErrorCode } from "../../../utils/shared-store.ts";
import { hashApiKey } from "../../../utils/crypto.ts";
import { findByHash } from "../../api-keys/services/api-key.service.ts";
import { takeSubmissionConnection, throttledAuth } from "./submission-limits.ts";
import { recordSmtpConnection } from "../../metrics/services/metrics.service.ts";
import {
  inSession,
  sessionSpans,
  sessionStats,
  smtpError,
} from "./smtp-submission-session.service.ts";

/**
 * Maximum recipients accepted per transaction. A submission client that
 * blows past this is almost certainly misbehaving; legitimate
 * transactional mail rarely exceeds a handful.
 */
const MAX_RECIPIENTS_PER_TRANSACTION = 50;

/**
 * The connection, AUTH and RCPT TO handlers of the submission server, for
 * `start()` to spread into its `SMTPServer` options. `connectionRateLimit`
 * is the one `start()` read from the config.
 */
export function submissionSessionHandlers({
  connectionRateLimit,
}: {
  connectionRateLimit: typeof config.smtpSubmission.connectionRateLimit;
}): Pick<SMTPServerOptions, "onClose" | "onConnect" | "onAuth" | "onRcptTo"> {
  return {
    /**
     * One summary line per connection when it closes (#284): who, how many
     * messages, how long. Runs in the session's log context.
     */
    onClose(session) {
      const stats = sessionStats.get(session.id);
      sessionStats.delete(session.id);
      inSession(session, () => {
        logger.info("SMTP session closed", {
          remoteAddress: session.remoteAddress,
          messages: stats?.messages ?? 0,
          durationMs:
            stats === undefined ? null : Math.round(performance.now() - stats.startedAt),
        });
      });
      sessionSpans.close(session.id, stats?.messages ?? 0);
    },

    /**
     * Per-IP connection rate limiting, in the shared store (#185): memory,
     * or one Redis round trip with `REDIS_URL`. Runs before AUTH to blunt
     * connection churn. SMTP 421 = temporary rejection.
     */
    onConnect(session: SMTPServerSession, callback: (err?: Error) => void) {
      sessionSpans.open(session.id);
      inSession(session, () => {
        sessionStats.set(session.id, { startedAt: performance.now(), messages: 0 });
        recordSmtpConnection("submission");
        if (!connectionRateLimit.enabled) return callback();
        const ip = session.remoteAddress;
        takeSubmissionConnection(
          ip,
          connectionRateLimit.max,
          connectionRateLimit.windowSec,
        )
          .then(
            (limited) => {
              if (!limited) return callback();
              logger.warn("SMTP submission connection rate limited", { ip });
              callback(
                smtpError("Too many connections, try again later", 421, "rate_limited"),
              );
            },
            (error: unknown) => {
              /**
               * Unexpected: the store falls back to memory on a Redis error.
               * The connection limit only blunts churn (AUTH is the guard),
               * so it lets the connection through rather than drop it.
               */
              logger.error(
                "SMTP submission connection limit failed: connection allowed",
                {
                  ip,
                  code: sharedStoreErrorCode(error),
                },
              );
              callback();
            },
          )
          /**
           * A throw inside a handler above (the reply already went out, or
           * never will): logged only, no second reply, and never an
           * unhandled rejection, which would end the process.
           */
          .catch((error: unknown) => {
            logger.error("SMTP submission connect handler failed", {
              ip,
              error: loggableError(error),
            });
          });
      });
    },

    /**
     * Authenticate the client. The password (falling back to the username
     * for clients that only fill one field) is treated as a `bm_live_` API
     * key: SHA-256 hashed and looked up. A per-IP failed-AUTH throttle
     * blunts key brute-forcing, shared by every replica with `REDIS_URL`
     * (#185); failures expire only with their window (#190). See
     * `submission-limits.ts`.
     */
    onAuth(
      auth: SMTPServerAuthentication,
      session: SMTPServerSession,
      callback: (
        err: Error | null | undefined,
        response?: SMTPServerAuthenticationResponse,
      ) => void,
    ) {
      inSession(session, () => {
        const ip = session.remoteAddress;
        /** Password is the API key; some clients only set the username. */
        const candidate = auth.password || auth.username || "";

        throttledAuth(ip, candidate, config.smtpSubmission.authRateLimit, (password) =>
          findByHash(hashApiKey(password)),
        )
          .then(
            (outcome) => {
              switch (outcome.status) {
                case "rate_limited":
                  logger.warn("SMTP submission AUTH rate limited", { ip });
                  /** 454 = temporary auth failure; client should back off. */
                  return callback(
                    smtpError(
                      "Too many failed authentication attempts",
                      454,
                      "auth_rate_limited",
                    ),
                  );
                case "no_credentials":
                  return callback(
                    smtpError("Authentication credentials required", 535, "auth_failed"),
                  );
                case "invalid":
                  logger.warn("SMTP submission AUTH failed: invalid or inactive key", {
                    ip,
                  });
                  return callback(smtpError("Invalid API key", 535, "auth_failed"));
                case "lookup_failed":
                  logger.error("SMTP submission AUTH lookup failed", {
                    ip,
                    error: loggableError(outcome.error),
                  });
                  /** 451 = local error; don't leak details, not counted as a guess. */
                  return callback(
                    smtpError("Temporary authentication failure", 451, "temporary"),
                  );
                case "authenticated":
                  /**
                   * Success: stash the key id. The IP's earlier failures stay
                   * until their window expires (#190).
                   */
                  logger.info("SMTP submission client authenticated", {
                    ip,
                    apiKeyId: outcome.key.id,
                    /** Whether the session is TLS (#349): always true with a cert. */
                    secure: session.secure,
                  });
                  return callback(null, { user: outcome.key.id });
              }
            },
            (error: unknown) => {
              /**
               * Unexpected (the store falls back to memory on a Redis error):
               * fail closed, the client retries later.
               */
              logger.error("SMTP submission AUTH throttle failed", {
                ip,
                code: sharedStoreErrorCode(error),
              });
              callback(smtpError("Temporary authentication failure", 451, "temporary"));
            },
          )
          /**
           * A throw inside a handler above (the reply already went out, or
           * never will): logged only, no second reply, and never an
           * unhandled rejection, which would end the process.
           */
          .catch((error: unknown) => {
            logger.error("SMTP submission AUTH handler failed", {
              ip,
              error: loggableError(error),
            });
          });
      });
    },

    /**
     * Cap recipients per transaction (open-relay-fanout defence). Unlike
     * the inbound receiver we do NOT validate the recipient domain:
     * submission legitimately sends to arbitrary external recipients; AUTH
     * is what prevents abuse.
     */
    onRcptTo(
      _address: { address: string },
      session: SMTPServerSession,
      callback: (err?: Error) => void,
    ) {
      inSession(session, () => {
        const acceptedSoFar = session.envelope.rcptTo?.length ?? 0;
        if (acceptedSoFar >= MAX_RECIPIENTS_PER_TRANSACTION) {
          logger.warn("SMTP submission RCPT TO rejected: too many recipients", {
            acceptedSoFar,
            ip: session.remoteAddress,
          });
          return callback(
            smtpError(
              `Too many recipients (max ${MAX_RECIPIENTS_PER_TRANSACTION} per transaction)`,
              452,
              "too_many_recipients",
            ),
          );
        }
        callback();
      });
    },
  };
}
