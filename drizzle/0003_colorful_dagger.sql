CREATE TYPE "public"."decision_status" AS ENUM('proposed', 'approved', 'rejected', 'superseded');
--> statement-breakpoint
CREATE TYPE "public"."handover_status" AS ENUM('in_progress', 'completed', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."knowledge_doc_type" AS ENUM('business_plan', 'goals', 'strategy', 'sop', 'policy', 'project_doc', 'report', 'decision', 'meeting_notes', 'role_description', 'workflow', 'other');
--> statement-breakpoint
CREATE TYPE "public"."knowledge_visibility" AS ENUM('company', 'department', 'role', 'restricted');
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"decision_maker_membership_id" uuid,
	"status" "decision_status" DEFAULT 'proposed' NOT NULL,
	"decided_on" date,
	"reason" text,
	"alternatives" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_outcome" text,
	"outcome_notes" text,
	"related_role_id" uuid,
	"related_project_id" uuid,
	"review_date" date,
	"supersedes_id" uuid,
	"confidential" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_by_agent_id" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "decisions_company_id_uq" UNIQUE("company_id","id")
);
--> statement-breakpoint
CREATE TABLE "handover_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"handover_id" uuid NOT NULL,
	"role_id" uuid,
	"kind" text NOT NULL,
	"ref_id" uuid,
	"title" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"to_membership_id" uuid,
	"to_agent_id" uuid,
	"note" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hoi_status" CHECK ("handover_items"."status" in ('pending','assigned','done','skipped'))
);
--> statement-breakpoint
CREATE TABLE "handovers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_name" text NOT NULL,
	"from_membership_id" uuid,
	"from_agent_id" uuid,
	"status" "handover_status" DEFAULT 'in_progress' NOT NULL,
	"effective_date" date,
	"notes" text,
	"report" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "handovers_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "ho_reason" CHECK ("handovers"."reason" in ('employee_exit','ai_to_human','human_to_ai','role_reassignment'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_access" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"granted_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "kacc_type" CHECK ("knowledge_access"."scope_type" in ('member','role','department','agent'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"actor_user_id" uuid,
	"actor_agent_id" uuid,
	"run_id" uuid,
	"via" text NOT NULL,
	"query" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"heading" text,
	"content" text NOT NULL,
	"embedding" jsonb NOT NULL,
	"embedding_model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"title" text NOT NULL,
	"doc_type" "knowledge_doc_type" DEFAULT 'other' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" "knowledge_visibility" DEFAULT 'company' NOT NULL,
	"confidential" boolean DEFAULT false NOT NULL,
	"department_id" uuid,
	"role_id" uuid,
	"project_id" uuid,
	"responsibility_id" uuid,
	"owner_membership_id" uuid NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"review_date" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "kdoc_company_id_uq" UNIQUE("company_id","id"),
	CONSTRAINT "kdoc_status" CHECK ("knowledge_documents"."status" in ('draft','published'))
);
--> statement-breakpoint
CREATE TABLE "knowledge_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"change_note" text,
	"file_name" text,
	"content_type" text,
	"size_bytes" integer,
	"sha256" text,
	"data_base64" text,
	"text_extracted" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"handover_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"from_kind" text NOT NULL,
	"from_membership_id" uuid,
	"from_agent_id" uuid,
	"to_kind" text,
	"to_membership_id" uuid,
	"to_agent_id" uuid,
	"assistant_agent_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"access_changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "rtr_status" CHECK ("role_transitions"."status" in ('pending','completed'))
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_decision_maker_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","decision_maker_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_related_role_id_roles_company_id_id_fk" FOREIGN KEY ("company_id","related_role_id") REFERENCES "public"."roles"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_related_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","related_project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_supersedes_id_decisions_company_id_id_fk" FOREIGN KEY ("company_id","supersedes_id") REFERENCES "public"."decisions"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_company_id_created_by_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","created_by_agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_company_id_handover_id_handovers_company_id_id_fk" FOREIGN KEY ("company_id","handover_id") REFERENCES "public"."handovers"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_company_id_to_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","to_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handover_items" ADD CONSTRAINT "handover_items_company_id_to_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","to_agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_company_id_from_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","from_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "handovers" ADD CONSTRAINT "handovers_company_id_from_agent_id_ai_agents_company_id_id_fk" FOREIGN KEY ("company_id","from_agent_id") REFERENCES "public"."ai_agents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_access" ADD CONSTRAINT "knowledge_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_access" ADD CONSTRAINT "knowledge_access_company_id_document_id_knowledge_documents_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."knowledge_documents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_access_log" ADD CONSTRAINT "knowledge_access_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_access_log" ADD CONSTRAINT "knowledge_access_log_company_id_document_id_knowledge_documents_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."knowledge_documents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_version_id_knowledge_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."knowledge_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_chunks" ADD CONSTRAINT "knowledge_chunks_company_id_document_id_knowledge_documents_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."knowledge_documents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_department_id_departments_company_id_id_fk" FOREIGN KEY ("company_id","department_id") REFERENCES "public"."departments"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_role_id_roles_company_id_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "public"."roles"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_project_id_projects_company_id_id_fk" FOREIGN KEY ("company_id","project_id") REFERENCES "public"."projects"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_responsibility_id_role_responsibilities_company_id_id_fk" FOREIGN KEY ("company_id","responsibility_id") REFERENCES "public"."role_responsibilities"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_company_id_owner_membership_id_company_memberships_company_id_id_fk" FOREIGN KEY ("company_id","owner_membership_id") REFERENCES "public"."company_memberships"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_versions" ADD CONSTRAINT "knowledge_versions_company_id_document_id_knowledge_documents_company_id_id_fk" FOREIGN KEY ("company_id","document_id") REFERENCES "public"."knowledge_documents"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_transitions" ADD CONSTRAINT "role_transitions_company_id_handover_id_handovers_company_id_id_fk" FOREIGN KEY ("company_id","handover_id") REFERENCES "public"."handovers"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "role_transitions" ADD CONSTRAINT "role_transitions_company_id_role_id_roles_company_id_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "public"."roles"("company_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "decisions_status_idx" ON "decisions" USING btree ("company_id","status");
--> statement-breakpoint
CREATE INDEX "hoi_handover_idx" ON "handover_items" USING btree ("company_id","handover_id","status");
--> statement-breakpoint
CREATE UNIQUE INDEX "kacc_active_uq" ON "knowledge_access" USING btree ("document_id","scope_type","scope_id") WHERE "knowledge_access"."revoked_at" is null;
--> statement-breakpoint
CREATE INDEX "klog_doc_idx" ON "knowledge_access_log" USING btree ("company_id","document_id","created_at");
--> statement-breakpoint
CREATE INDEX "kchunk_doc_idx" ON "knowledge_chunks" USING btree ("company_id","document_id");
--> statement-breakpoint
CREATE INDEX "kdoc_type_idx" ON "knowledge_documents" USING btree ("company_id","doc_type");
--> statement-breakpoint
CREATE UNIQUE INDEX "kver_doc_version_uq" ON "knowledge_versions" USING btree ("document_id","version");
--> statement-breakpoint
CREATE INDEX "rtr_handover_idx" ON "role_transitions" USING btree ("company_id","handover_id");
