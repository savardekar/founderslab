CREATE TYPE "public"."agent_status" AS ENUM('inactive', 'active');--> statement-breakpoint
CREATE TYPE "public"."employee_status" AS ENUM('active', 'on_leave', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."ai_run_status" AS ENUM('running', 'succeeded', 'failed', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."ai_work_item_kind" AS ENUM('suggestion', 'draft', 'action');--> statement-breakpoint
CREATE TYPE "public"."ai_work_item_status" AS ENUM('pending_review', 'approved', 'rejected', 'executed', 'failed');--> statement-breakpoint
CREATE TABLE "agent_configurations" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"autonomy_level" integer DEFAULT 1 NOT NULL,
	"knowledge_scope" text DEFAULT 'role' NOT NULL,
	"monthly_token_limit" integer,
	"monthly_budget_usd" numeric(12, 2),
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "autonomy_range" CHECK ("agent_configurations"."autonomy_level" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "agent_responsibilities" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"responsibility_id" uuid NOT NULL,
	CONSTRAINT "agent_responsibilities_agent_id_responsibility_id_pk" PRIMARY KEY("agent_id","responsibility_id")
);
--> statement-breakpoint
CREATE TABLE "agent_tool_permissions" (
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"tool_key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	CONSTRAINT "agent_tool_permissions_agent_id_tool_key_pk" PRIMARY KEY("agent_id","tool_key")
);
--> statement-breakpoint
CREATE TABLE "ai_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"department_id" uuid,
	"manager_membership_id" uuid,
	"status" "agent_status" DEFAULT 'inactive' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "agents_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"triggered_by" uuid,
	"input" text NOT NULL,
	"status" "ai_run_status" DEFAULT 'running' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"autonomy_level" integer NOT NULL,
	"output" jsonb,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ai_usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_usd" numeric(12, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid,
	"role_id" uuid,
	"kind" "ai_work_item_kind" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tool_key" text,
	"tool_args" jsonb,
	"status" "ai_work_item_status" DEFAULT 'pending_review' NOT NULL,
	"result" text,
	"reviewed_by" uuid,
	"review_note" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"department_id" uuid,
	"manager_membership_id" uuid,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"phone" text,
	"bio" text,
	"start_date" timestamp with time zone DEFAULT now(),
	"onboarding" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "role_assignments" ALTER COLUMN "membership_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "role_assignments" ALTER COLUMN "is_primary" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "company_invites" ADD COLUMN "profile" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "role_assignments" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_configurations" ADD CONSTRAINT "agent_configurations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_configurations" ADD CONSTRAINT "agent_configurations_company_id_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_responsibilities" ADD CONSTRAINT "agent_responsibilities_responsibility_id_role_responsibilities_id_fk" FOREIGN KEY ("responsibility_id") REFERENCES "public"."role_responsibilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_responsibilities" ADD CONSTRAINT "agent_responsibilities_company_id_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_permissions" ADD CONSTRAINT "agent_tool_permissions_company_id_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_company_id_department_id_departments_company_id_id_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_agents" ADD CONSTRAINT "ai_agents_company_id_manager_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","manager_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_company_id_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_records" ADD CONSTRAINT "ai_usage_records_company_id_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_work_items" ADD CONSTRAINT "ai_work_items_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_work_items" ADD CONSTRAINT "ai_work_items_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_work_items" ADD CONSTRAINT "ai_work_items_company_id_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_deactivated_by_users_id_fk" FOREIGN KEY ("deactivated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_department_id_departments_company_id_id_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_company_id_manager_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","manager_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_agent_idx" ON "ai_runs" USING btree ("company_id","agent_id","started_at");--> statement-breakpoint
CREATE INDEX "usage_agent_time_idx" ON "ai_usage_records" USING btree ("company_id","agent_id","created_at");--> statement-breakpoint
CREATE INDEX "wi_company_status_idx" ON "ai_work_items" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "emp_membership_uq" ON "employees" USING btree ("company_id","membership_id");--> statement-breakpoint
CREATE INDEX "emp_dept_idx" ON "employees" USING btree ("company_id","department_id");--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "role_assignments_company_id_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ra_active_agent_uq" ON "role_assignments" USING btree ("role_id","agent_id") WHERE "role_assignments"."ended_at" is null;--> statement-breakpoint
UPDATE "role_assignments" SET "is_primary" = false;--> statement-breakpoint
UPDATE "role_assignments" ra SET "is_primary" = true WHERE ra."ended_at" IS NULL AND ra."id" = (SELECT x."id" FROM "role_assignments" x WHERE x."role_id" = ra."role_id" AND x."ended_at" IS NULL ORDER BY x."started_at", x."id" LIMIT 1);--> statement-breakpoint
CREATE UNIQUE INDEX "ra_owner_uq" ON "role_assignments" USING btree ("role_id") WHERE "role_assignments"."ended_at" is null and "role_assignments"."is_primary";--> statement-breakpoint
ALTER TABLE "role_assignments" ADD CONSTRAINT "ra_one_assignee" CHECK (("role_assignments"."membership_id" is null) <> ("role_assignments"."agent_id" is null));--> statement-breakpoint
INSERT INTO "employees" ("company_id","membership_id","status") SELECT "company_id","id",CASE WHEN "status"='active' THEN 'active'::employee_status ELSE 'inactive'::employee_status END FROM "company_memberships" WHERE "status" <> 'removed';
