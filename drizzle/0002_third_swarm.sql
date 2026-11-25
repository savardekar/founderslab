CREATE TYPE "public"."recurrence_cadence" AS ENUM('daily', 'weekly', 'monthly', 'quarterly');
--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('planning', 'active', 'on_hold', 'completed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'awaiting_approval', 'completed', 'cancelled');
--> statement-breakpoint
CREATE TABLE "kpi_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"kpi_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"value" numeric(18, 4) NOT NULL,
	"note" text,
	"recorded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"dedupe_key" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"membership_id" uuid,
	"agent_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pm_one" CHECK (("project_members"."membership_id" is null) <> ("project_members"."agent_id" is null))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_membership_id" uuid NOT NULL,
	"department_id" uuid,
	"status" "project_status" DEFAULT 'planning' NOT NULL,
	"start_date" date,
	"deadline" date,
	"goals" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deliverables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "projects_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "recurring_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"department_id" uuid,
	"role_id" uuid,
	"project_id" uuid,
	"owner_membership_id" uuid,
	"owner_agent_id" uuid,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"cadence" "recurrence_cadence" NOT NULL,
	"due_after_days" integer DEFAULT 0 NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"next_run_on" date NOT NULL,
	"ends_on" date,
	"active" boolean DEFAULT true NOT NULL,
	"last_generated_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "rec_one_owner" CHECK (("recurring_tasks"."owner_membership_id" is null) <> ("recurring_tasks"."owner_agent_id" is null))
);
--> statement-breakpoint
CREATE TABLE "report_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "rg_type" CHECK ("report_grants"."scope_type" in ('department','role','project','employee'))
);
--> statement-breakpoint
CREATE TABLE "task_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_agent_id" uuid,
	"action" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data_base64" text NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_agent_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_dependencies" (
	"company_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"depends_on_task_id" uuid NOT NULL,
	CONSTRAINT "task_dependencies_task_id_depends_on_task_id_pk" PRIMARY KEY("task_id","depends_on_task_id"),
	CONSTRAINT "dep_not_self" CHECK ("task_dependencies"."task_id" <> "task_dependencies"."depends_on_task_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"department_id" uuid,
	"role_id" uuid,
	"responsibility_id" uuid,
	"project_id" uuid,
	"parent_task_id" uuid,
	"owner_membership_id" uuid,
	"owner_agent_id" uuid,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"priority" "priority" DEFAULT 'medium' NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"start_date" date,
	"due_date" date,
	"estimated_hours" numeric(8, 2),
	"actual_hours" numeric(8, 2),
	"blocked_reason" text,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"approved_by" uuid,
	"deliverables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recurring_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tasks_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "task_one_owner" CHECK (("tasks"."owner_membership_id" is null) <> ("tasks"."owner_agent_id" is null))
);
--> statement-breakpoint
ALTER TABLE "role_kpis" ADD COLUMN "target_value" numeric(18, 4);
--> statement-breakpoint
ALTER TABLE "role_kpis" ADD COLUMN "direction" text DEFAULT 'higher' NOT NULL;
--> statement-breakpoint
ALTER TABLE "role_kpis" ADD COLUMN "data_source" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
ALTER TABLE "role_kpis" ADD COLUMN "sensitivity" text DEFAULT 'standard' NOT NULL;
--> statement-breakpoint
ALTER TABLE "role_kpis" ADD COLUMN "reporting_frequency" "reporting_frequency" DEFAULT 'monthly' NOT NULL;
--> statement-breakpoint
ALTER TABLE "role_kpis" ADD CONSTRAINT "kpi_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "role_responsibilities" ADD CONSTRAINT "resp_company_id_uq" UNIQUE("company_id","id");
--> statement-breakpoint
ALTER TABLE "kpi_values" ADD CONSTRAINT "kpi_values_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kpi_values" ADD CONSTRAINT "kpi_values_company_id_kpi_id_role_kpis_company_id_id_fk" FOREIGN KEY ("company_id","kpi_id") REFERENCES "public"."role_kpis"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_company_id_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_company_id_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_company_id_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_owner_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","owner_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_department_id_departments_company_id_id_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_tasks" ADD CONSTRAINT "recurring_tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_tasks" ADD CONSTRAINT "recurring_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_tasks" ADD CONSTRAINT "recurring_tasks_company_id_department_id_departments_company_id_id_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_tasks" ADD CONSTRAINT "recurring_tasks_company_id_role_id_roles_company_id_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "public"."roles"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_tasks" ADD CONSTRAINT "recurring_tasks_company_id_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_tasks" ADD CONSTRAINT "recurring_tasks_company_id_owner_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","owner_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "recurring_tasks" ADD CONSTRAINT "recurring_tasks_company_id_owner_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","owner_agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_grants" ADD CONSTRAINT "report_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "report_grants" ADD CONSTRAINT "report_grants_company_id_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_company_id_task_id_tasks_company_id_id_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_activity" ADD CONSTRAINT "task_activity_company_id_actor_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","actor_agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_company_id_task_id_tasks_company_id_id_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_company_id_task_id_tasks_company_id_id_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_company_id_author_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","author_agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_company_id_task_id_tasks_company_id_id_fk" FOREIGN KEY ("company_id","task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_dependencies" ADD CONSTRAINT "task_dependencies_company_id_depends_on_task_id_tasks_company_id_id_fk" FOREIGN KEY ("company_id","depends_on_task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_department_id_departments_company_id_id_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_role_id_roles_company_id_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "public"."roles"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_responsibility_id_role_responsibilities_company_id_id_fk" FOREIGN KEY ("company_id","responsibility_id") REFERENCES "public"."role_responsibilities"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_parent_task_id_tasks_company_id_id_fk" FOREIGN KEY ("company_id","parent_task_id") REFERENCES "public"."tasks"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_owner_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","owner_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_owner_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","owner_agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_created_by_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","created_by_agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "kv_period_uq" ON "kpi_values" USING btree ("kpi_id","period_start","period_end");
--> statement-breakpoint
CREATE UNIQUE INDEX "notif_dedupe_uq" ON "notifications" USING btree ("user_id","dedupe_key");
--> statement-breakpoint
CREATE INDEX "notif_user_idx" ON "notifications" USING btree ("user_id","company_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "pm_member_uq" ON "project_members" USING btree ("project_id","membership_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "pm_agent_uq" ON "project_members" USING btree ("project_id","agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "rg_active_uq" ON "report_grants" USING btree ("membership_id","scope_type","scope_id") WHERE "report_grants"."revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "tact_task_idx" ON "task_activity" USING btree ("company_id","task_id","created_at");
--> statement-breakpoint
CREATE INDEX "ta_task_idx" ON "task_attachments" USING btree ("company_id","task_id");
--> statement-breakpoint
CREATE INDEX "tc_task_idx" ON "task_comments" USING btree ("company_id","task_id","created_at");
--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("company_id","status","due_date");
--> statement-breakpoint
CREATE INDEX "tasks_owner_idx" ON "tasks" USING btree ("company_id","owner_membership_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_recurring_occ_uq" ON "tasks" USING btree ("recurring_id","start_date") WHERE "tasks"."recurring_id" is not null;
--> statement-breakpoint
UPDATE "role_kpis" SET "target_value" = "target"::numeric WHERE "target" ~ '^-?[0-9]+(\.[0-9]+)?$'
--> statement-breakpoint
UPDATE "role_kpis" SET "reporting_frequency" = "period"
--> statement-breakpoint
UPDATE "role_permissions" rp SET "scope" = 'department' FROM "roles" r WHERE r."id" = rp."role_id" AND r."company_id" = rp."company_id" AND rp."scope" = 'company' AND ((r."template_key" IN ('cmo','cfo','cto','cro','chro') AND split_part(rp."permission_key",'.',1) IN ('reports','kpis','tasks','projects')) OR (r."template_key" = 'coo' AND split_part(rp."permission_key",'.',1) IN ('reports','kpis')) OR (r."template_key" IN ('marketing_manager','operations_manager','sales_manager','product_manager','project_manager') AND split_part(rp."permission_key",'.',1) IN ('tasks','projects')))
--> statement-breakpoint
UPDATE "role_permissions" rp SET "scope" = 'own' FROM "roles" r WHERE r."id" = rp."role_id" AND r."company_id" = rp."company_id" AND rp."scope" = 'company' AND r."template_key" IN ('marketing_manager','operations_manager','sales_manager','product_manager','project_manager') AND split_part(rp."permission_key",'.',1) IN ('reports','kpis');
