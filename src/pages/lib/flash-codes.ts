import { PASSKEY_NAME_MAX_LENGTH } from "../../modules/users/services/passkey-policy.service.ts";
import { queuedWithWarningsText } from "../send-warnings.ts";
import { PASSKEYS_OFF } from "./passkeys.ts";

/**
 * Every dashboard flash banner (#421), keyed by its code.
 *
 * A redirect after a form action carries only a code (`?flash=<code>`),
 * never text: the page looks the code up here and shows the message
 * written below, so a link from anyone else can only ever show one of
 * these messages, never words of its own. An unknown code shows nothing.
 * The code also decides the banner's colour, so no `flashType` travels in
 * the URL.
 *
 * Two tables:
 *
 * - `FLASH_MESSAGES`: fixed text.
 * - `NUMERIC_FLASH_MESSAGES`: text built from one non-negative integer
 *   (`?flashN=`), for a count ("3 email(s) restored") or a limit ("at
 *   most 10 webhooks"). The number is the only thing the URL adds, it is
 *   parsed as digits only, and the worst a crafted link can do is show a
 *   wrong number in one of these sentences.
 *
 * A message that used to embed free text (a provider label, a domain name,
 * an error's own message) is now one fixed sentence per case, or one code
 * per variant. Codes are lower snake case and never change meaning once
 * shipped: an old bookmark then still shows the right banner.
 */

/** The banner's colour: green or red. */
export type FlashType = "success" | "error";

/** A banner whose text is fixed. */
export interface FixedFlash {
  /** The banner's colour. */
  readonly type: FlashType;
  /** What the banner says. */
  readonly text: string;
}

/** A banner whose text takes one non-negative integer from the URL. */
export interface NumericFlash {
  /** The banner's colour. */
  readonly type: FlashType;
  /** What the banner says for the number `n`. */
  readonly text: (n: number) => string;
}

/** A green banner with fixed text. */
function success(text: string): FixedFlash {
  return { type: "success", text };
}

/** A red banner with fixed text. */
function failure(text: string): FixedFlash {
  return { type: "error", text };
}

/** "1 email(s)" style counts, as the dashboard has always written them. */
function emails(n: number): string {
  return `${n} email(s)`;
}

/** Fixed-text banners, grouped by the page that shows them. */
export const FLASH_MESSAGES = {
  /* ─── Shared by several pages ─── */
  rate_limited: failure("Too many attempts. Try again later."),
  current_password_wrong: failure("Current password is incorrect."),
  no_usable_key: failure("Create an API key first"),

  /* ─── API keys ─── */
  api_key_created: success("API key created successfully"),
  api_key_creator_inactive: failure("Your account can no longer create API keys"),
  api_key_create_failed: failure("Failed to create API key"),
  api_key_promoted: success("Key promoted to admin"),
  api_key_restricted: success("Key set to restricted"),
  api_key_promotion_refused: failure(
    "Only keys of an active admin or the owner can be made admin",
  ),
  api_key_not_found: failure("API key not found"),
  api_key_senders_updated: success("Allowed senders updated"),
  api_key_revoked: success("API key revoked"),

  /* ─── Webhooks ─── */
  webhook_created: success("Webhook created"),
  webhook_create_failed: failure("Failed to create webhook"),
  webhook_url_blocked: failure(
    "The webhook URL was refused: it must be a valid https:// URL (http:// only where this server allows it) whose host resolves to a public address.",
  ),
  webhook_no_event: failure("Select at least one event"),
  webhook_unknown_event: failure("Unknown webhook event"),
  webhook_admin_events: failure(
    "Only admin API keys can subscribe to email.received, domain.verified and domain.verification_failed (inbound mail and domains are admin-only).",
  ),
  webhook_not_found: failure("Webhook not found"),
  webhook_deleted: success("Webhook deleted"),
  webhook_delete_failed: failure("Failed to delete webhook"),
  webhook_delivery_not_found: failure("Delivery not found"),
  webhook_replay_queued: success("Replay queued: worker will re-attempt on next poll"),

  /* ─── Templates ─── */
  template_created: success("Template created"),
  template_create_failed: failure("Failed to create template"),
  template_updated: success("Template updated"),
  template_update_failed: failure("Failed to update template"),
  template_deleted: success("Template deleted"),
  template_delete_failed: failure("Failed to delete template"),
  template_not_found: failure("Template not found"),

  /* ─── Domains ─── */
  domain_not_found: failure("Domain not found"),
  domain_added: success("Domain added successfully"),
  domain_add_failed: failure("Failed to add domain"),
  domain_already_registered: failure("That domain is already registered."),
  domain_invalid_name: failure(
    "The domain name must be a host name such as example.com: at least two labels of 1 to 63 letters, digits or inner hyphens, 253 characters at most, with no scheme, port, path or spaces.",
  ),
  domain_invalid_selector: failure(
    "The DKIM selector must be one lowercase DNS label: 1 to 63 letters, digits or inner hyphens.",
  ),
  domain_deleted: success("Domain deleted"),
  domain_verify_throttled: failure(
    "Too many verification attempts: wait a minute and try again",
  ),
  domain_verified: success("All DNS records verified successfully!"),
  domain_verify_incomplete: failure(
    "Not every DNS record is verified yet: each record's status is shown below. A failed DNS lookup changes nothing, so try again later.",
  ),
  domain_notify_invalid: failure("Enter a valid email address"),
  domain_notify_enabled: success("Inbound notifications enabled"),
  domain_notify_disabled: success("Inbound notifications disabled"),
  domain_unsubscribe_email_invalid: failure("Enter a valid unsubscribe email address"),
  domain_unsubscribe_url_invalid: failure(
    "The unsubscribe URL must be an https:// address",
  ),
  domain_unsubscribe_saved: success("Unsubscribe settings saved"),
  domain_tracking_saved: success("Tracking settings saved"),
  domain_tracking_saved_off: success(
    "Tracking settings saved. Nothing is tracked while TRACKING_ENABLED is off.",
  ),
  /* BIMI check (#415): one code per verdict, the details are in the BIMI section. */
  bimi_ready: success("BIMI check done: the domain is BIMI-ready (details below)"),
  bimi_not_ready: failure(
    "BIMI check done: the domain is not BIMI-ready yet. The BIMI section lists what to fix.",
  ),
  bimi_missing: failure(
    "BIMI check done: the domain has no BIMI record. The BIMI section shows the record to publish.",
  ),
  bimi_declined: success("BIMI check done: the domain's BIMI record declines a logo"),
  bimi_check_failed: failure(
    "The BIMI check could not finish: a lookup or the logo fetch failed. Try again later.",
  ),
  bimi_throttled: failure(
    "Too many DNS checks for this domain: wait a minute and try again",
  ),
  /* Click tracking link revocation (#424). */
  tracking_links_revoked: success(
    "Tracking links revoked: click links already sent from this domain no longer redirect",
  ),
  tracking_epoch_exhausted: failure(
    "This domain's tracking links cannot be revoked again: its tracking epoch is at its highest value. Delete and re-add the domain to start over.",
  ),
  tracking_revoke_failed: failure("Failed to revoke the tracking links"),
  /* Inbound MTA-STS policy (#472). */
  domain_mta_sts_saved: success(
    "MTA-STS mode saved. Publish the _mta-sts TXT record shown below (its id changes with the policy), then verify.",
  ),
  domain_mta_sts_saved_no_tls: failure(
    "MTA-STS set to enforce, but this server offers no inbound STARTTLS (SMTP_ENABLED and SMTP_TLS_CERT): if the policy's MX hosts are this server, senders that honour it cannot deliver. Use testing until STARTTLS works.",
  ),
  domain_mta_sts_off: success(
    "MTA-STS turned off: the policy is no longer served. Remove the _mta-sts TXT record.",
  ),

  /* ─── Domains: DKIM key rotation (#250) ─── */
  dkim_rotation_started: success(
    "DKIM key rotation started: publish the pending DKIM record, then complete the rotation",
  ),
  dkim_rotation_completed: success(
    "DKIM key rotation completed: mail is now signed with the new key",
  ),
  dkim_rotation_cancelled: success("DKIM key rotation cancelled"),
  dkim_rotation_start_failed: failure("Failed to start the DKIM key rotation"),
  dkim_rotation_complete_failed: failure("Failed to complete the DKIM key rotation"),
  dkim_rotation_cancel_failed: failure("Failed to cancel the DKIM key rotation"),
  dkim_dns_throttled: failure("Too many DNS checks: wait a minute and try again"),
  dkim_rotation_pending: failure(
    "A DKIM key rotation is already pending: complete or cancel it first.",
  ),
  dkim_no_pending_rotation: failure("No DKIM key rotation is pending for this domain."),
  dkim_pending_not_published: failure(
    "The pending DKIM record does not resolve with the new key yet, or the DNS lookup failed: publish it as shown below if needed, then complete the rotation again.",
  ),
  dkim_pending_key_unreadable: failure(
    "The pending private key does not decrypt with DKIM_ENCRYPTION_KEY: cancel the rotation and start a new one.",
  ),

  /* ─── Send (#245) ─── */
  send_key_unavailable: failure(
    "Selected API key is not available. Pick an active one and try again.",
  ),
  email_queued: success("Email queued for delivery."),
  email_queued_unregistered: success(
    "Email queued for delivery. Warning: the sender domain is not registered in BunMail, so the email goes out without a DKIM signature (allowed in development only). Add it on the Domains page.",
  ),
  send_failed: failure("Failed to send email"),
  send_rejected: failure("The email was refused: check the form and try again."),
  send_domain_unregistered: failure(
    "The sender domain is not registered. Add it on the Domains page before sending.",
  ),
  send_domain_unverified: failure(
    "The sender domain has no verified DKIM record. Publish the DKIM TXT record shown for the domain on the Domains page, then send again.",
  ),
  send_subject_required: failure("Subject is required."),
  send_body_required: failure("A body is required: provide html or text."),
  send_invalid_from: failure("From must be a single email address."),
  send_invalid_from_name: failure("The sender's display name is not valid."),
  send_invalid_header: failure("A header of this email is not valid."),
  send_recipient_suppressed: failure(
    "Recipient is on the suppression list. Remove the suppression first if this is intentional.",
  ),
  send_sender_not_allowed: failure(
    "The sender address is not in this API key's allowed-senders list.",
  ),
  send_key_revoked: failure("This API key has been revoked."),
  send_attachment_type_blocked: failure(
    "An attachment's file type is not allowed (executables and scripts are blocked).",
  ),
  send_invalid_attachment: failure(
    "An attachment is not valid: check its filename and try again.",
  ),

  /* ─── Emails and inbound: trash ─── */
  email_not_found: failure("Email not found"),
  inbound_email_not_found: failure("Inbound email not found"),
  trashed_email_not_found: failure("Trashed email not found"),
  email_trashed: success("Email moved to trash"),
  email_restored: success("Email restored"),
  email_deleted_forever: success("Email deleted forever"),

  /* ─── Suppressions ─── */
  suppression_removed: success("Suppression removed"),
  suppression_not_found: failure("Suppression not found (already deleted?)"),

  /* ─── Users (#218, #277) ─── */
  account_actor_inactive: failure("Your account can no longer manage accounts."),
  account_self: failure("You cannot change the role or status of your own account."),
  account_target_is_owner: failure(
    "The owner cannot be demoted, deactivated or removed.",
  ),
  account_role_not_allowed: failure("Your role cannot do this to that account."),
  account_invalid_role: failure("An account can only be made an admin or a member here."),
  account_not_found: failure("Account not found: it may have been removed."),
  account_unchanged: failure(
    "Nothing to change: the account already has that role or status.",
  ),
  account_confirm_mismatch: failure(
    "Type the account's email address exactly to remove it.",
  ),
  account_wrong_password: failure("Wrong password: ownership was not transferred."),
  account_not_eligible: failure("Ownership can only go to an active admin."),
  account_sso_link_without_second_factor: failure(
    "That admin has a single sign-on account linked and no second factor: they must set up a second factor before becoming the owner.",
  ),
  account_rate_limited: failure("Too many failed attempts, try again later."),
  account_disabled: failure("Reactivate the account before resetting its password."),
  account_role_admin: success("Role changed to admin."),
  account_role_member: success("Role changed to member."),
  account_deactivated: success("Account deactivated and signed out."),
  account_reactivated: success("Account reactivated."),
  account_removed: success("Account removed."),
  ownership_transferred: success("Ownership transferred. You are now an admin."),
  reset_link_created: success(
    "Password reset link created. Copy it below and share it privately: it works once, for one hour.",
  ),
  reset_link_created_localhost: success(
    "Password reset link created. Copy it below and share it privately: it works once, for one hour. APP_BASE_URL is not set, so the link points at localhost.",
  ),
  reset_link_failed: failure("Failed to create the password reset link."),

  /* ─── Invitations (#217) ─── */
  invite_invalid_email: failure("Enter one valid email address."),
  invite_role_not_allowed: failure("Your role cannot grant or manage that role."),
  invite_account_exists: failure("An account already exists for that address."),
  invite_pending_higher_role: failure(
    "A pending invitation from a higher role exists for this address. Only the owner can replace it.",
  ),
  invite_not_found: failure(
    "Invitation not found: it may have been accepted, revoked or replaced.",
  ),
  invitation_sent: success("Invitation sent by email."),
  invitation_resent: success("Invitation resent by email."),
  invitation_unsent_not_configured: success(
    "Invitation created, but the email was not sent: no system sender is configured. Copy the link below and share it with the invitee.",
  ),
  invitation_unsent_sender_unavailable: success(
    "Invitation created, but the email was not sent: the system sender's domain is not registered or not DKIM-verified. Copy the link below and share it with the invitee.",
  ),
  invitation_unsent_send_failed: success(
    "Invitation created, but the email was not sent: sending failed. Copy the link below and share it with the invitee.",
  ),
  invitation_unsent_no_base_url: success(
    "Invitation created, but the email was not sent: APP_BASE_URL is not set, so no usable link could be emailed. Copy the link below and share it with the invitee.",
  ),
  invitation_create_failed: failure("Failed to create the invitation."),
  invitation_revoked: success("Invitation revoked."),
  invitation_resend_failed: failure("Failed to resend the invitation."),

  /* ─── Account: password (#279) ─── */
  password_changed: success(
    "Password changed. You were signed out on every other device.",
  ),

  /* ─── Account: sessions ─── */
  sessions_no_other: success("No other device was signed in."),
  sessions_revoke_others_failed: failure(
    "Failed to sign out the other devices: nothing was changed.",
  ),
  session_revoked: success("Signed out that device."),
  session_revoke_failed: failure("Failed to sign out the device: nothing was changed."),

  /* ─── Account: two-factor authentication (#220) ─── */
  two_factor_no_pending: failure(
    "Start the setup again: no setup was in progress in this browser.",
  ),
  two_factor_already_enabled: failure("Two-factor authentication is already on."),
  two_factor_not_enabled: failure("Two-factor authentication is off."),
  two_factor_wrong_code: failure("Invalid code. Try again."),
  two_factor_wrong_password: failure("The password or the code is incorrect."),
  two_factor_sso_link: failure(
    "You are the owner and have a single sign-on account linked: unlink it on the Sign-in methods page before turning two-factor authentication off.",
  ),
  two_factor_start_failed: failure("Failed to start the setup: nothing was changed."),
  two_factor_enabled: success(
    "Two-factor authentication is on. You were signed out on every other device.",
  ),
  two_factor_enable_failed: failure(
    "Failed to turn on two-factor authentication: nothing was changed.",
  ),
  two_factor_disabled: success("Two-factor authentication turned off."),
  two_factor_disable_failed: failure(
    "Failed to turn off two-factor authentication: nothing was changed.",
  ),
  recovery_codes_regenerated: success(
    "New recovery codes created. The old ones no longer work.",
  ),
  recovery_codes_failed: failure(
    "Failed to create new recovery codes: nothing was changed.",
  ),

  /* ─── Account: passkeys ─── */
  passkeys_off: failure(PASSKEYS_OFF),
  passkey_no_challenge: failure(
    "The passkey setup expired or was already used. Start again.",
  ),
  passkey_rejected: failure("The passkey could not be verified. Start again."),
  passkey_already_registered: failure("That passkey is already registered."),
  passkey_not_found: failure("That passkey was not found: nothing was changed."),
  passkey_sso_link: failure(
    "You are the owner and have a single sign-on account linked: unlink it on the Sign-in methods page before removing your last second factor.",
  ),
  passkey_nothing_changed: failure("Nothing was changed."),
  passkey_invalid_name: failure(
    `The passkey name must be 1 to ${PASSKEY_NAME_MAX_LENGTH} characters, with no control characters.`,
  ),
  passkey_added: success("Passkey added."),
  passkey_added_signed_out: success(
    "Passkey added. You were signed out on every other device.",
  ),
  passkey_add_failed: failure("Failed to add the passkey: nothing was changed."),
  passkey_renamed: success("Passkey renamed."),
  passkey_rename_failed: failure("Failed to rename the passkey: nothing was changed."),
  passkey_removed: success("Passkey removed."),
  passkey_remove_failed: failure("Failed to remove the passkey: nothing was changed."),

  /* ─── Account: sign-in methods (SSO, #224) ─── */
  sso_provider_unavailable: failure("That sign-in provider is not available."),
  sso_second_factor_required: failure(
    "As the owner, you need a second factor before you can link a single sign-on account.",
  ),
  sso_provider_already_linked: failure(
    "Your account already has an account linked at that provider.",
  ),
  sso_already_linked: failure(
    "That account at the provider is already linked to another BunMail account.",
  ),
  sso_session_changed: failure(
    "Your session changed while you were at the provider. Sign in and try again.",
  ),
  sso_provider_unreachable: failure(
    "The sign-in provider could not be reached. Try again later.",
  ),
  sso_link_start_failed: failure("Failed to start linking: nothing was changed."),
  sso_link_flow_failed: failure(
    "Linking did not complete: the provider's answer was not accepted. Try again.",
  ),
  sso_linked: success("Single sign-on account linked."),
  sso_link_not_found: failure("That link was not found: nothing was changed."),
  sso_unlinked: success("Account unlinked."),
  sso_unlink_failed: failure("Failed to unlink: nothing was changed."),
} satisfies Record<string, FixedFlash>;

/** Banners whose text takes one non-negative integer (`?flashN=`). */
export const NUMERIC_FLASH_MESSAGES = {
  /** `n`: the email count. */
  emails_trashed: { type: "success", text: (n) => `${emails(n)} moved to trash` },
  /** `n`: the email count. */
  emails_restored: { type: "success", text: (n) => `${emails(n)} restored` },
  /** `n`: the email count. */
  emails_deleted_forever: {
    type: "success",
    text: (n) => `${emails(n)} deleted forever`,
  },
  /** `n`: the email count. */
  trash_emptied: {
    type: "success",
    text: (n) => `Trash emptied: ${emails(n)} permanently deleted`,
  },
  /** `n`: the per-key webhook limit. */
  webhook_limit_reached: {
    type: "error",
    text: (n) =>
      `This API key already has the maximum of ${n} webhooks. Delete one before adding another.`,
  },
  /** `n`: the limit of addresses in `to`. */
  send_too_many_to: { type: "error", text: (n) => `At most ${n} addresses in to.` },
  /** `n`: the limit of attachments per email (#488). */
  send_too_many_attachments: {
    type: "error",
    text: (n) => `At most ${n} attachments per email.`,
  },
  /** `n`: the attachment budget in MB (#488). */
  send_attachments_too_large: {
    type: "error",
    text: (n) => `Attachments may total at most ${n} MB.`,
  },
  /** `n`: the limit of unique recipients. */
  send_too_many_recipients: {
    type: "error",
    text: (n) => `At most ${n} unique recipients across to, cc and bcc.`,
  },
  /** `n`: the unverified records as bits (DKIM 1, SPF 2, DMARC 4), see `send-warnings.ts`. */
  email_queued_unverified: { type: "success", text: queuedWithWarningsText },
  /** `n`: how many other sessions were signed out. */
  sessions_revoked_others: {
    type: "success",
    text: (n) => `Signed out ${n} other ${n === 1 ? "device" : "devices"}.`,
  },
} satisfies Record<string, NumericFlash>;

/** A fixed-text banner's code. */
export type FlashCode = keyof typeof FLASH_MESSAGES;

/** A numeric banner's code. */
export type NumericFlashCode = keyof typeof NUMERIC_FLASH_MESSAGES;
