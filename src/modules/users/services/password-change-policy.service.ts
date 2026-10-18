import { setupPasswordProblem } from "./owner-setup-policy.service.ts";

/**
 * Rules for a signed-in user changing their own password (#279): what the
 * form must carry before any argon2id work. The new password follows the
 * owner setup policy (`setupPasswordProblem`: 15 to 256 characters,
 * confirmed), like invitations and password resets. The database side
 * lives in `password-change.service.ts`.
 *
 * Pure: no I/O, no config, so it unit-tests without mocks.
 */

/**
 * Why the submitted change is not acceptable, or `null` if it is. In
 * order: the current password is required, the new one must pass the
 * setup policy and match its confirmation, and it must differ from the
 * current one (a "change" to the same password would sign every other
 * device out and change nothing else). The message is shown on the form,
 * so it never echoes the input.
 */
export function passwordChangeProblem(
  current: string,
  password: string,
  confirm: string,
): string | null {
  if (current.length === 0) return "Enter your current password.";
  const policy = setupPasswordProblem(password, confirm);
  if (policy) return policy;
  if (password === current) {
    return "The new password must be different from the current one.";
  }
  return null;
}
