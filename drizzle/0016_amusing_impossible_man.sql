CREATE TABLE "sessions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"assurance" varchar(10) DEFAULT 'password' NOT NULL,
	"auth_method" varchar(16) DEFAULT 'password' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" varchar(45),
	"user_agent" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "sessions_assurance_check" CHECK ("sessions"."assurance" IN ('pending', 'password', 'mfa'))
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"type" varchar(16) NOT NULL,
	"provider" varchar(100),
	"provider_account_id" varchar(255),
	"secret_hash" text,
	"public_key" text,
	"counter" integer,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_credentials_type_check" CHECK ("user_credentials"."type" IN ('password', 'totp', 'passkey', 'oauth'))
);
--> statement-breakpoint
CREATE TABLE "user_tokens" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36),
	"email" varchar(255),
	"purpose" varchar(20) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"role" varchar(10),
	"invited_by" varchar(36),
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "user_tokens_purpose_check" CHECK ("user_tokens"."purpose" IN ('owner_setup', 'invite', 'password_reset')),
	CONSTRAINT "user_tokens_role_check" CHECK ("user_tokens"."role" IS NULL OR "user_tokens"."role" IN ('owner', 'admin', 'member')),
	CONSTRAINT "user_tokens_target_check" CHECK ("user_tokens"."user_id" IS NOT NULL OR "user_tokens"."email" IS NOT NULL),
	CONSTRAINT "user_tokens_email_lowercase_check" CHECK ("user_tokens"."email" IS NULL OR "user_tokens"."email" = lower("user_tokens"."email"))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"email_verified_at" timestamp with time zone,
	"name" varchar(100),
	"role" varchar(10) DEFAULT 'member' NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('owner', 'admin', 'member')),
	CONSTRAINT "users_email_lowercase_check" CHECK ("users"."email" = lower("users"."email"))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tokens" ADD CONSTRAINT "user_tokens_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_provider_account_unique" ON "user_credentials" USING btree ("provider","provider_account_id") WHERE provider IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_credentials_one_password_per_user" ON "user_credentials" USING btree ("user_id") WHERE type = 'password';--> statement-breakpoint
CREATE INDEX "user_tokens_email_purpose_idx" ON "user_tokens" USING btree ("email","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX "users_single_owner" ON "users" USING btree ("role") WHERE role = 'owner';