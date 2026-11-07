import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { redactEmail } from "../../utils/redact.ts";
import { EmailSendRejectedError } from "../../modules/emails/errors.ts";
import { SendEmailPage } from "../routes/send-email.tsx";
import { memberGuard } from "../guards.tsx";
import { sendSuccessFlash } from "../send-warnings.ts";
import { flashMessageFor } from "../flash-errors.ts";
import * as emailService from "../../modules/emails/services/email.service.ts";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import * as replyThreading from "../../modules/inbound/services/reply-threading.service.ts";
import { toFlash } from "../lib/responses.ts";
import { recordActorOf } from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/**
 * The send form and its POST. The first group of `emailPages`
 * (`emails.plugin.tsx`).
 */
export function emailSendPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/send
       * Send email page: compose form with flash message support. Includes
       * an explicit "Sending as" api-key picker (#89) so the operator
       * always knows which key is charged with the send and any resulting
       * auto-suppressions.
       */
      .get(
        "/send",
        async ({ query, auth }) => {
          /** A member picks only from the keys it created (#219); admins and the owner from every key. */
          const keys = await apiKeyService.listApiKeys(recordActorOf(auth));
          /** Only active keys are eligible: disabled keys are filtered out
           *  so the dropdown reflects what's actually usable. */
          const activeKeys = keys.filter((k) => k.isActive);
          const defaultApiKeyId = activeKeys[0]?.id;

          const flash = toFlash(query.flash, query.flashType);

          return (
            <SendEmailPage
              flash={flash}
              apiKeys={activeKeys}
              defaultApiKeyId={defaultApiKeyId}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/send
       * Sends an email via form submission. The operator picks the api key
       * explicitly via the form (#89). We re-validate that the key is
       * still active before sending so a stale form fails loud instead of
       * silently falling back to a different key. A member may send only with
       * a key it created (#219): any other key id, an admin's or the owner's
       * included, is "not available" like a missing key, and nothing is sent.
       */
      .post(
        "/send",
        async ({ body, set, auth }) => {
          const keys = await apiKeyService.listApiKeys(recordActorOf(auth));
          /** Match exactly what the form submitted: no implicit fallback. */
          const chosenKey = keys.find((k) => k.id === body.apiKeyId);

          if (!chosenKey || !chosenKey.isActive) {
            logger.warn("Dashboard send refused: API key not available to the user", {
              apiKeyId: body.apiKeyId,
              userId: auth.user.id,
              role: auth.user.role,
            });
            set.status = 302;
            set.headers["location"] =
              `/dashboard/send?flash=${encodeURIComponent("Selected API key is not available. Pick an active one and try again.")}&flashType=error`;
            return "";
          }

          try {
            /**
             * A reply to an inbound email (#192): the form names the email
             * by id and the threading headers are computed here from its
             * validated, stored ids, then go through the custom-header
             * rules like any other (#177).
             */
            const headers = body.inboundId
              ? await replyThreading.replyHeadersForInbound(body.inboundId)
              : undefined;
            const { warnings } = await emailService.createEmail(
              {
                from: body.from,
                to: body.to,
                cc: body.cc || undefined,
                bcc: body.bcc || undefined,
                replyTo: body.replyTo || undefined,
                subject: body.subject,
                html: body.html || undefined,
                text: body.text || undefined,
                ...(headers ? { headers } : {}),
                /**
                 * Never tracked (#187): a message written by hand (often a
                 * reply) and the form has no opt-out, so it always opts out.
                 */
                tracking: { opens: false, clicks: false },
              },
              chosenKey.id,
            );

            logger.info("Email sent via dashboard", {
              to: redactEmail(body.to),
              apiKeyId: chosenKey.id,
            });
            set.status = 302;
            /** Unverified sender-domain records are named in the flash (#245). */
            set.headers["location"] =
              `/dashboard/send?flash=${encodeURIComponent(sendSuccessFlash(warnings))}`;
          } catch (error) {
            if (error instanceof EmailSendRejectedError) {
              /** Refused on its input (#245): expected; the service logged the email id. */
              logger.warn("Dashboard send refused", {
                apiKeyId: chosenKey.id,
                code: error.code,
              });
            } else {
              logger.error("Failed to send email via dashboard", {
                error: error instanceof Error ? error.message : String(error),
              });
            }
            set.status = 302;
            set.headers["location"] =
              `/dashboard/send?flash=${encodeURIComponent(flashMessageFor(error, "Failed to send email"))}&flashType=error`;
          }
          return "";
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({
            apiKeyId: t.String(),
            from: t.String({ format: "email" }),
            to: t.String({ format: "email" }),
            /**
             * Same header-injection guard as the REST `sendEmailDto` (#133):
             * length cap + CR/LF rejected. The dashboard path previously took
             * cc/bcc/subject unrestricted (#202).
             */
            cc: t.Optional(
              t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" }),
            ),
            bcc: t.Optional(
              t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" }),
            ),
            /** Same guard as the API DTO: length cap + CR/LF rejected (#169). */
            replyTo: t.Optional(
              t.String({ maxLength: 1000, pattern: "^[^\\u000d\\u000a]*$" }),
            ),
            subject: t.String({ maxLength: 500, pattern: "^[^\\u000d\\u000a]*$" }),
            html: t.Optional(t.String()),
            text: t.Optional(t.String()),
            /** The inbound email a reply answers (#192): an id, never header text. */
            inboundId: t.Optional(t.String({ maxLength: 36 })),
          }),
        },
      )
  );
}
