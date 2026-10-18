/**
 * Display names of dashboard accounts by `users.id` (#219): the name, or
 * the email when no name is set. Built once per page from the accounts
 * list, so a "Created by" column costs one query, not one per row.
 */
export type CreatorNames = ReadonlyMap<string, string>;

/**
 * The "Created by" label of a record (#219). No creator means the owner
 * (records from before accounts existed, or of a removed user); an id
 * missing from `creators` (an account removed while the page loaded) is
 * shown as a removed account.
 */
export function creatorLabel(userId: string | null, creators: CreatorNames): string {
  if (userId === null) return "Owner";
  return creators.get(userId) ?? "Removed account";
}

/** "Created by" cell content: the creator's label, escaped. */
export function CreatedBy({
  userId,
  creators,
}: {
  userId: string | null;
  creators: CreatorNames;
}) {
  return (
    <span class="text-xs text-gray-500 dark:text-gray-400" safe>
      {creatorLabel(userId, creators)}
    </span>
  );
}
