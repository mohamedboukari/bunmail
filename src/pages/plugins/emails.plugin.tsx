import type { GuardedDashboard } from "../lib/session-guard.ts";
import { emailSendPages } from "./emails-send.plugin.tsx";
import { emailListPages } from "./emails-list.plugin.tsx";
import { emailTrashPages } from "./emails-trash.plugin.tsx";
import { emailDetailPages } from "./emails-detail.plugin.tsx";

/** @public Kept from before the split (#387), when only this file used it. */
export { attachmentDownloadHeaders } from "./emails-detail.plugin.tsx";

/**
 * Outbound email pages (#291): the send form, the email list, trash,
 * tombstones and the email detail.
 */
export function emailPages(app: GuardedDashboard) {
  /**
   * One group per concern (#387), each registering its routes on this same
   * instance, in this order: send, list and tombstones, trash, detail and
   * attachments. Each group takes the previous one's instance, so the route
   * types are those of one chain.
   */
  return emailDetailPages(emailTrashPages(emailListPages(emailSendPages(app))));
}
