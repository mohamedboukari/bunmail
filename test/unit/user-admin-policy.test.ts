import { describe, test, expect } from "bun:test";
import {
  accountActionRefusal,
  allowedAccountActions,
  removalConfirmed,
  type AccountParty,
} from "../../src/modules/users/services/user-admin-policy.service.ts";
import { getLogContext, runWithLogContext } from "../../src/utils/log-context.ts";
import { setViewerRole, viewerIsAdmin } from "../../src/pages/viewer.ts";
import type {
  AccountAction,
  UserRole,
} from "../../src/modules/users/types/user.types.ts";

/**
 * Account management rules (#218): who may change the role of,
 * deactivate, reactivate, remove or hand ownership to whom. Pure, so the
 * whole matrix runs here; the integration test proves the service applies
 * it to the live rows.
 */

/** An active account of `role` with a distinct id. */
function party(
  role: UserRole,
  opts: { disabled?: boolean; id?: string } = {},
): AccountParty {
  return { id: opts.id ?? `usr_${role}`, role, disabled: opts.disabled ?? false };
}

const owner = party("owner");
const admin = party("admin");
const member = party("member");
const otherAdmin = party("admin", { id: "usr_admin2" });
const otherMember = party("member", { id: "usr_member2" });
const disabledAdmin = party("admin", { id: "usr_admin3", disabled: true });
const disabledMember = party("member", { id: "usr_member3", disabled: true });

describe("accountActionRefusal (#218)", () => {
  const actions: AccountAction[] = [
    "change_role",
    "deactivate",
    "reactivate",
    "remove",
    "transfer_ownership",
  ];

  test("nobody acts on their own account", () => {
    for (const actor of [owner, admin, member]) {
      for (const action of actions) {
        expect(accountActionRefusal(action, actor, actor)).toBe("self");
      }
    }
  });

  test("nobody acts on the owner", () => {
    for (const actor of [admin, member]) {
      for (const action of actions) {
        expect(accountActionRefusal(action, actor, owner)).toBe("target_is_owner");
      }
    }
  });

  test("only the owner changes roles", () => {
    expect(accountActionRefusal("change_role", owner, admin)).toBeNull();
    expect(accountActionRefusal("change_role", owner, member)).toBeNull();
    expect(accountActionRefusal("change_role", admin, member)).toBe("role_not_allowed");
    expect(accountActionRefusal("change_role", admin, otherAdmin)).toBe(
      "role_not_allowed",
    );
    expect(accountActionRefusal("change_role", member, otherMember)).toBe(
      "role_not_allowed",
    );
  });

  test("deactivate and remove: the owner any non-owner, an admin members only, a member nobody", () => {
    for (const action of ["deactivate", "remove"] as const) {
      expect(accountActionRefusal(action, owner, admin)).toBeNull();
      expect(accountActionRefusal(action, owner, member)).toBeNull();
      expect(accountActionRefusal(action, admin, member)).toBeNull();
      expect(accountActionRefusal(action, admin, otherAdmin)).toBe("role_not_allowed");
      expect(accountActionRefusal(action, member, otherMember)).toBe("role_not_allowed");
      expect(accountActionRefusal(action, member, admin)).toBe("role_not_allowed");
    }
  });

  test("deactivate and reactivate depend on the current status", () => {
    expect(accountActionRefusal("deactivate", owner, disabledAdmin)).toBe("unchanged");
    expect(accountActionRefusal("reactivate", owner, disabledAdmin)).toBeNull();
    expect(accountActionRefusal("reactivate", owner, admin)).toBe("unchanged");
    expect(accountActionRefusal("reactivate", admin, disabledMember)).toBeNull();
    expect(accountActionRefusal("reactivate", admin, disabledAdmin)).toBe(
      "role_not_allowed",
    );
    /** A disabled account can still be removed. */
    expect(accountActionRefusal("remove", admin, disabledMember)).toBeNull();
  });

  test("ownership goes from the owner to an active admin only", () => {
    expect(accountActionRefusal("transfer_ownership", owner, admin)).toBeNull();
    expect(accountActionRefusal("transfer_ownership", owner, member)).toBe(
      "not_eligible",
    );
    expect(accountActionRefusal("transfer_ownership", owner, disabledAdmin)).toBe(
      "not_eligible",
    );
    expect(accountActionRefusal("transfer_ownership", admin, otherAdmin)).toBe(
      "role_not_allowed",
    );
    expect(accountActionRefusal("transfer_ownership", member, admin)).toBe(
      "role_not_allowed",
    );
  });
});

describe("allowedAccountActions (#218)", () => {
  test("the owner on an active admin: everything but reactivate", () => {
    expect(allowedAccountActions(owner, admin)).toEqual([
      "change_role",
      "deactivate",
      "transfer_ownership",
      "remove",
    ]);
  });

  test("the owner on a disabled member: role change, reactivate, remove", () => {
    expect(allowedAccountActions(owner, disabledMember)).toEqual([
      "change_role",
      "reactivate",
      "remove",
    ]);
  });

  test("an admin on a member: deactivate and remove; on an admin or the owner: nothing", () => {
    expect(allowedAccountActions(admin, member)).toEqual(["deactivate", "remove"]);
    expect(allowedAccountActions(admin, otherAdmin)).toEqual([]);
    expect(allowedAccountActions(admin, owner)).toEqual([]);
  });

  test("a member and anyone on themselves: nothing", () => {
    expect(allowedAccountActions(member, otherMember)).toEqual([]);
    expect(allowedAccountActions(owner, owner)).toEqual([]);
  });
});

describe("removalConfirmed (#218)", () => {
  test("matches the stored email trimmed and case-insensitively", () => {
    expect(removalConfirmed("  Ann@Example.COM ", "ann@example.com")).toBe(true);
    expect(removalConfirmed("ann@example.org", "ann@example.com")).toBe(false);
    expect(removalConfirmed("", "ann@example.com")).toBe(false);
  });
});

describe("viewer role holder (#218)", () => {
  test("unknown outside a request context: admin links hidden", () => {
    setViewerRole("owner");
    expect(viewerIsAdmin()).toBe(false);
  });

  test("set per context, never seen by another context", () => {
    runWithLogContext({ requestId: "req_a" }, () => {
      expect(viewerIsAdmin()).toBe(false);
      setViewerRole("admin");
      expect(viewerIsAdmin()).toBe(true);
    });
    runWithLogContext({ requestId: "req_b" }, () => {
      expect(viewerIsAdmin()).toBe(false);
      setViewerRole("member");
      expect(viewerIsAdmin()).toBe(false);
    });
  });

  test("never added to the log context fields", () => {
    runWithLogContext({ requestId: "req_c" }, () => {
      setViewerRole("owner");
      expect(viewerIsAdmin()).toBe(true);
      expect(Object.keys(getLogContext() ?? {})).toEqual(["requestId"]);
    });
  });
});
