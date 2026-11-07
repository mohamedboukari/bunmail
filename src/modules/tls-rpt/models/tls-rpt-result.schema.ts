import {
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import { tlsRptReports } from "./tls-rpt-report.schema.ts";

/**
 * One counter of a TLS report (RFC 8460, #345): sessions of one policy that
 * had one result, and for a failure, at one MX host and address with one
 * reason code. A `success` row counts the policy's successful sessions;
 * every other row is a `failure-details` entry.
 *
 * Bounded per report (`tls-rpt-aggregate.ts`): a few policies, a capped
 * number of detailed failure rows, and past the cap one row per policy and
 * result type without host details, so the totals stay exact. Nothing
 * here comes from a message: only what BunMail saw of the MX session.
 */
export const tlsRptResults = pgTable(
  "tlsrpt_results",
  {
    /** Surrogate id, prefixed `trr_`. */
    id: varchar("id", { length: 36 }).primaryKey(),

    /** The report. `ON DELETE CASCADE`: the counters go with it. */
    reportId: varchar("report_id", { length: 36 })
      .notNull()
      .references(() => tlsRptReports.id, { onDelete: "cascade" }),

    /** `policy-type`: `sts` or `no-policy-found`. */
    policyType: varchar("policy_type", { length: 16 }).notNull(),

    /** Identifies the policy within the report: a hash of its type, string and MX patterns. */
    policyHash: varchar("policy_hash", { length: 32 }).notNull(),

    /** `policy-string`: the applied policy's lines joined by `\n`; empty without one. */
    policyString: text("policy_string").notNull().default(""),

    /** `mx-host`: the policy's MX patterns joined by `\n`; empty without one. */
    mxHost: text("mx_host").notNull().default(""),

    /** `success`, or the failure's `result-type`. */
    resultType: varchar("result_type", { length: 40 }).notNull(),

    /** `receiving-mx-hostname`; empty for a success or a row past the detail cap. */
    receivingMxHostname: varchar("receiving_mx_hostname", { length: 253 })
      .notNull()
      .default(""),

    /** `receiving-ip`; empty for a success or a row past the detail cap. */
    receivingIp: varchar("receiving_ip", { length: 45 }).notNull().default(""),

    /** `failure-reason-code`: one of BunMail's fixed codes, or empty. */
    failureReasonCode: varchar("failure_reason_code", { length: 64 })
      .notNull()
      .default(""),

    /** Sessions counted (`failed-session-count` for a failure). */
    sessionCount: integer("session_count").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** One counter per key: the recording upsert's conflict target. */
    uniqueIndex("tlsrpt_results_key_unique").on(
      table.reportId,
      table.policyType,
      table.policyHash,
      table.resultType,
      table.receivingMxHostname,
      table.receivingIp,
      table.failureReasonCode,
    ),
  ],
);
