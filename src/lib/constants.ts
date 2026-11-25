export const ACTIONS = ['view', 'create', 'edit', 'delete', 'assign', 'approve', 'export', 'configure'] as const;
export type Action = (typeof ACTIONS)[number];

// Resources that can be permissioned. Later-phase resources are in the catalog so roles can be configured now.
export const RESOURCES = {
  company: 'Company settings',
  members: 'Employees & membership',
  departments: 'Departments',
  roles: 'Roles & hierarchy',
  responsibilities: 'Responsibilities',
  permissions: 'Permissions & access',
  agents: 'AI employees',
  audit: 'Audit log',
  tasks: 'Tasks',
  projects: 'Projects',
  reports: 'Reports',
  kpis: 'KPIs & performance',
  finance: 'Financial data (sensitive)',
  knowledge: 'Knowledge base',
  decisions: 'Decision log',
  handover: 'Handover & transitions',
} as const;
export type Resource = keyof typeof RESOURCES;
export type PermissionKey = `${Resource}.${Action}`;
export const permKey = (r: Resource, a: Action) => `${r}.${a}` as PermissionKey;
export const ALL_PERMISSION_KEYS: PermissionKey[] = (Object.keys(RESOURCES) as Resource[]).flatMap((r) =>
  ACTIONS.map((a) => permKey(r, a)),
);
export const isPermissionKey = (k: string): k is PermissionKey => (ALL_PERMISSION_KEYS as string[]).includes(k);

export const ACCESS_LEVELS = ['owner', 'admin', 'member'] as const;
export const ROLE_TYPES = ['ai', 'human', 'hybrid', 'vacant'] as const;
export const ROLE_TYPE_LABEL = { ai: 'AI Employee', human: 'Human Employee', hybrid: 'Hybrid AI + Human', vacant: 'Vacant Role' } as const;
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const FREQUENCIES = ['daily', 'weekly', 'monthly', 'quarterly', 'ongoing'] as const;
export const REPORTING_FREQUENCIES = ['none', 'daily', 'weekly', 'monthly', 'quarterly'] as const;
export const RULE_KINDS = ['allow', 'deny', 'requires_approval'] as const;
export const SCOPES = ['company', 'department', 'own'] as const;
export const STAGES = ['idea', 'pre_seed', 'seed', 'early_revenue', 'growth', 'established'] as const;
export const STAGE_LABEL = { idea: 'Idea', pre_seed: 'Pre-seed / MVP', seed: 'Seed', early_revenue: 'Early revenue', growth: 'Growth', established: 'Established' } as const;
export const WORKFORCE_MODES = ['ai', 'human', 'hybrid'] as const;

/** Default permission preset for new admins (owner can customise per admin). Deliberately excludes
 *  permissions.configure, finance.* and members.delete: admin != unlimited. */
export const DEFAULT_ADMIN_PERMISSIONS: PermissionKey[] = [
  'company.view', 'company.edit', 'members.view', 'members.create', 'members.edit', 'members.assign',
  'departments.view', 'departments.create', 'departments.edit', 'departments.delete',
  'roles.view', 'roles.create', 'roles.edit', 'roles.delete', 'roles.assign',
  'responsibilities.view', 'responsibilities.create', 'responsibilities.edit', 'responsibilities.delete', 'responsibilities.assign',
  'agents.view', 'agents.create', 'agents.edit', 'agents.assign',
  'tasks.view', 'tasks.create', 'tasks.edit', 'tasks.assign', 'projects.view', 'projects.create', 'projects.edit', 'projects.assign', 'kpis.view', 'kpis.edit', 'reports.view',
  'knowledge.view', 'knowledge.create', 'knowledge.edit', 'decisions.view', 'decisions.create', 'decisions.edit',
  'permissions.view', 'audit.view',
];
export const BASELINE_MEMBER_PERMISSIONS: PermissionKey[] = ['company.view'];

export const AUTONOMY = {
  1: { label: 'Level 1 — Suggest only', help: 'Can read what it is allowed to and recommend. Nothing is applied.' },
  2: { label: 'Level 2 — Draft for review', help: 'Produces drafts that a human reviews. Nothing is applied automatically.' },
  3: { label: 'Level 3 — Execute approved', help: 'Queues actions; they run only after a human approves each one.' },
  4: { label: 'Level 4 — Routine auto-execution', help: 'Runs routine, internal actions you have explicitly pre-authorised; everything else is queued for approval.' },
} as const;
export const KNOWLEDGE_SCOPES = ['none', 'role', 'department', 'company'] as const;
export const EMPLOYEE_STATUSES = ['active', 'on_leave', 'inactive'] as const;

export const TASK_STATUSES = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'awaiting_approval', 'completed', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = { backlog: 'Backlog', todo: 'To Do', in_progress: 'In Progress', blocked: 'Blocked', in_review: 'In Review', awaiting_approval: 'Awaiting Approval', completed: 'Completed', cancelled: 'Cancelled' };
export const OPEN_STATUSES: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'awaiting_approval'];
/** Allowed status moves. Extra rules (dependencies, approval, deliverables, subtasks) are enforced in the service. */
export const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['todo', 'cancelled'],
  todo: ['backlog', 'in_progress', 'blocked', 'cancelled'],
  in_progress: ['todo', 'blocked', 'in_review', 'awaiting_approval', 'completed', 'cancelled'],
  blocked: ['todo', 'in_progress', 'cancelled'],
  in_review: ['in_progress', 'awaiting_approval', 'completed', 'cancelled'],
  awaiting_approval: ['in_progress', 'completed', 'cancelled'],
  completed: ['in_progress'],
  cancelled: ['backlog', 'todo'],
};
export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'] as const;
export const CADENCES = ['daily', 'weekly', 'monthly', 'quarterly'] as const;
export const KPI_SOURCES = {
  manual: 'Manual entry',
  'tasks.completion_rate': 'Tasks: completion rate (% of tasks due in period that are done)',
  'tasks.on_time_rate': 'Tasks: on-time delivery (% of completed tasks finished by their due date)',
  'tasks.overdue_count': 'Tasks: overdue (open tasks past due)',
  'tasks.completed_count': 'Tasks: completed in period',
  'tasks.blocked_count': 'Tasks: currently blocked',
} as const;
export type KpiSource = keyof typeof KPI_SOURCES;
export const KPI_SENSITIVITY = ['standard', 'financial', 'hr'] as const;
export const REPORT_TYPES = ['company', 'department', 'role', 'employee', 'ai_employee', 'task_completion', 'kpi', 'project', 'risk'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_PERIODS = ['daily', 'weekly', 'monthly', 'quarterly', 'custom'] as const;

export const KNOWLEDGE_TYPES = ['business_plan', 'goals', 'strategy', 'sop', 'policy', 'project_doc', 'report', 'decision', 'meeting_notes', 'role_description', 'workflow', 'other'] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];
export const KNOWLEDGE_TYPE_LABEL: Record<KnowledgeType, string> = { business_plan: 'Business plan', goals: 'Company goals', strategy: 'Strategy', sop: 'SOP', policy: 'Policy', project_doc: 'Project documentation', report: 'Report', decision: 'Decision record', meeting_notes: 'Meeting notes', role_description: 'Role description', workflow: 'Workflow documentation', other: 'Other' };
export const KNOWLEDGE_VISIBILITY = ['company', 'department', 'role', 'restricted'] as const;
export const DECISION_STATUSES = ['proposed', 'approved', 'rejected', 'superseded'] as const;
export const HANDOVER_STATUSES = ['in_progress', 'completed', 'cancelled'] as const;
export const HANDOVER_REASONS = ['employee_exit', 'ai_to_human', 'human_to_ai', 'role_reassignment'] as const;
