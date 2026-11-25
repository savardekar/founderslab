import { z } from 'zod';
import { DECISION_STATUSES, KNOWLEDGE_TYPES, KNOWLEDGE_VISIBILITY, CADENCES, PROJECT_STATUSES, REPORT_PERIODS, REPORT_TYPES, TASK_STATUSES, FREQUENCIES, PRIORITIES, REPORTING_FREQUENCIES, ROLE_TYPES, RULE_KINDS, SCOPES, STAGES, WORKFORCE_MODES } from './constants';

const str = (max = 200) => z.string().trim().min(1).max(max);
const opt = (max = 2000) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
const url = z.string().trim().max(500).refine((v) => /^https?:\/\//i.test(v), 'Must start with http:// or https://');
const optUrl = z.union([url, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null));

export const registerInput = z.object({ name: str(100), email: z.string().trim().toLowerCase().email().max(200), password: z.string().max(200) });
export const loginInput = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) });
export const profileInput = z.object({ name: str(100) });
export const changePasswordInput = z.object({ currentPassword: z.string().max(200), newPassword: z.string().max(200) });
export const forgotInput = z.object({ email: z.string().trim().toLowerCase().email() });
export const resetInput = z.object({ token: z.string().min(10).max(200), password: z.string().max(200) });

export const companyFields = {
  name: str(120), industry: opt(120), businessModel: opt(200), productService: opt(500), targetCustomers: opt(500),
  description: opt(2000), website: optUrl, country: opt(100), logoUrl: optUrl,
  stage: z.enum(STAGES), teamSize: z.number().int().min(0).max(100000).nullish().transform((v) => v ?? null),
  budgetRange: opt(100), objectives: z.array(str(300)).max(20),
  workforceMode: z.enum(WORKFORCE_MODES),
};
export const createCompanyInput = z.object({
  ...companyFields,
  orgTemplate: z.string().max(50).nullish(),
  includeNodeKeys: z.array(z.string().max(50)).max(100).nullish(), // org-template nodes to keep (editable before activation)
});
export const updateCompanyInput = z.object(companyFields).partial();

export const responsibilityInput = z.object({
  title: str(200), description: opt(2000), expectedOutcome: opt(1000),
  priority: z.enum(PRIORITIES).default('medium'), frequency: z.enum(FREQUENCIES).default('ongoing'),
  requiresApproval: z.boolean().default(false), ownerRoleId: z.string().uuid().nullish().transform((v) => v ?? null),
});
export const ruleInput = z.object({ kind: z.enum(RULE_KINDS).default('allow'), text: str(500) });
export const kpiInput = z.object({
  name: str(150), description: opt(500), target: opt(100), unit: opt(30),
  period: z.enum(REPORTING_FREQUENCIES).default('monthly'),
  targetValue: z.number().finite().nullish().transform((v) => v ?? null),
  direction: z.enum(['higher', 'lower']).default('higher'),
  dataSource: z.enum(['manual', 'tasks.completion_rate', 'tasks.on_time_rate', 'tasks.overdue_count', 'tasks.completed_count', 'tasks.blocked_count']).default('manual'),
  sensitivity: z.enum(['standard', 'financial', 'hr']).default('standard'),
  reportingFrequency: z.enum(REPORTING_FREQUENCIES).default('monthly'),
});
export const grantInput = z.object({ key: z.string().max(60), scope: z.enum(SCOPES).default('company') });

export const roleFields = {
  name: str(120), description: opt(2000), departmentId: z.string().uuid().nullish().transform((v) => v ?? null),
  reportsToRoleId: z.string().uuid().nullish().transform((v) => v ?? null),
  roleType: z.enum(ROLE_TYPES), status: z.enum(['active', 'inactive']),
  reportingFrequency: z.enum(REPORTING_FREQUENCIES), hasApprovalAuthority: z.boolean(),
  approvalLimit: z.number().min(0).max(1e12).nullish().transform((v) => v ?? null),
};
export const createRoleInput = z.object({
  ...roleFields, status: roleFields.status.default('active'),
  reportingFrequency: roleFields.reportingFrequency.default('weekly'), hasApprovalAuthority: z.boolean().default(false),
  roleType: roleFields.roleType.default('vacant'),
  templateKey: z.string().max(50).nullish(),
  responsibilities: z.array(responsibilityInput).max(50).optional(),
  rules: z.array(ruleInput).max(50).optional(),
  kpis: z.array(kpiInput).max(30).optional(),
  permissions: z.array(grantInput).max(200).optional(),
});
export const updateRoleInput = z.object(roleFields).partial();
export const moveRoleInput = z.object({ reportsToRoleId: z.string().uuid().nullable(), position: z.number().int().min(0).max(10000).optional() });
export const deleteRoleInput = z.object({ childrenTo: z.string().uuid().nullish() }).default({});
export const departmentInput = z.object({ name: str(100), description: opt(500) });
export const inviteInput = z.object({
  email: z.string().trim().toLowerCase().email().max(200), accessLevel: z.enum(['admin', 'member']).default('member'),
  roleId: z.string().uuid().nullish().transform((v) => v ?? null),
  roleIds: z.array(z.string().uuid()).max(10).optional(),
  departmentId: z.string().uuid().nullish().transform((v) => v ?? null),
  managerMembershipId: z.string().uuid().nullish().transform((v) => v ?? null),
  jobTitle: opt(120),
});
export const memberUpdateInput = z.object({ accessLevel: z.enum(['admin', 'member']).optional(), jobTitle: opt(120).optional() });
export const idsInput = z.object({ ids: z.array(z.string().uuid()).max(200) });

export const agentConfigFields = {
  provider: z.string().trim().min(1).max(40), model: z.string().trim().min(1).max(120),
  instructions: z.string().max(8000), autonomyLevel: z.number().int().min(1).max(4),
  knowledgeScope: z.enum(['none', 'role', 'department', 'company']),
  monthlyTokenLimit: z.number().int().min(0).max(2_000_000_000).nullable(),
  monthlyBudgetUsd: z.number().min(0).max(1_000_000).nullable(),
};
export const createAgentInput = z.object({
  name: str(100), description: opt(1000), departmentId: z.string().uuid().nullish().transform((v) => v ?? null),
  managerMembershipId: z.string().uuid().nullish().transform((v) => v ?? null), roleId: z.string().uuid().nullish().transform((v) => v ?? null),
  config: z.object({ ...agentConfigFields, instructions: agentConfigFields.instructions.default(''), autonomyLevel: agentConfigFields.autonomyLevel.default(1), knowledgeScope: agentConfigFields.knowledgeScope.default('role'), monthlyTokenLimit: agentConfigFields.monthlyTokenLimit.default(null), monthlyBudgetUsd: agentConfigFields.monthlyBudgetUsd.default(null) }),
});
export const updateAgentInput = z.object({ name: str(100), description: opt(1000), departmentId: z.string().uuid().nullable(), managerMembershipId: z.string().uuid().nullable() }).partial();
export const agentConfigInput = z.object(agentConfigFields).partial();
export const agentToolsInput = z.object({ tools: z.array(z.object({ toolKey: z.string().max(60), enabled: z.boolean(), requiresApproval: z.boolean() })).max(30) });
export const employeeUpdateInput = z.object({ jobTitle: opt(120), departmentId: z.string().uuid().nullable(), managerMembershipId: z.string().uuid().nullable(), phone: opt(40), bio: opt(1000), status: z.enum(['active', 'on_leave']) }).partial();

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').refine((v) => !Number.isNaN(Date.parse(v)), 'Invalid date');
const optDay = day.nullish().transform((v) => v ?? null);
const uuidN = z.string().uuid().nullish().transform((v) => v ?? null);
const ownerIn = z.object({ membershipId: z.string().uuid().nullish().transform((v) => v ?? null), agentId: z.string().uuid().nullish().transform((v) => v ?? null) });
export const taskCreateInput = z.object({
  title: str(200), description: opt(5000), departmentId: uuidN, roleId: uuidN, responsibilityId: uuidN, projectId: uuidN, parentTaskId: uuidN, owner: ownerIn.optional(),
  priority: z.enum(PRIORITIES).default('medium'), status: z.enum(['backlog', 'todo']).default('todo'), startDate: optDay, dueDate: optDay,
  estimatedHours: z.number().min(0).max(10000).nullish().transform((v) => v ?? null), requiresApproval: z.boolean().default(false),
  deliverables: z.array(str(200)).max(30).default([]), dependsOn: z.array(z.string().uuid()).max(30).default([]),
});
export const taskUpdateInput = z.object({
  title: str(200), description: opt(5000), departmentId: uuidN, roleId: uuidN, responsibilityId: uuidN, projectId: uuidN, priority: z.enum(PRIORITIES), startDate: optDay, dueDate: optDay,
  estimatedHours: z.number().min(0).max(10000).nullable(), actualHours: z.number().min(0).max(10000).nullable(), requiresApproval: z.boolean(),
  deliverables: z.array(z.object({ id: z.string().uuid().optional(), title: str(200), done: z.boolean().default(false) })).max(30),
}).partial();
export const taskStatusInput = z.object({ status: z.enum(TASK_STATUSES), reason: z.string().trim().max(500).nullish(), note: z.string().trim().max(2000).nullish() });
export const taskOwnerInput = ownerIn.refine((o) => !!o.membershipId !== !!o.agentId, 'Provide exactly one of membershipId or agentId');
export const attachmentInput = z.object({ fileName: z.string().trim().min(1).max(200), contentType: z.string().trim().min(3).max(100), dataBase64: z.string().min(1).max(3_000_000) });
export const recurringInput = z.object({ title: str(200), description: opt(5000), departmentId: uuidN, roleId: uuidN, projectId: uuidN, owner: ownerIn.optional(), priority: z.enum(PRIORITIES).default('medium'), cadence: z.enum(CADENCES), dueAfterDays: z.number().int().min(0).max(365).default(0), startOn: optDay, endsOn: optDay, requiresApproval: z.boolean().default(false) });
export const projectInput = z.object({
  name: str(150), description: opt(3000), ownerMembershipId: uuidN, departmentId: uuidN, status: z.enum(PROJECT_STATUSES).default('planning'), startDate: optDay, deadline: optDay,
  goals: z.array(str(300)).max(20).default([]), deliverables: z.array(z.object({ id: z.string().uuid().optional(), title: str(200), done: z.boolean().default(false) })).max(40).default([]),
  team: z.object({ membershipIds: z.array(z.string().uuid()).max(100).default([]), agentIds: z.array(z.string().uuid()).max(50).default([]) }).optional(),
});
export const projectUpdateInput = projectInput.partial();
export const kpiValueInput = z.object({ periodStart: day, periodEnd: day, value: z.number().finite(), note: opt(500) });
export const reportQuery = z.object({
  type: z.enum(REPORT_TYPES), period: z.enum(REPORT_PERIODS).default('monthly'), anchor: optDay, from: optDay, to: optDay,
  departmentId: uuidN, roleId: uuidN, membershipId: uuidN, agentId: uuidN, projectId: uuidN,
});
export const reportGrantInput = z.object({ membershipId: z.string().uuid(), scopeType: z.enum(['department', 'role', 'project', 'employee']), scopeId: z.string().uuid() });

const fileIn = z.object({ fileName: z.string().trim().min(1).max(200), contentType: z.string().trim().min(3).max(100), dataBase64: z.string().min(1).max(3_000_000) });
const grantIn = z.object({ scopeType: z.enum(['member', 'role', 'department', 'agent']), scopeId: z.string().uuid() });
const docFields = {
  title: str(200), docType: z.enum(KNOWLEDGE_TYPES), tags: z.array(z.string().trim().min(1).max(40)).max(20), reviewDate: optDay,
  departmentId: uuidN, roleId: uuidN, projectId: uuidN, responsibilityId: uuidN,
  body: z.string().max(400_000), file: fileIn.nullish().transform((v) => v ?? null), changeNote: opt(300),
};
export const docCreateInput = z.object({ ...docFields, docType: docFields.docType.default('other'), tags: docFields.tags.default([]), body: docFields.body.default(''), visibility: z.enum(KNOWLEDGE_VISIBILITY).default('company'), confidential: z.boolean().default(false), status: z.enum(['draft', 'published']).default('published'), access: z.array(grantIn).max(50).default([]) });
export const docUpdateInput = z.object(docFields).partial();
export const docSecurityInput = z.object({ visibility: z.enum(KNOWLEDGE_VISIBILITY), confidential: z.boolean(), departmentId: uuidN, roleId: uuidN }).partial();
export const docAccessInput = z.object({ grants: z.array(grantIn).max(100) });
export const decisionInput = z.object({
  title: str(200), description: z.string().trim().max(10000).default(''), reason: opt(5000), alternatives: z.array(z.object({ option: str(300), reason: z.string().trim().max(1000).optional() })).max(20).default([]),
  expectedOutcome: opt(3000), relatedRoleId: uuidN, relatedProjectId: uuidN, reviewDate: optDay, decidedOn: optDay, decisionMakerMembershipId: uuidN, confidential: z.boolean().default(false), approve: z.boolean().default(false),
});
export const decisionPatchInput = decisionInput.omit({ approve: true }).partial();
export const targetInput = z.object({ membershipId: z.string().uuid().nullish().transform((v) => v ?? null), agentId: z.string().uuid().nullish().transform((v) => v ?? null), manager: z.boolean().optional() });
export const exitInput = z.object({
  effectiveDate: optDay, notes: opt(3000), taskPolicy: z.enum(['with_role', 'default', 'none']).default('with_role'), defaultTo: targetInput.nullish().transform((v) => v ?? null), approverMembershipId: uuidN,
  roleAssignments: z.array(z.object({ roleId: z.string().uuid(), to: targetInput })).max(100).default([]),
});
export const aiToHumanInput = z.object({ agentId: z.string().uuid(), toMembershipId: z.string().uuid(), roleIds: z.array(z.string().uuid()).max(100).optional(), keepAsAssistant: z.boolean().default(true), assistantAutonomy: z.number().int().min(1).max(4).default(2), transferTasks: z.boolean().default(true), effectiveDate: optDay, notes: opt(3000) });
export const transferRoleInput = z.object({ to: targetInput, previous: z.enum(['remove', 'keep']).default('remove'), transferTasks: z.boolean().default(true), approverMembershipId: uuidN, notes: opt(3000) });
void DECISION_STATUSES;
