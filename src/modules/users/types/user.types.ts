import type { db } from "../../../db/index.ts";

/**
 * The users module's types (#214 onwards). Since #387 they live in one
 * file per concern, beside this one, and this module re-exports every one
 * of them, so importers keep using it:
 *
 *   - `user-value-sets.types.ts`: roles, credential types, assurances, token purposes, `literals`
 *   - `invite.types.ts`: invitations (#217)
 *   - `account.types.ts`: account management (#218)
 *   - `password.types.ts`: password resets (#277) and changes (#279)
 *   - `owner.types.ts`: owner bootstrap and setup (#215), record ownership (#219)
 *   - `session.types.ts`: login and sessions (#216)
 *   - `two-factor.types.ts`: two-factor authentication (#220)
 *   - `passkey.types.ts`: passkeys (#223)
 *
 * `Tx` and `DbExecutor` stay here.
 */
export {
  USER_ROLES,
  type UserRole,
  isUserRole,
  CREDENTIAL_TYPES,
  SECOND_FACTOR_TYPES,
  SESSION_ASSURANCES,
  type SessionAssurance,
  isSessionAssurance,
  TOKEN_PURPOSES,
  type TokenPurpose,
  literals,
} from "./user-value-sets.types.ts";
/** @public Kept from before the split (#387), when only this file used it. */
export type { CredentialType } from "./user-value-sets.types.ts";
export {
  INVITE_ROLES,
  type InviteRole,
  isInviteRole,
  type InviteActor,
  type InviteRefusal,
  type InviteMailFailure,
  type InviteMailOutcome,
  type IssuedInvitation,
  type IssueInvitationResult,
  type PendingInvitation,
  type InviteTarget,
  type InviteAcceptance,
  type AcceptInvitationResult,
} from "./invite.types.ts";
export type {
  AccountSummary,
  AccountAction,
  AccountRefusal,
  AttemptLimiter,
  AccountActionResult,
} from "./account.types.ts";
export type {
  IssuedPasswordReset,
  IssuePasswordResetResult,
  PasswordResetTarget,
  CompletePasswordResetResult,
  PasswordChangeRefusal,
  PasswordChangeInput,
  ChangePasswordResult,
} from "./password.types.ts";
export type {
  OwnerSetupLink,
  OwnerBootstrapResult,
  ContentRecordCounts,
  RecordCounts,
  CompletedOwnerSetup,
} from "./owner.types.ts";
export type {
  SessionClient,
  NewSessionInput,
  CreatedSession,
  ActiveSession,
  DashboardAuth,
  UserSessionSummary,
  RotatedSession,
  LoginFailureReason,
  LoginResult,
} from "./session.types.ts";
export {
  TWO_FACTOR_POLICIES,
  type TwoFactorPolicy,
  isTwoFactorPolicy,
  type TwoFactorStatus,
  type PendingEnrolment,
  type TwoFactorRefusal,
  type ConfirmEnrolmentResult,
  type RegenerateRecoveryCodesResult,
  type SecondFactorMethod,
  type DisableTwoFactorResult,
  type PendingSession,
  type TwoFactorLoginResult,
  type RemovedSecondFactors,
} from "./two-factor.types.ts";
export type {
  PasskeySummary,
  RelyingParty,
  PasskeyRefusal,
  PasskeyFailure,
  FinishPasskeyRegistrationResult,
  PasskeyTwoFactorResult,
  PasskeySignInResult,
} from "./passkey.types.ts";

/** The transaction handle `db.transaction` passes to its callback. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Where a users-module write runs: the shared pool, or a transaction the
 * caller opened (owner setup creates the owner's session inside its own
 * advisory-lock transaction, #216).
 */
export type DbExecutor = typeof db | Tx;
