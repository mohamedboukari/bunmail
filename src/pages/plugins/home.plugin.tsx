import { HomePage } from "../routes/home.tsx";
import { memberGuard, roleAtLeast } from "../guards.tsx";
import * as statsService from "../../modules/emails/services/stats.service.ts";
import type { GuardedDashboard } from "../lib/session-guard.ts";

/** Dashboard home (#291): the stat cards. */
export function homePages(app: GuardedDashboard) {
  return (
    app
      /**
       * GET /dashboard
       * Dashboard home: shows stat cards with overview counts.
       */
      .get(
        "/",
        async ({ auth }) => {
          const stats = await statsService.getDashboardStats();
          return (
            <HomePage stats={stats} canInvite={roleAtLeast(auth.user.role, "admin")} />
          );
        },
        { beforeHandle: memberGuard },
      )
  );
}
