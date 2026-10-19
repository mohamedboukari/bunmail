import { t } from "elysia";
import { logger } from "../../utils/logger.ts";
import { consumeRevealSecret, stashRevealSecret } from "../reveal-store.ts";
import { ApiKeyCreatorInactiveError } from "../../modules/api-keys/errors.ts";
import { ApiKeysPage } from "../routes/api-keys.tsx";
import { adminGuard, memberGuard } from "../guards.tsx";
import * as apiKeyService from "../../modules/api-keys/services/api-key.service.ts";
import { redirect, setNoStore, toFlash } from "../lib/responses.ts";
import { revealOwnerOf } from "../lib/reveal-owner.ts";
import { recordActorOf, managesAll, creatorDirectory } from "../lib/record-ownership.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";
import { dashboardAudit } from "../lib/audit.ts";
import { recordAuditEvent } from "../../modules/audit/services/audit.service.ts";

/**
 * Parses the comma-joined value the allowed-senders chip input submits
 * (#126) into a trimmed, non-empty address array. Empty string → `[]`
 * (unrestricted). The service normalises (lower-case + dedupe) again.
 */
function parseSenderList(input: string | undefined): string[] {
  return (input ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** API key pages (#291): list, create, admin flag, allowed senders, revoke. */
export function apiKeyPages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard/api-keys
       * API keys list with create form. Shows flash messages from query params.
       * Any signed-in account (#219): a member sees only the keys it created
       * (scoped in the service), admins and the owner every key.
       */
      .get(
        "/api-keys",
        async ({ query, auth, set }) => {
          setNoStore(set);
          const [keys, directory] = await Promise.all([
            apiKeyService.listApiKeys(recordActorOf(auth)),
            creatorDirectory(auth),
          ]);

          /** Parse flash message from query params (set after create/revoke) */
          const flash = toFlash(query.flash, query.flashType);

          /**
           * The raw key is delivered via a one-time server-side reveal token
           * (#132): never in the URL. `consumeRevealSecret` returns it once,
           * then it's gone.
           */
          const rawKey = consumeRevealSecret(
            query.reveal,
            "api_key",
            revealOwnerOf(auth),
          );

          return (
            <ApiKeysPage
              keys={keys}
              creators={directory.names}
              adminCreatorIds={directory.adminIds}
              canManageAll={managesAll(auth)}
              flash={flash}
              rawKey={rawKey}
            />
          );
        },
        {
          beforeHandle: memberGuard,
          query: t.Object({
            flash: t.Optional(t.String()),
            flashType: t.Optional(t.String()),
            reveal: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/api-keys
       * Creates a new API key via form submission.
       * Redirects back to the list with the raw key shown once.
       * Any signed-in account (#219): the key belongs to the creator, and a
       * member's key is always restricted (the service ignores `isAdmin`).
       */
      .post(
        "/api-keys",
        async ({ body, set, auth, request, server }) => {
          try {
            const { apiKey, rawKey } = await apiKeyService.createApiKey(
              {
                name: body.name,
                /** Chip input submits a comma-joined string; split to an array. */
                allowedSenders: parseSenderList(body.allowedSenders),
                /** Checkbox → "on" when ticked; admin grant for admins and the owner only (#130, #219). */
                isAdmin: body.isAdmin === "on",
              },
              recordActorOf(auth),
            );

            logger.info("API key created via dashboard", {
              id: apiKey.id,
              name: body.name,
              isAdmin: apiKey.isAdmin,
              userId: auth.user.id,
            });
            await recordAuditEvent({
              ...dashboardAudit(auth, request, server),
              action: "api_key.created",
              target: { type: "api_key", id: apiKey.id, label: apiKey.name },
              metadata: {
                isAdmin: apiKey.isAdmin,
                allowedSenders: apiKey.allowedSenders.length,
              },
            });

            /**
             * Redirect with only a one-time reveal TOKEN in the query (#132):
             * never the raw key itself. The GET consumes the token and shows
             * the key once. Keeps secrets out of history / access logs / Referer.
             */
            const reveal = stashRevealSecret(rawKey, "api_key", revealOwnerOf(auth));
            set.status = 302;
            set.headers["location"] =
              `/dashboard/api-keys?flash=${encodeURIComponent("API key created successfully")}&reveal=${reveal}`;
          } catch (error) {
            if (error instanceof ApiKeyCreatorInactiveError) {
              /** The service logged the refusal (#219). */
              set.status = 302;
              set.headers["location"] =
                `/dashboard/api-keys?flash=${encodeURIComponent("Your account can no longer create API keys")}&flashType=error`;
              return "";
            }
            logger.error("Failed to create API key via dashboard", {
              error: error instanceof Error ? error.message : String(error),
            });
            set.status = 302;
            set.headers["location"] =
              `/dashboard/api-keys?flash=${encodeURIComponent("Failed to create API key")}&flashType=error`;
          }
          return "";
        },
        {
          beforeHandle: memberGuard,
          body: t.Object({
            name: t.String(),
            allowedSenders: t.Optional(t.String()),
            isAdmin: t.Optional(t.String()),
          }),
        },
      )

      /**
       * POST /dashboard/api-keys/:id/admin
       * Promotes/demotes a key's admin flag (#130). Operator-only: this route
       * lives on the dashboard (session auth), and `setApiKeyAdmin` is not
       * reachable from any REST DTO, so an API key can never grant itself admin.
       * Admins and the owner only. A key is promoted only when its creator is
       * an active admin or the owner (or it has none), checked in the same
       * UPDATE (#219): a member's key stays restricted.
       */
      .post(
        "/api-keys/:id/admin",
        async ({ params, body, set, auth, request, server }) => {
          const isAdmin = body.isAdmin === "true";
          const result = await apiKeyService.setApiKeyAdmin(params.id, isAdmin);

          if (result.ok) {
            await recordAuditEvent({
              ...dashboardAudit(auth, request, server),
              action: "api_key.admin_changed",
              target: {
                type: "api_key",
                id: result.apiKey.id,
                label: result.apiKey.name,
              },
              metadata: { isAdmin: result.apiKey.isAdmin },
            });
            return redirect(
              set,
              `/dashboard/api-keys?flash=${encodeURIComponent(isAdmin ? "Key promoted to admin" : "Key set to restricted")}`,
            );
          }
          const message =
            result.reason === "not_found"
              ? "API key not found"
              : "Only keys of an active admin or the owner can be made admin";
          return redirect(
            set,
            `/dashboard/api-keys?flash=${encodeURIComponent(message)}&flashType=error`,
          );
        },
        {
          beforeHandle: adminGuard,
          params: t.Object({ id: t.String() }),
          body: t.Object({ isAdmin: t.String() }),
        },
      )

      /**
       * POST /dashboard/api-keys/:id/senders
       * Updates a key's allowed-senders allowlist via form submission (#126).
       * The chip editor submits the full desired list (comma-joined); an empty
       * value clears the list (back to unrestricted). A member may update only
       * its own keys (#219): anyone else's answers "not found", like a key
       * that does not exist.
       */
      .post(
        "/api-keys/:id/senders",
        async ({ params, body, set, auth, request, server }) => {
          const updated = await apiKeyService.updateApiKey(
            params.id,
            { allowedSenders: parseSenderList(body.allowedSenders) },
            recordActorOf(auth),
          );
          if (updated) {
            await recordAuditEvent({
              ...dashboardAudit(auth, request, server),
              action: "api_key.updated",
              target: { type: "api_key", id: updated.id, label: updated.name },
              metadata: {
                fields: ["allowedSenders"],
                allowedSenders: updated.allowedSenders.length,
              },
            });
          }

          set.status = 302;
          set.headers["location"] = updated
            ? `/dashboard/api-keys?flash=${encodeURIComponent("Allowed senders updated")}`
            : `/dashboard/api-keys?flash=${encodeURIComponent("API key not found")}&flashType=error`;
          return "";
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({ id: t.String() }),
          body: t.Object({ allowedSenders: t.Optional(t.String()) }),
        },
      )

      /**
       * POST /dashboard/api-keys/:id/revoke
       * Revokes an API key via form submission. A member may revoke only its
       * own keys (#219): anyone else's answers "not found".
       */
      .post(
        "/api-keys/:id/revoke",
        async ({ params, set, auth, request, server }) => {
          const apiKey = await apiKeyService.revokeApiKey(params.id, recordActorOf(auth));
          if (apiKey) {
            await recordAuditEvent({
              ...dashboardAudit(auth, request, server),
              action: "api_key.revoked",
              target: { type: "api_key", id: apiKey.id, label: apiKey.name },
            });
          }

          if (!apiKey) {
            set.status = 302;
            set.headers["location"] =
              `/dashboard/api-keys?flash=${encodeURIComponent("API key not found")}&flashType=error`;
            return "";
          }

          logger.info("API key revoked via dashboard", {
            id: params.id,
            userId: auth.user.id,
          });
          set.status = 302;
          set.headers["location"] =
            `/dashboard/api-keys?flash=${encodeURIComponent("API key revoked")}`;
          return "";
        },
        {
          beforeHandle: memberGuard,
          params: t.Object({
            id: t.String(),
          }),
        },
      )
  );
}
