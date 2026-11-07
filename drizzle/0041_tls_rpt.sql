CREATE TABLE "tlsrpt_daily_sends" (
	"day" date PRIMARY KEY NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"cap_warned" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tlsrpt_destination_sends" (
	"day" date NOT NULL,
	"destination_hash" varchar(32) NOT NULL,
	"sent" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tlsrpt_destination_sends_day_destination_hash_pk" PRIMARY KEY("day","destination_hash")
);
--> statement-breakpoint
CREATE TABLE "tlsrpt_reports" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"day" date NOT NULL,
	"policy_domain" varchar(253) NOT NULL,
	"rfc_report_id" varchar(64) NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"delivered_rua" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tlsrpt_results" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"report_id" varchar(36) NOT NULL,
	"policy_type" varchar(16) NOT NULL,
	"policy_hash" varchar(32) NOT NULL,
	"policy_string" text DEFAULT '' NOT NULL,
	"mx_host" text DEFAULT '' NOT NULL,
	"result_type" varchar(40) NOT NULL,
	"receiving_mx_hostname" varchar(253) DEFAULT '' NOT NULL,
	"receiving_ip" varchar(45) DEFAULT '' NOT NULL,
	"failure_reason_code" varchar(64) DEFAULT '' NOT NULL,
	"session_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tlsrpt_results" ADD CONSTRAINT "tlsrpt_results_report_id_tlsrpt_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."tlsrpt_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tlsrpt_reports_day_domain_unique" ON "tlsrpt_reports" USING btree ("day","policy_domain");--> statement-breakpoint
CREATE INDEX "tlsrpt_reports_next_attempt_at_idx" ON "tlsrpt_reports" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tlsrpt_results_key_unique" ON "tlsrpt_results" USING btree ("report_id","policy_type","policy_hash","result_type","receiving_mx_hostname","receiving_ip","failure_reason_code");