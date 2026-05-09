CREATE TABLE "dmarc_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"report_id" varchar(36) NOT NULL,
	"source_ip" varchar(45) NOT NULL,
	"count" integer NOT NULL,
	"disposition" varchar(20) NOT NULL,
	"dkim_aligned" boolean NOT NULL,
	"spf_aligned" boolean NOT NULL,
	"header_from" varchar(255) NOT NULL,
	"dkim_auth_domain" varchar(255),
	"dkim_selector" varchar(255),
	"dkim_result" varchar(20),
	"spf_auth_domain" varchar(255),
	"spf_result" varchar(20)
);
--> statement-breakpoint
CREATE TABLE "dmarc_reports" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"org_name" varchar(255) NOT NULL,
	"org_email" varchar(255) NOT NULL,
	"report_id" varchar(255) NOT NULL,
	"domain" varchar(255) NOT NULL,
	"date_begin" timestamp with time zone NOT NULL,
	"date_end" timestamp with time zone NOT NULL,
	"policy_p" varchar(20) NOT NULL,
	"policy_pct" integer DEFAULT 100 NOT NULL,
	"raw_xml" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dmarc_records" ADD CONSTRAINT "dmarc_records_report_id_dmarc_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."dmarc_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dmarc_records_report_id_idx" ON "dmarc_records" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "dmarc_records_source_ip_idx" ON "dmarc_records" USING btree ("source_ip");--> statement-breakpoint
CREATE UNIQUE INDEX "dmarc_reports_org_email_report_id_unique" ON "dmarc_reports" USING btree ("org_email","report_id");--> statement-breakpoint
CREATE INDEX "dmarc_reports_domain_date_end_idx" ON "dmarc_reports" USING btree ("domain","date_end");