import type { PermissionKey, Resource, Action } from './constants';
import { ACTIONS } from './constants';

type Resp = { title: string; description: string; expectedOutcome: string; priority?: 'low' | 'medium' | 'high' | 'critical'; frequency?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'ongoing'; requiresApproval?: boolean };
type Kpi = { name: string; description?: string; target?: string; unit?: string; period?: 'daily' | 'weekly' | 'monthly' | 'quarterly'; dataSource?: string; direction?: 'higher' | 'lower'; sensitivity?: 'standard' | 'financial' | 'hr' };
type Rule = { kind: 'allow' | 'deny' | 'requires_approval'; text: string };

export type RoleTemplate = {
  key: string; name: string; department: string; description: string;
  reportingFrequency: 'daily' | 'weekly' | 'monthly' | 'quarterly';
  hasApprovalAuthority: boolean;
  responsibilities: Resp[]; rules: Rule[]; kpis: Kpi[];
  permissions: string[];
};

const p = (r: Resource, ...a: Action[]) => a.map((x) => `${r}.${x}` as PermissionKey);
/** permission with an explicit scope: 'department' = own department, 'own' = own role (for reports: own role + the roles below it) */
const ps = (scope: 'department' | 'own', r: Resource, ...a: Action[]) => a.map((x) => `${r}.${x}:${scope}`);
const READ_ONLY = [...p('company', 'view')];
const FULL = (r: Resource) => p(r, ...ACTIONS);

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    key: 'ceo', name: 'CEO', department: 'Executive', reportingFrequency: 'weekly', hasApprovalAuthority: true,
    description: 'Sets company vision and strategy, leads the executive team and is accountable for overall results.',
    responsibilities: [
      { title: 'Define company vision and strategy', description: 'Set long-term direction and translate it into annual goals.', expectedOutcome: 'Documented strategy and quarterly goals reviewed every quarter', priority: 'critical', frequency: 'quarterly' },
      { title: 'Lead the executive team', description: 'Align department heads on priorities and remove blockers.', expectedOutcome: 'Weekly leadership sync held; blockers resolved within a week', priority: 'high', frequency: 'weekly' },
      { title: 'Own fundraising and investor relations', description: 'Plan funding needs and maintain investor communication.', expectedOutcome: 'Funding plan and monthly investor update', priority: 'high', frequency: 'monthly', requiresApproval: true },
      { title: 'Approve major decisions and budgets', description: 'Final approval on hires, spend and partnerships above delegated limits.', expectedOutcome: 'Decisions logged with rationale', priority: 'high', frequency: 'ongoing' },
    ],
    rules: [{ kind: 'allow', text: 'Can view all department configuration and approve any request.' }, { kind: 'requires_approval', text: 'Legal commitments require recorded rationale.' }],
    kpis: [{ name: 'Revenue vs plan', unit: '%', period: 'monthly', target: '100', sensitivity: 'financial' }, { name: 'Cash runway', unit: 'months', period: 'monthly', sensitivity: 'financial' }],
    permissions: [...FULL('company'), ...FULL('members'), ...FULL('departments'), ...FULL('roles'), ...FULL('responsibilities'), ...p('permissions', 'view'), ...p('audit', 'view'), ...p('reports', 'view', 'export'), ...p('kpis', 'view'), ...p('tasks', 'view', 'create', 'edit', 'assign', 'approve')],
  },
  {
    key: 'coo', name: 'COO', department: 'Operations', reportingFrequency: 'weekly', hasApprovalAuthority: true,
    description: 'Runs day-to-day operations, coordinates departments and keeps work moving on time.',
    responsibilities: [
      { title: 'Manage daily operations', description: 'Oversee day-to-day execution across departments.', expectedOutcome: 'Operations run without unresolved blockers beyond 48 hours', priority: 'critical', frequency: 'daily' },
      { title: 'Coordinate departments', description: 'Align cross-department dependencies and handoffs.', expectedOutcome: 'Weekly cross-department sync with documented actions', priority: 'high', frequency: 'weekly' },
      { title: 'Track tasks and deadlines', description: 'Monitor task progress and escalate slippage.', expectedOutcome: 'Overdue work visible and escalated the same day', priority: 'high', frequency: 'daily' },
      { title: 'Maintain SOPs', description: 'Keep standard operating procedures current.', expectedOutcome: 'Every recurring process has a current SOP', priority: 'medium', frequency: 'monthly' },
      { title: 'Prepare weekly operations report', description: 'Summarise progress, risks and efficiency.', expectedOutcome: 'Report delivered to the founder every week', priority: 'medium', frequency: 'weekly' },
      { title: 'Escalate operational risks', description: 'Flag risks that threaten delivery or cost.', expectedOutcome: 'Risks logged with owner and mitigation', priority: 'high', frequency: 'ongoing' },
    ],
    rules: [
      { kind: 'allow', text: 'Can create operational tasks and assign them within authorised departments.' },
      { kind: 'allow', text: 'Can view operational reports.' },
      { kind: 'deny', text: 'Cannot approve financial transactions unless separately authorised.' },
      { kind: 'deny', text: 'Cannot modify company-wide security settings.' },
    ],
    kpis: [{ name: 'Task completion rate', unit: '%', target: '90', period: 'weekly', dataSource: 'tasks.completion_rate' }, { name: 'On-time delivery', unit: '%', target: '90', period: 'monthly', dataSource: 'tasks.on_time_rate' }, { name: 'Blocked tasks', unit: 'count', target: '0', period: 'weekly', dataSource: 'tasks.blocked_count', direction: 'lower' }],
    permissions: [...READ_ONLY, ...p('departments', 'view'), ...p('roles', 'view'), ...p('responsibilities', 'view', 'edit'), ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('projects', 'view', 'create', 'edit', 'assign'), ...p('reports', 'view', 'export'), ...p('kpis', 'view')],
  },
  {
    key: 'cmo', name: 'CMO', department: 'Marketing', reportingFrequency: 'weekly', hasApprovalAuthority: true,
    description: 'Owns marketing strategy, brand and demand generation.',
    responsibilities: [
      { title: 'Own marketing strategy', description: 'Define positioning, channels and quarterly campaign plan.', expectedOutcome: 'Approved marketing plan with budget per channel', priority: 'high', frequency: 'quarterly' },
      { title: 'Generate qualified leads', description: 'Run campaigns that fill the sales pipeline.', expectedOutcome: 'Monthly lead and MQL targets met', priority: 'critical', frequency: 'monthly' },
      { title: 'Analyse campaign performance', description: 'Review channel results and reallocate spend.', expectedOutcome: 'Weekly performance review with recommended changes', priority: 'medium', frequency: 'weekly' },
      { title: 'Manage brand and content', description: 'Keep messaging consistent across channels.', expectedOutcome: 'Content calendar published and followed', priority: 'medium', frequency: 'weekly' },
      { title: 'Manage approved marketing budget', description: 'Spend within approved limits.', expectedOutcome: 'Budget variance under 10%', priority: 'high', frequency: 'monthly', requiresApproval: true },
    ],
    rules: [
      { kind: 'allow', text: 'Can manage marketing tasks and view campaign reports.' },
      { kind: 'requires_approval', text: 'Publishing external campaigns above the approved budget needs approval.' },
      { kind: 'deny', text: 'Cannot access confidential financial records unless granted.' },
    ],
    kpis: [{ name: 'Leads generated', unit: 'count', period: 'monthly' }, { name: 'Customer acquisition cost', unit: 'currency', period: 'monthly', direction: 'lower' }, { name: 'Conversion rate', unit: '%', period: 'monthly' }],
    permissions: [...READ_ONLY, ...p('roles', 'view'), ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('projects', 'view', 'create', 'edit'), ...p('reports', 'view', 'export'), ...p('kpis', 'view')],
  },
  {
    key: 'cfo', name: 'CFO', department: 'Finance', reportingFrequency: 'monthly', hasApprovalAuthority: true,
    description: 'Owns financial planning, reporting, budgets and cash management.',
    responsibilities: [
      { title: 'Maintain financial records and reporting', description: 'Keep books accurate and produce monthly statements.', expectedOutcome: 'Monthly financial report delivered by the 5th', priority: 'critical', frequency: 'monthly' },
      { title: 'Manage budgets', description: 'Set department budgets and track variance.', expectedOutcome: 'Budget vs actual reviewed monthly', priority: 'high', frequency: 'monthly' },
      { title: 'Monitor cash flow and runway', description: 'Forecast cash and flag shortfalls early.', expectedOutcome: 'Rolling 12-month cash forecast', priority: 'critical', frequency: 'weekly' },
      { title: 'Approve expenses within limits', description: 'Review and approve spend requests.', expectedOutcome: 'Requests handled within 2 business days', priority: 'medium', frequency: 'ongoing', requiresApproval: true },
      { title: 'Ensure tax and compliance filings', description: 'Track statutory deadlines and filings.', expectedOutcome: 'No missed filing deadlines', priority: 'high', frequency: 'quarterly' },
    ],
    rules: [
      { kind: 'allow', text: 'Can access authorised financial reports and manage finance workflows.' },
      { kind: 'requires_approval', text: 'Expenses above the configured approval limit need the founder.' },
      { kind: 'deny', text: 'Cannot change system security settings unless separately authorised.' },
    ],
    kpis: [{ name: 'Cash runway', unit: 'months', period: 'monthly', sensitivity: 'financial' }, { name: 'Budget variance', unit: '%', period: 'monthly', sensitivity: 'financial', direction: 'lower' }, { name: 'Report accuracy', unit: '%', period: 'monthly', sensitivity: 'financial' }],
    permissions: [...READ_ONLY, ...p('roles', 'view'), ...FULL('finance'), ...p('reports', 'view', 'export'), ...p('kpis', 'view'), ...p('tasks', 'view', 'create', 'edit')],
  },
  {
    key: 'cto', name: 'CTO', department: 'Technology', reportingFrequency: 'weekly', hasApprovalAuthority: true,
    description: 'Owns technology strategy, architecture, delivery and system reliability.',
    responsibilities: [
      { title: 'Define technology strategy and architecture', description: 'Choose stack, standards and architecture direction.', expectedOutcome: 'Documented architecture and technical roadmap', priority: 'high', frequency: 'quarterly' },
      { title: 'Deliver product releases', description: 'Plan and ship releases with quality.', expectedOutcome: 'Releases shipped on the agreed cadence', priority: 'critical', frequency: 'weekly' },
      { title: 'Ensure reliability and security', description: 'Monitor uptime, incidents and security posture.', expectedOutcome: 'Incidents triaged within SLA with postmortems', priority: 'high', frequency: 'ongoing' },
      { title: 'Manage engineering team', description: 'Hire, mentor and plan capacity.', expectedOutcome: 'Team capacity plan updated monthly', priority: 'medium', frequency: 'monthly' },
    ],
    rules: [{ kind: 'allow', text: 'Can manage engineering tasks and technical documentation.' }, { kind: 'requires_approval', text: 'Production-impacting changes follow the release approval process.' }],
    kpis: [{ name: 'Release completion', unit: '%', period: 'monthly' }, { name: 'Bug resolution time', unit: 'days', period: 'monthly', direction: 'lower' }, { name: 'System uptime', unit: '%', target: '99.9', period: 'monthly' }],
    permissions: [...READ_ONLY, ...p('roles', 'view'), ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('projects', 'view', 'create', 'edit'), ...p('reports', 'view'), ...p('kpis', 'view'), ...p('knowledge', 'view', 'create', 'edit')],
  },
  {
    key: 'cro', name: 'CRO', department: 'Sales', reportingFrequency: 'weekly', hasApprovalAuthority: true,
    description: 'Owns revenue: sales, partnerships and customer success.',
    responsibilities: [
      { title: 'Own revenue targets', description: 'Set and track revenue goals by segment.', expectedOutcome: 'Quarterly revenue plan with weekly tracking', priority: 'critical', frequency: 'weekly' },
      { title: 'Manage sales pipeline', description: 'Keep pipeline accurate and forecast reliable.', expectedOutcome: 'Weekly pipeline review and forecast', priority: 'high', frequency: 'weekly' },
      { title: 'Build partnerships', description: 'Identify and close channel partnerships.', expectedOutcome: 'Partnership pipeline reviewed monthly', priority: 'medium', frequency: 'monthly', requiresApproval: true },
      { title: 'Oversee customer retention', description: 'Monitor churn and expansion.', expectedOutcome: 'Retention report monthly', priority: 'medium', frequency: 'monthly' },
    ],
    rules: [{ kind: 'requires_approval', text: 'Discounts beyond policy and contract terms need approval.' }],
    kpis: [{ name: 'Revenue', unit: 'currency', period: 'monthly', sensitivity: 'financial' }, { name: 'Win rate', unit: '%', period: 'monthly' }, { name: 'Churn', unit: '%', period: 'monthly' }],
    permissions: [...READ_ONLY, ...p('roles', 'view'), ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('reports', 'view', 'export'), ...p('kpis', 'view')],
  },
  {
    key: 'chro', name: 'CHRO', department: 'People', reportingFrequency: 'monthly', hasApprovalAuthority: false,
    description: 'Owns hiring, onboarding, culture and employee lifecycle.',
    responsibilities: [
      { title: 'Run hiring and recruitment', description: 'Define hiring plan and manage the pipeline.', expectedOutcome: 'Open roles filled within target time', priority: 'high', frequency: 'ongoing' },
      { title: 'Manage onboarding and exits', description: 'Ensure smooth joining and offboarding with handover.', expectedOutcome: 'Checklist completed for every joiner and leaver', priority: 'high', frequency: 'ongoing' },
      { title: 'Maintain HR policies', description: 'Keep policies current and communicated.', expectedOutcome: 'Policies reviewed twice a year', priority: 'medium', frequency: 'quarterly' },
      { title: 'Track team engagement', description: 'Run pulse surveys and act on results.', expectedOutcome: 'Quarterly engagement report', priority: 'medium', frequency: 'quarterly' },
    ],
    rules: [{ kind: 'deny', text: 'Cannot access salary data of the founder or executives unless granted.' }],
    kpis: [{ name: 'Time to hire', unit: 'days', period: 'monthly', direction: 'lower', sensitivity: 'hr' }, { name: 'Employee turnover', unit: '%', period: 'quarterly', direction: 'lower', sensitivity: 'hr' }],
    permissions: [...READ_ONLY, ...p('members', 'view', 'create', 'edit', 'assign'), ...p('roles', 'view'), ...p('departments', 'view'), ...p('tasks', 'view', 'create', 'assign')],
  },
  {
    key: 'marketing_manager', name: 'Marketing Manager', department: 'Marketing', reportingFrequency: 'weekly', hasApprovalAuthority: false,
    description: 'Plans and executes marketing campaigns and manages the marketing team.',
    responsibilities: [
      { title: 'Plan and run campaigns', description: 'Execute the approved campaign calendar.', expectedOutcome: 'Campaigns launched on schedule', priority: 'high', frequency: 'weekly' },
      { title: 'Manage content and social channels', description: 'Coordinate content production and posting.', expectedOutcome: 'Content calendar fulfilled', priority: 'medium', frequency: 'weekly' },
      { title: 'Report campaign results', description: 'Compile performance reports for the CMO.', expectedOutcome: 'Weekly marketing report', priority: 'medium', frequency: 'weekly' },
    ],
    rules: [{ kind: 'requires_approval', text: 'External publishing outside the approved calendar needs CMO approval.' }],
    kpis: [{ name: 'Campaign ROI', unit: '%', period: 'monthly' }, { name: 'Leads generated', unit: 'count', period: 'monthly' }],
    permissions: [...READ_ONLY, ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('reports', 'view'), ...p('kpis', 'view')],
  },
  {
    key: 'operations_manager', name: 'Operations Manager', department: 'Operations', reportingFrequency: 'weekly', hasApprovalAuthority: false,
    description: 'Runs operational processes and coordinates the operations team.',
    responsibilities: [
      { title: 'Execute daily operations', description: 'Run recurring operational processes.', expectedOutcome: 'Processes completed on time', priority: 'high', frequency: 'daily' },
      { title: 'Manage vendors and suppliers', description: 'Maintain vendor relationships and SLAs.', expectedOutcome: 'Vendor SLAs reviewed quarterly', priority: 'medium', frequency: 'quarterly' },
      { title: 'Improve processes', description: 'Find and remove operational inefficiencies.', expectedOutcome: 'At least one documented improvement per month', priority: 'medium', frequency: 'monthly' },
    ],
    rules: [{ kind: 'allow', text: 'Can create and assign tasks within the Operations department.' }],
    kpis: [{ name: 'Process completion rate', unit: '%', period: 'weekly' }, { name: 'Operational efficiency', unit: '%', period: 'monthly' }],
    permissions: [...READ_ONLY, ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('reports', 'view'), ...p('kpis', 'view')],
  },
  {
    key: 'sales_manager', name: 'Sales Manager', department: 'Sales', reportingFrequency: 'weekly', hasApprovalAuthority: false,
    description: 'Leads the sales team and owns pipeline execution.',
    responsibilities: [
      { title: 'Manage the sales team and pipeline', description: 'Coach reps and inspect the pipeline.', expectedOutcome: 'Weekly pipeline review completed', priority: 'high', frequency: 'weekly' },
      { title: 'Meet sales targets', description: 'Deliver the monthly quota.', expectedOutcome: 'Monthly quota achieved', priority: 'critical', frequency: 'monthly' },
      { title: 'Maintain CRM hygiene', description: 'Ensure accurate deal data.', expectedOutcome: 'All active deals updated weekly', priority: 'medium', frequency: 'weekly' },
    ],
    rules: [{ kind: 'requires_approval', text: 'Discounts above policy need CRO/founder approval.' }],
    kpis: [{ name: 'Quota attainment', unit: '%', period: 'monthly' }, { name: 'Win rate', unit: '%', period: 'monthly' }],
    permissions: [...READ_ONLY, ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('reports', 'view'), ...p('kpis', 'view')],
  },
  {
    key: 'product_manager', name: 'Product Manager', department: 'Product', reportingFrequency: 'weekly', hasApprovalAuthority: false,
    description: 'Owns product discovery, roadmap and delivery alignment.',
    responsibilities: [
      { title: 'Own the product roadmap', description: 'Prioritise based on customer value and strategy.', expectedOutcome: 'Roadmap reviewed monthly', priority: 'high', frequency: 'monthly' },
      { title: 'Gather and synthesise customer feedback', description: 'Run interviews and analyse feedback.', expectedOutcome: 'Insights summary every sprint', priority: 'medium', frequency: 'weekly' },
      { title: 'Write requirements and accept work', description: 'Define scope and sign off deliverables.', expectedOutcome: 'Every release has accepted requirements', priority: 'high', frequency: 'ongoing' },
    ],
    rules: [{ kind: 'allow', text: 'Can create product tasks and projects.' }],
    kpis: [{ name: 'Feature adoption', unit: '%', period: 'monthly' }, { name: 'Roadmap delivery', unit: '%', period: 'quarterly' }],
    permissions: [...READ_ONLY, ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('projects', 'view', 'create', 'edit'), ...p('knowledge', 'view', 'create', 'edit')],
  },
  {
    key: 'project_manager', name: 'Project Manager', department: 'Operations', reportingFrequency: 'weekly', hasApprovalAuthority: false,
    description: 'Plans, schedules and tracks projects to completion.',
    responsibilities: [
      { title: 'Plan and schedule projects', description: 'Break work into milestones and owners.', expectedOutcome: 'Approved plan for every project', priority: 'high', frequency: 'ongoing' },
      { title: 'Track progress and risks', description: 'Monitor status, dependencies and risks.', expectedOutcome: 'Weekly status report', priority: 'high', frequency: 'weekly' },
      { title: 'Coordinate stakeholders', description: 'Keep stakeholders informed and aligned.', expectedOutcome: 'No surprises at delivery', priority: 'medium', frequency: 'weekly' },
    ],
    rules: [{ kind: 'allow', text: 'Can create and assign tasks within assigned projects.' }],
    kpis: [{ name: 'On-time project delivery', unit: '%', period: 'quarterly', dataSource: 'tasks.on_time_rate' }, { name: 'Scope change rate', unit: '%', period: 'quarterly' }],
    permissions: [...READ_ONLY, ...p('tasks', 'view', 'create', 'edit', 'assign'), ...p('projects', 'view', 'create', 'edit', 'assign'), ...p('reports', 'view')],
  },
];
/** Least-privilege scopes: executives see their own department, managers their own team. Hierarchy alone grants nothing. */
const SCOPE_RULES: Record<string, { dept: string[]; own: string[] }> = {
  coo: { dept: ['reports', 'kpis'], own: [] },
  cmo: { dept: ['reports', 'kpis', 'tasks', 'projects'], own: [] }, cfo: { dept: ['reports', 'kpis', 'tasks', 'projects'], own: [] },
  cto: { dept: ['reports', 'kpis', 'tasks', 'projects'], own: [] }, cro: { dept: ['reports', 'kpis', 'tasks', 'projects'], own: [] }, chro: { dept: ['reports', 'kpis', 'tasks', 'projects'], own: [] },
  marketing_manager: { dept: ['tasks', 'projects'], own: ['reports', 'kpis'] }, operations_manager: { dept: ['tasks', 'projects'], own: ['reports', 'kpis'] },
  sales_manager: { dept: ['tasks', 'projects'], own: ['reports', 'kpis'] }, product_manager: { dept: ['tasks', 'projects'], own: ['reports', 'kpis'] }, project_manager: { dept: ['tasks', 'projects'], own: ['reports', 'kpis'] },
};
for (const t of ROLE_TEMPLATES) {
  const r = SCOPE_RULES[t.key]; if (!r) continue;
  t.permissions = t.permissions.map((k) => { const res = k.split('.')[0]; return r.dept.includes(res) ? `${k}:department` : r.own.includes(res) ? `${k}:own` : k; });
}
/** "reports.view:department" → { key, scope } */
export const parsePermission = (k: string) => { const [key, scope] = k.split(':'); return { key, scope: (scope ?? 'company') as 'company' | 'department' | 'own' }; };

export const ROLE_TEMPLATE_BY_KEY = Object.fromEntries(ROLE_TEMPLATES.map((t) => [t.key, t]));

export type OrgNode = { key: string; templateKey?: string; name?: string; department?: string; parent: string | null; roleType?: 'ai' | 'human' | 'hybrid' | 'vacant' };
export type OrgTemplate = { key: string; name: string; description: string; nodes: OrgNode[] };

export const ORG_TEMPLATES: OrgTemplate[] = [
  { key: 'solo', name: 'Solo Founder Startup', description: 'You plus the four roles that matter first.', nodes: [
    { key: 'coo', templateKey: 'coo', parent: null }, { key: 'cmo', templateKey: 'cmo', parent: null },
    { key: 'cfo', templateKey: 'cfo', parent: null }, { key: 'cto', templateKey: 'cto', parent: null } ] },
  { key: 'saas', name: 'SaaS Startup', description: 'Product, engineering, growth and customer success.', nodes: [
    { key: 'cto', templateKey: 'cto', parent: null }, { key: 'pm', templateKey: 'product_manager', parent: 'cto' },
    { key: 'eng', name: 'Engineering Manager', department: 'Technology', parent: 'cto' },
    { key: 'cmo', templateKey: 'cmo', parent: null }, { key: 'cro', templateKey: 'cro', parent: null },
    { key: 'support', name: 'Customer Support Manager', department: 'Customer Success', parent: 'cro' },
    { key: 'cfo', templateKey: 'cfo', parent: null }, { key: 'coo', templateKey: 'coo', parent: null } ] },
  { key: 'ecommerce', name: 'E-commerce Startup', description: 'Merchandising, marketing, fulfilment and finance.', nodes: [
    { key: 'coo', templateKey: 'coo', parent: null }, { key: 'ops', templateKey: 'operations_manager', parent: 'coo' },
    { key: 'vendor', name: 'Vendor Manager', department: 'Operations', parent: 'coo' },
    { key: 'support', name: 'Customer Support Manager', department: 'Customer Success', parent: 'coo' },
    { key: 'cmo', templateKey: 'cmo', parent: null }, { key: 'mm', templateKey: 'marketing_manager', parent: 'cmo' },
    { key: 'cfo', templateKey: 'cfo', parent: null } ] },
  { key: 'service', name: 'Service Business', description: 'Delivery-led structure with sales and operations.', nodes: [
    { key: 'coo', templateKey: 'coo', parent: null }, { key: 'pjm', templateKey: 'project_manager', parent: 'coo' },
    { key: 'cro', templateKey: 'cro', parent: null }, { key: 'sm', templateKey: 'sales_manager', parent: 'cro' },
    { key: 'cfo', templateKey: 'cfo', parent: null } ] },
  { key: 'agency', name: 'Marketing Agency', description: 'Client delivery, creative and account management.', nodes: [
    { key: 'coo', templateKey: 'coo', parent: null }, { key: 'pjm', templateKey: 'project_manager', parent: 'coo' },
    { key: 'cmo', templateKey: 'cmo', parent: null }, { key: 'mm', templateKey: 'marketing_manager', parent: 'cmo' },
    { key: 'content', name: 'Content Manager', department: 'Marketing', parent: 'cmo' },
    { key: 'sm', templateKey: 'sales_manager', parent: null }, { key: 'cfo', templateKey: 'cfo', parent: null } ] },
  { key: 'tech', name: 'Technology Startup', description: 'Engineering-heavy team with product and operations.', nodes: [
    { key: 'cto', templateKey: 'cto', parent: null }, { key: 'eng', name: 'Engineering Manager', department: 'Technology', parent: 'cto' },
    { key: 'dev', name: 'Developer', department: 'Technology', parent: 'eng' },
    { key: 'pm', templateKey: 'product_manager', parent: null }, { key: 'coo', templateKey: 'coo', parent: null },
    { key: 'cfo', templateKey: 'cfo', parent: null } ] },
  { key: 'custom', name: 'Custom Organization', description: 'Start empty and design your own structure.', nodes: [] },
];
export const ORG_TEMPLATE_BY_KEY = Object.fromEntries(ORG_TEMPLATES.map((t) => [t.key, t]));

/** Role definition used for custom (non-template) nodes: still gets sane starter content. */
export const GENERIC_ROLE_PERMISSIONS: PermissionKey[] = [...READ_ONLY, ...p('tasks', 'view')];

/** Starter responsibilities for org-template nodes that have no full role template. */
export const NODE_STARTERS: Record<string, { title: string; expectedOutcome: string }[]> = {
  'Engineering Manager': [
    { title: 'Plan and deliver engineering work', expectedOutcome: 'Sprint goals met each cycle' },
    { title: 'Maintain code quality and reviews', expectedOutcome: 'All changes reviewed before release' },
    { title: 'Manage and mentor engineers', expectedOutcome: 'Regular 1:1s and growth plans' },
  ],
  Developer: [
    { title: 'Build and ship assigned features', expectedOutcome: 'Features delivered to the agreed quality' },
    { title: 'Fix bugs and maintain tests', expectedOutcome: 'Bugs resolved within target time' },
  ],
  'Customer Support Manager': [
    { title: 'Handle customer issues and tickets', expectedOutcome: 'First response within SLA' },
    { title: 'Maintain support knowledge and FAQs', expectedOutcome: 'Top issues documented' },
    { title: 'Report customer feedback and trends', expectedOutcome: 'Monthly support insights report' },
  ],
  'Vendor Manager': [
    { title: 'Source and onboard vendors', expectedOutcome: 'Approved vendor list maintained' },
    { title: 'Track vendor performance and contracts', expectedOutcome: 'Vendor reviews each quarter' },
  ],
  'Content Manager': [
    { title: 'Plan and publish content', expectedOutcome: 'Content calendar delivered on time' },
    { title: 'Edit and quality-check content', expectedOutcome: 'No unreviewed content published' },
  ],
};
