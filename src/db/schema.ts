import { sql } from 'drizzle-orm';
import {
  boolean, check, date, foreignKey, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';
import {
  CADENCES, DECISION_STATUSES, HANDOVER_STATUSES, KNOWLEDGE_TYPES, KNOWLEDGE_VISIBILITY, PROJECT_STATUSES, TASK_STATUSES,
  ACCESS_LEVELS, FREQUENCIES, PRIORITIES, REPORTING_FREQUENCIES, ROLE_TYPES, RULE_KINDS, SCOPES, STAGES, WORKFORCE_MODES,
} from '@/lib/constants';

/**
 * Tenant isolation at the database level: every tenant-owned table carries company_id and every
 * relationship between tenant tables is a COMPOSITE foreign key (company_id, id). A row in company A
 * can therefore never reference a row in company B, even if application code has a bug.
 */
const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const accessLevelEnum = pgEnum('access_level', ACCESS_LEVELS);
export const membershipStatusEnum = pgEnum('membership_status', ['active', 'suspended', 'removed']);
export const roleTypeEnum = pgEnum('role_type', ROLE_TYPES);
export const roleStatusEnum = pgEnum('role_status', ['active', 'inactive']);
export const priorityEnum = pgEnum('priority', PRIORITIES);
export const frequencyEnum = pgEnum('frequency', FREQUENCIES);
export const reportingFrequencyEnum = pgEnum('reporting_frequency', REPORTING_FREQUENCIES);
export const ruleKindEnum = pgEnum('rule_kind', RULE_KINDS);
export const scopeEnum = pgEnum('permission_scope', SCOPES);
export const stageEnum = pgEnum('company_stage', STAGES);
export const employeeStatusEnum = pgEnum('employee_status', ['active', 'on_leave', 'inactive']);
export const agentStatusEnum = pgEnum('agent_status', ['inactive', 'active']);
export const runStatusEnum = pgEnum('ai_run_status', ['running', 'succeeded', 'failed', 'blocked']);
export const workItemKindEnum = pgEnum('ai_work_item_kind', ['suggestion', 'draft', 'action']);
export const workItemStatusEnum = pgEnum('ai_work_item_status', ['pending_review', 'approved', 'rejected', 'executed', 'failed']);
export const taskStatusEnum = pgEnum('task_status', TASK_STATUSES);
export const projectStatusEnum = pgEnum('project_status', PROJECT_STATUSES);
export const cadenceEnum = pgEnum('recurrence_cadence', CADENCES);
export const knowledgeTypeEnum = pgEnum('knowledge_doc_type', KNOWLEDGE_TYPES);
export const knowledgeVisibilityEnum = pgEnum('knowledge_visibility', KNOWLEDGE_VISIBILITY);
export const decisionStatusEnum = pgEnum('decision_status', DECISION_STATUSES);
export const handoverStatusEnum = pgEnum('handover_status', HANDOVER_STATUSES);
export const workforceModeEnum = pgEnum('workforce_mode', WORKFORCE_MODES);

// ───────────── identity (global, not tenant-owned) ─────────────
export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (t) => [uniqueIndex('users_email_uq').on(t.email)]);

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('sessions_token_uq').on(t.tokenHash), index('sessions_user_idx').on(t.userId)]);

export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: id(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('prt_token_uq').on(t.tokenHash)]);

/** Global permission catalog (resource x action), seeded idempotently at startup. */
export const permissions = pgTable('permissions', {
  key: text('key').primaryKey(),
  resource: text('resource').notNull(),
  action: text('action').notNull(),
  description: text('description').notNull(),
});

// ───────────── tenants ─────────────
export const companies = pgTable('companies', {
  id: id(),
  name: text('name').notNull(),
  logoUrl: text('logo_url'),
  industry: text('industry'),
  businessModel: text('business_model'),
  productService: text('product_service'),
  targetCustomers: text('target_customers'),
  description: text('description'),
  website: text('website'),
  country: text('country'),
  stage: stageEnum('stage').notNull().default('idea'),
  teamSize: integer('team_size'),
  budgetRange: text('budget_range'),
  objectives: jsonb('objectives').$type<string[]>().notNull().default([]),
  workforceMode: workforceModeEnum('workforce_mode').notNull().default('hybrid'),
  orgTemplate: text('org_template'),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
});

export const companyMemberships = pgTable('company_memberships', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  accessLevel: accessLevelEnum('access_level').notNull().default('member'),
  status: membershipStatusEnum('status').notNull().default('active'),
  jobTitle: text('job_title'),
  createdAt: createdAt(),
  removedAt: timestamp('removed_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('cm_company_user_uq').on(t.companyId, t.userId),
  unique('cm_company_id_uq').on(t.companyId, t.id),
  index('cm_user_idx').on(t.userId),
  // exactly one owner per company
  uniqueIndex('cm_one_owner_uq').on(t.companyId).where(sql`${t.accessLevel} = 'owner' and ${t.status} = 'active'`),
]);

/** Explicit, per-person permission grants (configurable admin permissions). Always company-wide. */
export const membershipPermissions = pgTable('membership_permissions', {
  companyId: uuid('company_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  permissionKey: text('permission_key').notNull().references(() => permissions.key),
  grantedBy: uuid('granted_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  primaryKey({ columns: [t.membershipId, t.permissionKey] }),
  foreignKey({ columns: [t.companyId, t.membershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
]);

export const companyInvites = pgTable('company_invites', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  email: text('email').notNull(),
  accessLevel: accessLevelEnum('access_level').notNull().default('member'),
  roleId: uuid('role_id'),
  /** onboarding presets applied when the invite is accepted: departmentId, managerMembershipId, jobTitle, roleIds */
  profile: jsonb('profile').$type<{ departmentId?: string | null; managerMembershipId?: string | null; jobTitle?: string | null; roleIds?: string[] }>().notNull().default({}),
  tokenHash: text('token_hash').notNull(),
  invitedBy: uuid('invited_by').notNull().references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [uniqueIndex('ci_token_uq').on(t.tokenHash), index('ci_company_idx').on(t.companyId)]);

export const departments = pgTable('departments', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  description: text('description'),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('dept_company_id_uq').on(t.companyId, t.id),
  uniqueIndex('dept_name_uq').on(t.companyId, sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`),
]);

export const roles = pgTable('roles', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  departmentId: uuid('department_id'),
  name: text('name').notNull(),
  description: text('description'),
  reportsToRoleId: uuid('reports_to_role_id'),
  roleType: roleTypeEnum('role_type').notNull().default('vacant'),
  status: roleStatusEnum('status').notNull().default('active'),
  reportingFrequency: reportingFrequencyEnum('reporting_frequency').notNull().default('weekly'),
  hasApprovalAuthority: boolean('has_approval_authority').notNull().default(false),
  approvalLimit: numeric('approval_limit', { precision: 14, scale: 2 }),
  position: integer('position').notNull().default(0),
  templateKey: text('template_key'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('roles_company_id_uq').on(t.companyId, t.id),
  index('roles_parent_idx').on(t.companyId, t.reportsToRoleId),
  foreignKey({ columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
  foreignKey({ columns: [t.companyId, t.reportsToRoleId], foreignColumns: [t.companyId, t.id] }),
]);

export const roleResponsibilities = pgTable('role_responsibilities', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  roleId: uuid('role_id').notNull(),
  ownerRoleId: uuid('owner_role_id'), // responsibility currently owned by a different role
  title: text('title').notNull(),
  description: text('description'),
  expectedOutcome: text('expected_outcome'),
  priority: priorityEnum('priority').notNull().default('medium'),
  frequency: frequencyEnum('frequency').notNull().default('ongoing'),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  status: roleStatusEnum('status').notNull().default('active'),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('resp_company_id_uq').on(t.companyId, t.id),
  index('resp_role_idx').on(t.companyId, t.roleId),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
  foreignKey({ columns: [t.companyId, t.ownerRoleId], foreignColumns: [roles.companyId, roles.id] }),
]);

export const roleRules = pgTable('role_rules', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  roleId: uuid('role_id').notNull(),
  kind: ruleKindEnum('kind').notNull().default('allow'),
  text: text('text').notNull(),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  index('rules_role_idx').on(t.companyId, t.roleId),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
]);

export const roleKpis = pgTable('role_kpis', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  roleId: uuid('role_id').notNull(),
  name: text('name').notNull(),
  description: text('description'),
  target: text('target'),
  unit: text('unit'),
  period: reportingFrequencyEnum('period').notNull().default('monthly'),
  /** Phase 3: numeric target, direction, where the actual comes from, sensitivity gate, how often it is reported */
  targetValue: numeric('target_value', { precision: 18, scale: 4 }),
  direction: text('direction').notNull().default('higher'),
  dataSource: text('data_source').notNull().default('manual'),
  sensitivity: text('sensitivity').notNull().default('standard'),
  reportingFrequency: reportingFrequencyEnum('reporting_frequency').notNull().default('monthly'),
  position: integer('position').notNull().default(0),
  createdAt: createdAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('kpi_company_id_uq').on(t.companyId, t.id),
  index('kpi_role_idx').on(t.companyId, t.roleId),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
]);

/** Permissions granted to whoever holds the role. Hierarchy never implies access: only rows here do. */
export const rolePermissions = pgTable('role_permissions', {
  companyId: uuid('company_id').notNull(),
  roleId: uuid('role_id').notNull(),
  permissionKey: text('permission_key').notNull().references(() => permissions.key),
  scope: scopeEnum('scope').notNull().default('company'),
}, (t) => [
  primaryKey({ columns: [t.roleId, t.permissionKey] }),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
]);


// ───────────── Phase 2: workforce ─────────────
/** Human employee profile: 1:1 with a company membership (access lives on the membership, the person lives here). */
export const employees = pgTable('employees', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  departmentId: uuid('department_id'),
  managerMembershipId: uuid('manager_membership_id'),
  status: employeeStatusEnum('status').notNull().default('active'),
  phone: text('phone'),
  bio: text('bio'),
  startDate: timestamp('start_date', { withTimezone: true }).defaultNow(),
  onboarding: jsonb('onboarding').$type<{ id: string; title: string; done: boolean; kind?: string; link?: string }[]>().notNull().default([]),
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  deactivatedBy: uuid('deactivated_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex('emp_membership_uq').on(t.companyId, t.membershipId),
  index('emp_dept_idx').on(t.companyId, t.departmentId),
  foreignKey({ columns: [t.companyId, t.membershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
  foreignKey({ columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
  foreignKey({ columns: [t.companyId, t.managerMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
]);

export const aiAgents = pgTable('ai_agents', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  description: text('description'),
  departmentId: uuid('department_id'),
  /** the accountable human; every AI employee has one */
  managerMembershipId: uuid('manager_membership_id'),
  status: agentStatusEnum('status').notNull().default('inactive'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('agents_company_id_uq').on(t.companyId, t.id),
  foreignKey({ columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
  foreignKey({ columns: [t.companyId, t.managerMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
]);

export const roleAssignments = pgTable('role_assignments', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  roleId: uuid('role_id').notNull(),
  membershipId: uuid('membership_id'),
  agentId: uuid('agent_id'),
  /** true = this assignee is the role's owner (exactly one active owner per role) */
  isPrimary: boolean('is_primary').notNull().default(false),
  assignedBy: uuid('assigned_by').references(() => users.id),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('ra_active_uq').on(t.roleId, t.membershipId).where(sql`${t.endedAt} is null`),
  uniqueIndex('ra_active_agent_uq').on(t.roleId, t.agentId).where(sql`${t.endedAt} is null`),
  uniqueIndex('ra_owner_uq').on(t.roleId).where(sql`${t.endedAt} is null and ${t.isPrimary}`),
  check('ra_one_assignee', sql`(${t.membershipId} is null) <> (${t.agentId} is null)`),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
  index('ra_member_idx').on(t.companyId, t.membershipId),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
  foreignKey({ columns: [t.companyId, t.membershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
]);

export const auditLogs = pgTable('audit_logs', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [index('audit_company_time_idx').on(t.companyId, t.createdAt)]);

export const agentConfigurations = pgTable('agent_configurations', {
  agentId: uuid('agent_id').primaryKey(),
  companyId: uuid('company_id').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  instructions: text('instructions').notNull().default(''),
  /** 1 suggest only · 2 draft for review · 3 execute approved · 4 execute authorised routine */
  autonomyLevel: integer('autonomy_level').notNull().default(1),
  /** none | role | department | company — what company information the agent may read */
  knowledgeScope: text('knowledge_scope').notNull().default('role'),
  monthlyTokenLimit: integer('monthly_token_limit'),
  monthlyBudgetUsd: numeric('monthly_budget_usd', { precision: 12, scale: 2 }),
  version: integer('version').notNull().default(1),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: updatedAt(),
}, (t) => [
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
  check('autonomy_range', sql`${t.autonomyLevel} between 1 and 4`),
]);

export const agentToolPermissions = pgTable('agent_tool_permissions', {
  companyId: uuid('company_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  toolKey: text('tool_key').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  requiresApproval: boolean('requires_approval').notNull().default(true),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.toolKey] }),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

/** Which of its roles' responsibilities the AI performs (the rest stay with the humans). */
export const agentResponsibilities = pgTable('agent_responsibilities', {
  companyId: uuid('company_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  responsibilityId: uuid('responsibility_id').notNull().references(() => roleResponsibilities.id),
}, (t) => [
  primaryKey({ columns: [t.agentId, t.responsibilityId] }),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

export const aiRuns = pgTable('ai_runs', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  triggeredBy: uuid('triggered_by').references(() => users.id),
  input: text('input').notNull(),
  status: runStatusEnum('status').notNull().default('running'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  autonomyLevel: integer('autonomy_level').notNull(),
  output: jsonb('output').$type<Record<string, unknown> | null>(),
  steps: jsonb('steps').$type<Record<string, unknown>[]>().notNull().default([]),
  error: text('error'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
}, (t) => [
  index('runs_agent_idx').on(t.companyId, t.agentId, t.startedAt),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

export const aiUsageRecords = pgTable('ai_usage_records', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  runId: uuid('run_id').references(() => aiRuns.id),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  /** null when no price is configured for the model; never guessed */
  costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
  createdAt: createdAt(),
}, (t) => [
  index('usage_agent_time_idx').on(t.companyId, t.agentId, t.createdAt),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

/** Everything an AI produces that needs a human: suggestions, drafts, and queued tool actions. */
export const aiWorkItems = pgTable('ai_work_items', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  agentId: uuid('agent_id').notNull(),
  runId: uuid('run_id').references(() => aiRuns.id),
  roleId: uuid('role_id'),
  kind: workItemKindEnum('kind').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  toolKey: text('tool_key'),
  toolArgs: jsonb('tool_args').$type<Record<string, unknown> | null>(),
  status: workItemStatusEnum('status').notNull().default('pending_review'),
  result: text('result'),
  reviewedBy: uuid('reviewed_by').references(() => users.id),
  reviewNote: text('review_note'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('wi_company_status_idx').on(t.companyId, t.status, t.createdAt),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

// ───────────── Phase 3: operations ─────────────
export const projects = pgTable('projects', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  name: text('name').notNull(),
  description: text('description'),
  ownerMembershipId: uuid('owner_membership_id').notNull(),
  departmentId: uuid('department_id'),
  status: projectStatusEnum('status').notNull().default('planning'),
  startDate: date('start_date'),
  deadline: date('deadline'),
  goals: jsonb('goals').$type<string[]>().notNull().default([]),
  deliverables: jsonb('deliverables').$type<{ id: string; title: string; done: boolean }[]>().notNull().default([]),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('projects_company_id_uq').on(t.companyId, t.id),
  foreignKey({ columns: [t.companyId, t.ownerMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
  foreignKey({ columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
]);

export const projectMembers = pgTable('project_members', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  projectId: uuid('project_id').notNull(),
  membershipId: uuid('membership_id'),
  agentId: uuid('agent_id'),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('pm_member_uq').on(t.projectId, t.membershipId),
  uniqueIndex('pm_agent_uq').on(t.projectId, t.agentId),
  check('pm_one', sql`(${t.membershipId} is null) <> (${t.agentId} is null)`),
  foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id] }),
  foreignKey({ columns: [t.companyId, t.membershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
  foreignKey({ columns: [t.companyId, t.agentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

export const tasks = pgTable('tasks', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  title: text('title').notNull(),
  description: text('description'),
  departmentId: uuid('department_id'),
  roleId: uuid('role_id'),
  responsibilityId: uuid('responsibility_id'),
  projectId: uuid('project_id'),
  parentTaskId: uuid('parent_task_id'),
  /** every task has exactly one owner: a person or an AI employee */
  ownerMembershipId: uuid('owner_membership_id'),
  ownerAgentId: uuid('owner_agent_id'),
  createdBy: uuid('created_by').references(() => users.id),
  createdByAgentId: uuid('created_by_agent_id'),
  priority: priorityEnum('priority').notNull().default('medium'),
  status: taskStatusEnum('status').notNull().default('todo'),
  startDate: date('start_date'),
  dueDate: date('due_date'),
  estimatedHours: numeric('estimated_hours', { precision: 8, scale: 2 }),
  actualHours: numeric('actual_hours', { precision: 8, scale: 2 }),
  blockedReason: text('blocked_reason'),
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).notNull().defaultNow(),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  approvedBy: uuid('approved_by').references(() => users.id),
  deliverables: jsonb('deliverables').$type<{ id: string; title: string; done: boolean }[]>().notNull().default([]),
  recurringId: uuid('recurring_id'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('tasks_company_id_uq').on(t.companyId, t.id),
  index('tasks_status_idx').on(t.companyId, t.status, t.dueDate),
  index('tasks_owner_idx').on(t.companyId, t.ownerMembershipId),
  uniqueIndex('tasks_recurring_occ_uq').on(t.recurringId, t.startDate).where(sql`${t.recurringId} is not null`),
  check('task_one_owner', sql`(${t.ownerMembershipId} is null) <> (${t.ownerAgentId} is null)`),
  foreignKey({ columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
  foreignKey({ columns: [t.companyId, t.responsibilityId], foreignColumns: [roleResponsibilities.companyId, roleResponsibilities.id] }),
  foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id] }),
  foreignKey({ columns: [t.companyId, t.parentTaskId], foreignColumns: [t.companyId, t.id] }),
  foreignKey({ columns: [t.companyId, t.ownerMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
  foreignKey({ columns: [t.companyId, t.ownerAgentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
  foreignKey({ columns: [t.companyId, t.createdByAgentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

export const taskDependencies = pgTable('task_dependencies', {
  companyId: uuid('company_id').notNull(),
  taskId: uuid('task_id').notNull(),
  dependsOnTaskId: uuid('depends_on_task_id').notNull(),
}, (t) => [
  primaryKey({ columns: [t.taskId, t.dependsOnTaskId] }),
  check('dep_not_self', sql`${t.taskId} <> ${t.dependsOnTaskId}`),
  foreignKey({ columns: [t.companyId, t.taskId], foreignColumns: [tasks.companyId, tasks.id] }),
  foreignKey({ columns: [t.companyId, t.dependsOnTaskId], foreignColumns: [tasks.companyId, tasks.id] }),
]);

export const taskComments = pgTable('task_comments', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  taskId: uuid('task_id').notNull(),
  authorUserId: uuid('author_user_id').references(() => users.id),
  authorAgentId: uuid('author_agent_id'),
  body: text('body').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('tc_task_idx').on(t.companyId, t.taskId, t.createdAt),
  foreignKey({ columns: [t.companyId, t.taskId], foreignColumns: [tasks.companyId, tasks.id] }),
  foreignKey({ columns: [t.companyId, t.authorAgentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

export const taskAttachments = pgTable('task_attachments', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  taskId: uuid('task_id').notNull(),
  fileName: text('file_name').notNull(),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  dataBase64: text('data_base64').notNull(),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  createdAt: createdAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  index('ta_task_idx').on(t.companyId, t.taskId),
  foreignKey({ columns: [t.companyId, t.taskId], foreignColumns: [tasks.companyId, tasks.id] }),
]);

export const taskActivity = pgTable('task_activity', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  taskId: uuid('task_id').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  actorAgentId: uuid('actor_agent_id'),
  action: text('action').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
}, (t) => [
  index('tact_task_idx').on(t.companyId, t.taskId, t.createdAt),
  foreignKey({ columns: [t.companyId, t.taskId], foreignColumns: [tasks.companyId, tasks.id] }),
  foreignKey({ columns: [t.companyId, t.actorAgentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

export const recurringTasks = pgTable('recurring_tasks', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  title: text('title').notNull(),
  description: text('description'),
  departmentId: uuid('department_id'),
  roleId: uuid('role_id'),
  projectId: uuid('project_id'),
  ownerMembershipId: uuid('owner_membership_id'),
  ownerAgentId: uuid('owner_agent_id'),
  priority: priorityEnum('priority').notNull().default('medium'),
  cadence: cadenceEnum('cadence').notNull(),
  dueAfterDays: integer('due_after_days').notNull().default(0),
  requiresApproval: boolean('requires_approval').notNull().default(false),
  nextRunOn: date('next_run_on').notNull(),
  endsOn: date('ends_on'),
  active: boolean('active').notNull().default(true),
  lastGeneratedAt: timestamp('last_generated_at', { withTimezone: true }),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  unique('recurring_company_id_uq').on(t.companyId, t.id),
  check('rec_one_owner', sql`(${t.ownerMembershipId} is null) <> (${t.ownerAgentId} is null)`),
  foreignKey({ columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
  foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id] }),
  foreignKey({ columns: [t.companyId, t.ownerMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
  foreignKey({ columns: [t.companyId, t.ownerAgentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

export const kpiValues = pgTable('kpi_values', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  kpiId: uuid('kpi_id').notNull(),
  periodStart: date('period_start').notNull(),
  periodEnd: date('period_end').notNull(),
  value: numeric('value', { precision: 18, scale: 4 }).notNull(),
  note: text('note'),
  recordedBy: uuid('recorded_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('kv_period_uq').on(t.kpiId, t.periodStart, t.periodEnd),
  foreignKey({ columns: [t.companyId, t.kpiId], foreignColumns: [roleKpis.companyId, roleKpis.id] }),
]);

/** Explicit, extra report access on top of reports.view (custom reporting permissions). Hierarchy alone never creates a row here. */
export const reportGrants = pgTable('report_grants', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  membershipId: uuid('membership_id').notNull(),
  scopeType: text('scope_type').notNull(),
  scopeId: uuid('scope_id').notNull(),
  grantedBy: uuid('granted_by').references(() => users.id),
  createdAt: createdAt(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('rg_active_uq').on(t.membershipId, t.scopeType, t.scopeId).where(sql`${t.revokedAt} is null`),
  check('rg_type', sql`${t.scopeType} in ('department','role','project','employee')`),
  foreignKey({ columns: [t.companyId, t.membershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
]);

export const notifications = pgTable('notifications', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  link: text('link'),
  dedupeKey: text('dedupe_key'),
  readAt: timestamp('read_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('notif_dedupe_uq').on(t.userId, t.dedupeKey),
  index('notif_user_idx').on(t.userId, t.companyId, t.createdAt),
]);

// ───────────── Phase 4: knowledge, decisions, continuity ─────────────
export const knowledgeDocuments = pgTable('knowledge_documents', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  title: text('title').notNull(),
  docType: knowledgeTypeEnum('doc_type').notNull().default('other'),
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  visibility: knowledgeVisibilityEnum('visibility').notNull().default('company'),
  /** confidential documents are never readable through scope alone — only by explicit grant, their owner, or knowledge administrators */
  confidential: boolean('confidential').notNull().default(false),
  departmentId: uuid('department_id'),
  roleId: uuid('role_id'),
  projectId: uuid('project_id'),
  responsibilityId: uuid('responsibility_id'),
  ownerMembershipId: uuid('owner_membership_id').notNull(),
  status: text('status').notNull().default('published'),
  currentVersion: integer('current_version').notNull().default(1),
  reviewDate: date('review_date'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('kdoc_company_id_uq').on(t.companyId, t.id),
  index('kdoc_type_idx').on(t.companyId, t.docType),
  check('kdoc_status', sql`${t.status} in ('draft','published')`),
  foreignKey({ columns: [t.companyId, t.departmentId], foreignColumns: [departments.companyId, departments.id] }),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
  foreignKey({ columns: [t.companyId, t.projectId], foreignColumns: [projects.companyId, projects.id] }),
  foreignKey({ columns: [t.companyId, t.responsibilityId], foreignColumns: [roleResponsibilities.companyId, roleResponsibilities.id] }),
  foreignKey({ columns: [t.companyId, t.ownerMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
]);

/** Every edit appends a version; versions are never changed or deleted. */
export const knowledgeVersions = pgTable('knowledge_versions', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  documentId: uuid('document_id').notNull(),
  version: integer('version').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  changeNote: text('change_note'),
  fileName: text('file_name'),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  sha256: text('sha256'),
  dataBase64: text('data_base64'),
  textExtracted: boolean('text_extracted').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
}, (t) => [
  uniqueIndex('kver_doc_version_uq').on(t.documentId, t.version),
  foreignKey({ columns: [t.companyId, t.documentId], foreignColumns: [knowledgeDocuments.companyId, knowledgeDocuments.id] }),
]);

/** Search index of the CURRENT version: text chunks with an embedding (model recorded per chunk). */
export const knowledgeChunks = pgTable('knowledge_chunks', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  documentId: uuid('document_id').notNull(),
  versionId: uuid('version_id').notNull().references(() => knowledgeVersions.id),
  chunkIndex: integer('chunk_index').notNull(),
  heading: text('heading'),
  content: text('content').notNull(),
  embedding: jsonb('embedding').$type<number[]>().notNull(),
  embeddingModel: text('embedding_model').notNull(),
  createdAt: createdAt(),
}, (t) => [
  index('kchunk_doc_idx').on(t.companyId, t.documentId),
  foreignKey({ columns: [t.companyId, t.documentId], foreignColumns: [knowledgeDocuments.companyId, knowledgeDocuments.id] }),
]);

/** Explicit access grants beyond scope: to a person, a role, a department or an AI employee. */
export const knowledgeAccess = pgTable('knowledge_access', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  documentId: uuid('document_id').notNull(),
  scopeType: text('scope_type').notNull(),
  scopeId: uuid('scope_id').notNull(),
  grantedBy: uuid('granted_by').references(() => users.id),
  createdAt: createdAt(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('kacc_active_uq').on(t.documentId, t.scopeType, t.scopeId).where(sql`${t.revokedAt} is null`),
  check('kacc_type', sql`${t.scopeType} in ('member','role','department','agent')`),
  foreignKey({ columns: [t.companyId, t.documentId], foreignColumns: [knowledgeDocuments.companyId, knowledgeDocuments.id] }),
]);

/** Which documents an AI employee retrieved (and confidential reads by people): knowledge source identification. */
export const knowledgeAccessLog = pgTable('knowledge_access_log', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  documentId: uuid('document_id').notNull(),
  version: integer('version').notNull(),
  actorUserId: uuid('actor_user_id').references(() => users.id),
  actorAgentId: uuid('actor_agent_id'),
  runId: uuid('run_id'),
  via: text('via').notNull(),
  query: text('query'),
  createdAt: createdAt(),
}, (t) => [
  index('klog_doc_idx').on(t.companyId, t.documentId, t.createdAt),
  foreignKey({ columns: [t.companyId, t.documentId], foreignColumns: [knowledgeDocuments.companyId, knowledgeDocuments.id] }),
]);

export const decisions = pgTable('decisions', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  decisionMakerMembershipId: uuid('decision_maker_membership_id'),
  status: decisionStatusEnum('status').notNull().default('proposed'),
  decidedOn: date('decided_on'),
  reason: text('reason'),
  alternatives: jsonb('alternatives').$type<{ option: string; reason?: string }[]>().notNull().default([]),
  expectedOutcome: text('expected_outcome'),
  outcomeNotes: text('outcome_notes'),
  relatedRoleId: uuid('related_role_id'),
  relatedProjectId: uuid('related_project_id'),
  reviewDate: date('review_date'),
  supersedesId: uuid('supersedes_id'),
  confidential: boolean('confidential').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id),
  createdByAgentId: uuid('created_by_agent_id'),
  approvedBy: uuid('approved_by').references(() => users.id),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  unique('decisions_company_id_uq').on(t.companyId, t.id),
  index('decisions_status_idx').on(t.companyId, t.status),
  foreignKey({ columns: [t.companyId, t.decisionMakerMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
  foreignKey({ columns: [t.companyId, t.relatedRoleId], foreignColumns: [roles.companyId, roles.id] }),
  foreignKey({ columns: [t.companyId, t.relatedProjectId], foreignColumns: [projects.companyId, projects.id] }),
  foreignKey({ columns: [t.companyId, t.supersedesId], foreignColumns: [t.companyId, t.id] }),
  foreignKey({ columns: [t.companyId, t.createdByAgentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

/** One handover per departure / transition. `report` is the frozen snapshot generated at the time. */
export const handovers = pgTable('handovers', {
  id: id(),
  companyId: uuid('company_id').notNull().references(() => companies.id),
  reason: text('reason').notNull(),
  subjectKind: text('subject_kind').notNull(),
  subjectName: text('subject_name').notNull(),
  fromMembershipId: uuid('from_membership_id'),
  fromAgentId: uuid('from_agent_id'),
  status: handoverStatusEnum('status').notNull().default('in_progress'),
  effectiveDate: date('effective_date'),
  notes: text('notes'),
  report: jsonb('report').$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  unique('handovers_company_id_uq').on(t.companyId, t.id),
  check('ho_reason', sql`${t.reason} in ('employee_exit','ai_to_human','human_to_ai','role_reassignment')`),
  foreignKey({ columns: [t.companyId, t.fromMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
  foreignKey({ columns: [t.companyId, t.fromAgentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

export const handoverItems = pgTable('handover_items', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  handoverId: uuid('handover_id').notNull(),
  roleId: uuid('role_id'),
  kind: text('kind').notNull(),
  refId: uuid('ref_id'),
  title: text('title').notNull(),
  detail: text('detail'),
  status: text('status').notNull().default('pending'),
  toMembershipId: uuid('to_membership_id'),
  toAgentId: uuid('to_agent_id'),
  note: text('note'),
  resolvedBy: uuid('resolved_by').references(() => users.id),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: createdAt(),
}, (t) => [
  index('hoi_handover_idx').on(t.companyId, t.handoverId, t.status),
  check('hoi_status', sql`${t.status} in ('pending','assigned','done','skipped')`),
  foreignKey({ columns: [t.companyId, t.handoverId], foreignColumns: [handovers.companyId, handovers.id] }),
  foreignKey({ columns: [t.companyId, t.toMembershipId], foreignColumns: [companyMemberships.companyId, companyMemberships.id] }),
  foreignKey({ columns: [t.companyId, t.toAgentId], foreignColumns: [aiAgents.companyId, aiAgents.id] }),
]);

/** Per role: who held it, who holds it next, what changed in access, whether the transition is done. */
export const roleTransitions = pgTable('role_transitions', {
  id: id(),
  companyId: uuid('company_id').notNull(),
  handoverId: uuid('handover_id').notNull(),
  roleId: uuid('role_id').notNull(),
  fromKind: text('from_kind').notNull(),
  fromMembershipId: uuid('from_membership_id'),
  fromAgentId: uuid('from_agent_id'),
  toKind: text('to_kind'),
  toMembershipId: uuid('to_membership_id'),
  toAgentId: uuid('to_agent_id'),
  assistantAgentId: uuid('assistant_agent_id'),
  status: text('status').notNull().default('pending'),
  accessChanges: jsonb('access_changes').$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
}, (t) => [
  index('rtr_handover_idx').on(t.companyId, t.handoverId),
  check('rtr_status', sql`${t.status} in ('pending','completed')`),
  foreignKey({ columns: [t.companyId, t.handoverId], foreignColumns: [handovers.companyId, handovers.id] }),
  foreignKey({ columns: [t.companyId, t.roleId], foreignColumns: [roles.companyId, roles.id] }),
]);
