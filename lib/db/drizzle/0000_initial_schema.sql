CREATE TABLE IF NOT EXISTS "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"user_id" uuid,
	"event_type" text NOT NULL,
	"description" text NOT NULL,
	"amount_cents" integer,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agreement_acceptances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agreement_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"accepted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"version" text NOT NULL,
	"content" text NOT NULL,
	"effective_date" date NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commitment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"milestone_id" uuid,
	"amount_cents" integer NOT NULL,
	"purpose" text NOT NULL,
	"vendor_name" text,
	"payment_deadline" date,
	"required_threshold" numeric(4, 3) DEFAULT '0.670' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"created_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "commitment_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commitment_request_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"vote" text NOT NULL,
	"note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contribution_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"frequency" text DEFAULT 'monthly' NOT NULL,
	"amount_cents" integer NOT NULL,
	"start_date" date NOT NULL,
	"preferred_day" integer,
	"end_condition" text DEFAULT 'targetDate' NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"contribution_date" date NOT NULL,
	"status" text DEFAULT 'simulated' NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"external_payment_id" text,
	"milestone_id" uuid,
	"note" text,
	"reversed_at" timestamp,
	"reversal_note" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"contribution_target_cents" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"accepted_at" timestamp,
	"invited_by_user_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jar_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"contribution_target_cents" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"joined_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organizer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"category" text DEFAULT 'Vacation' NOT NULL,
	"description" text,
	"destination" text,
	"cover_image_url" text,
	"start_date" date,
	"end_date" date,
	"target_date" date NOT NULL,
	"goal_amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'Draft' NOT NULL,
	"approval_threshold" numeric(4, 3) DEFAULT '0.670' NOT NULL,
	"launched_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestone_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"milestone_id" uuid NOT NULL,
	"contribution_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"target_amount_cents" integer NOT NULL,
	"due_date" date,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text DEFAULT 'general' NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"related_jar_id" uuid,
	"action_url" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_method_placeholders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text DEFAULT 'card' NOT NULL,
	"label" text NOT NULL,
	"last4" text,
	"brand" text,
	"expiry_month" integer,
	"expiry_year" integer,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_sandbox" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"display_name" text NOT NULL,
	"avatar_url" text,
	"phone" text,
	"time_zone" text DEFAULT 'America/New_York' NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refund_request_placeholders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"jar_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text,
	"email_verified" boolean DEFAULT false NOT NULL,
	"reset_token" text,
	"reset_token_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"last_login_at" timestamp
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_events_jar_id_jars_id_fk') THEN
    ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'activity_events_user_id_users_id_fk') THEN
    ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agreement_acceptances_agreement_id_agreements_id_fk') THEN
    ALTER TABLE "agreement_acceptances" ADD CONSTRAINT "agreement_acceptances_agreement_id_agreements_id_fk" FOREIGN KEY ("agreement_id") REFERENCES "public"."agreements"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agreement_acceptances_user_id_users_id_fk') THEN
    ALTER TABLE "agreement_acceptances" ADD CONSTRAINT "agreement_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agreements_jar_id_jars_id_fk') THEN
    ALTER TABLE "agreements" ADD CONSTRAINT "agreements_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commitment_requests_jar_id_jars_id_fk') THEN
    ALTER TABLE "commitment_requests" ADD CONSTRAINT "commitment_requests_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commitment_requests_milestone_id_milestones_id_fk') THEN
    ALTER TABLE "commitment_requests" ADD CONSTRAINT "commitment_requests_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commitment_requests_created_by_user_id_users_id_fk') THEN
    ALTER TABLE "commitment_requests" ADD CONSTRAINT "commitment_requests_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commitment_votes_commitment_request_id_commitment_requests_id_fk') THEN
    ALTER TABLE "commitment_votes" ADD CONSTRAINT "commitment_votes_commitment_request_id_commitment_requests_id_fk" FOREIGN KEY ("commitment_request_id") REFERENCES "public"."commitment_requests"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commitment_votes_member_id_jar_members_id_fk') THEN
    ALTER TABLE "commitment_votes" ADD CONSTRAINT "commitment_votes_member_id_jar_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."jar_members"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contribution_schedules_jar_id_jars_id_fk') THEN
    ALTER TABLE "contribution_schedules" ADD CONSTRAINT "contribution_schedules_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contribution_schedules_member_id_jar_members_id_fk') THEN
    ALTER TABLE "contribution_schedules" ADD CONSTRAINT "contribution_schedules_member_id_jar_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."jar_members"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contributions_jar_id_jars_id_fk') THEN
    ALTER TABLE "contributions" ADD CONSTRAINT "contributions_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contributions_member_id_jar_members_id_fk') THEN
    ALTER TABLE "contributions" ADD CONSTRAINT "contributions_member_id_jar_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."jar_members"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_jar_id_jars_id_fk') THEN
    ALTER TABLE "invitations" ADD CONSTRAINT "invitations_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_invited_by_user_id_users_id_fk') THEN
    ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jar_members_jar_id_jars_id_fk') THEN
    ALTER TABLE "jar_members" ADD CONSTRAINT "jar_members_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jar_members_user_id_users_id_fk') THEN
    ALTER TABLE "jar_members" ADD CONSTRAINT "jar_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jars_organizer_id_users_id_fk') THEN
    ALTER TABLE "jars" ADD CONSTRAINT "jars_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestone_allocations_milestone_id_milestones_id_fk') THEN
    ALTER TABLE "milestone_allocations" ADD CONSTRAINT "milestone_allocations_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestone_allocations_contribution_id_contributions_id_fk') THEN
    ALTER TABLE "milestone_allocations" ADD CONSTRAINT "milestone_allocations_contribution_id_contributions_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "public"."contributions"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestones_jar_id_jars_id_fk') THEN
    ALTER TABLE "milestones" ADD CONSTRAINT "milestones_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_user_id_users_id_fk') THEN
    ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_related_jar_id_jars_id_fk') THEN
    ALTER TABLE "notifications" ADD CONSTRAINT "notifications_related_jar_id_jars_id_fk" FOREIGN KEY ("related_jar_id") REFERENCES "public"."jars"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_method_placeholders_user_id_users_id_fk') THEN
    ALTER TABLE "payment_method_placeholders" ADD CONSTRAINT "payment_method_placeholders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'profiles_user_id_users_id_fk') THEN
    ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_request_placeholders_jar_id_jars_id_fk') THEN
    ALTER TABLE "refund_request_placeholders" ADD CONSTRAINT "refund_request_placeholders_jar_id_jars_id_fk" FOREIGN KEY ("jar_id") REFERENCES "public"."jars"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'refund_request_placeholders_member_id_jar_members_id_fk') THEN
    ALTER TABLE "refund_request_placeholders" ADD CONSTRAINT "refund_request_placeholders_member_id_jar_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."jar_members"("id") ON DELETE no action ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_jar_idx" ON "activity_events" USING btree ("jar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_user_idx" ON "activity_events" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agreement_acceptances_agreement_user_idx" ON "agreement_acceptances" USING btree ("agreement_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agreements_jar_idx" ON "agreements" USING btree ("jar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "commitments_jar_idx" ON "commitment_requests" USING btree ("jar_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "commitment_votes_request_member_idx" ON "commitment_votes" USING btree ("commitment_request_id","member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_jar_idx" ON "contribution_schedules" USING btree ("jar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_member_idx" ON "contribution_schedules" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contributions_jar_idx" ON "contributions" USING btree ("jar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "contributions_member_idx" ON "contributions" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_idx" ON "invitations" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_jar_idx" ON "invitations" USING btree ("jar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jar_members_jar_user_idx" ON "jar_members" USING btree ("jar_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jar_members_jar_idx" ON "jar_members" USING btree ("jar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jar_members_user_idx" ON "jar_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jars_slug_idx" ON "jars" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jars_organizer_idx" ON "jars" USING btree ("organizer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestones_jar_idx" ON "milestones" USING btree ("jar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_jar_idx" ON "notifications" USING btree ("related_jar_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payment_methods_user_idx" ON "payment_method_placeholders" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "profiles_user_id_idx" ON "profiles" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users" USING btree ("email");