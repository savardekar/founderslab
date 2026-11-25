import { ZodError, type ZodTypeAny, z } from 'zod';
import { getDb, type Db } from '@/db/client';
import { HttpError, badRequest, notFound, unauthorized } from '@/lib/errors';
import * as V from '@/lib/validators';
import { ORG_TEMPLATES, ROLE_TEMPLATES } from '@/lib/templates';
import { Ctx, loadCtx, type SessionUser } from './authz';
import { audit } from './audit';
import * as Auth from './services/auth';
import * as Co from './services/companies';
import * as Dept from './services/departments';
import * as Det from './services/details';
import * as Acc from './services/access';
import * as Mem from './services/members';
import * as Roles from './services/roles';
import * as Agents from './services/agents';
import * as Emp from './services/employees';
import * as WF from './services/workforce';
import { runAgent } from './ai/runner';
import * as Tasks from './services/tasks';
import * as Proj from './services/projects';
import * as Kpis from './services/kpis';
import * as Rep from './services/reports';
import * as Notif from './services/notifications';
import { renderCsv, renderPdf } from './services/export';
import * as Know from './services/knowledge';
import * as Dec from './services/decisions';
import * as Onb from './services/onboarding';
import * as HO from './services/handover';

type R = { db: Db; req: Request; params: Record<string, string>; query: URLSearchParams; body: unknown; user: SessionUser; ctx: Ctx; token: string | null; ip: string; cookies: string[]; status?: number };
type Handler = (r: R) => Promise<unknown> | unknown;
type Route = { method: string; re: RegExp; keys: string[]; auth: 'none' | 'user' | 'company'; handler: Handler };
const routes: Route[] = [];
const def = (method: string, pattern: string, auth: Route['auth'], handler: Handler) => {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, auth, handler });
};
const parse = <T extends ZodTypeAny>(schema: T, body: unknown): z.infer<T> => schema.parse(body ?? {});
const company = (m: string, p: string, h: Handler) => def(m, `/companies/:companyId${p}`, 'company', h);

const cookieHeader = (token: string, maxAge: number) =>
  `${Auth.SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`;
const getCookie = (req: Request, name: string) => req.headers.get('cookie')?.split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1] ?? null;

// ───────────── auth ─────────────
def('POST', '/auth/register', 'none', async (r) => { const { user, token } = await Auth.register(r.db, parse(V.registerInput, r.body), r.req.headers.get('user-agent') ?? undefined); r.cookies.push(cookieHeader(token, 30 * 86400)); r.status = 201; return { user }; });
def('POST', '/auth/login', 'none', async (r) => { const { user, token } = await Auth.login(r.db, parse(V.loginInput, r.body), r.ip, r.req.headers.get('user-agent') ?? undefined); r.cookies.push(cookieHeader(token, 30 * 86400)); return { user }; });
def('POST', '/auth/logout', 'none', async (r) => { await Auth.logout(r.db, r.token); r.cookies.push(cookieHeader('', 0)); return { ok: true }; });
def('GET', '/auth/me', 'none', async (r) => ({ user: await Auth.sessionUser(r.db, r.token) }));
def('PATCH', '/auth/me', 'user', async (r) => ({ user: await Auth.updateProfile(r.db, r.user.id, parse(V.profileInput, r.body)) }));
def('POST', '/auth/change-password', 'user', async (r) => { await Auth.changePassword(r.db, r.user.id, r.token, parse(V.changePasswordInput, r.body)); return { ok: true }; });
def('POST', '/auth/forgot-password', 'none', async (r) => ({ ok: true, ...(await Auth.forgotPassword(r.db, parse(V.forgotInput, r.body).email, r.ip)) }));
def('POST', '/auth/reset-password', 'none', async (r) => { await Auth.resetPassword(r.db, parse(V.resetInput, r.body)); return { ok: true }; });

// ───────────── global ─────────────
def('GET', '/templates', 'user', () => ({ roleTemplates: ROLE_TEMPLATES, orgTemplates: ORG_TEMPLATES, permissionCatalog: Acc.catalog() }));
def('GET', '/companies', 'user', async (r) => ({ companies: await Co.listMyCompanies(r.db, r.user.id) }));
def('POST', '/companies', 'user', async (r) => { r.status = 201; return Co.createCompany(r.db, r.user, parse(V.createCompanyInput, r.body)); });
def('POST', '/invites/accept', 'user', async (r) => Mem.acceptInvite(r.db, r.user, parse(z.object({ token: z.string().min(10).max(200) }), r.body).token));

// ───────────── company ─────────────
company('GET', '', (r) => Co.getCompany(r.ctx));
company('PATCH', '', async (r) => ({ company: await Co.updateCompany(r.ctx, parse(V.updateCompanyInput, r.body)) }));
company('GET', '/dashboard', (r) => Co.dashboard(r.ctx));
company('GET', '/audit', async (r) => ({ events: await Co.listAudit(r.ctx, Number(r.query.get('limit') ?? 100) || 100, r.query.get('before') ?? undefined) }));
company('POST', '/apply-org-template', (r) => { const b = parse(z.object({ templateKey: z.string().max(50), includeNodeKeys: z.array(z.string()).nullish() }), r.body); return Co.applyOrgTemplate(r.ctx, b.templateKey, b.includeNodeKeys); });
company('GET', '/my-roles', async (r) => ({ roles: await Mem.myRoles(r.ctx) }));

company('GET', '/departments', async (r) => ({ departments: await Dept.listDepartments(r.ctx) }));
company('POST', '/departments', async (r) => { r.status = 201; return { department: await Dept.createDepartment(r.ctx, parse(V.departmentInput, r.body)) }; });
company('PATCH', '/departments/:id', async (r) => ({ department: await Dept.updateDepartment(r.ctx, r.params.id, parse(V.departmentInput, r.body)) }));
company('DELETE', '/departments/:id', (r) => Dept.deleteDepartment(r.ctx, r.params.id));

company('GET', '/org-tree', (r) => Roles.orgTree(r.ctx));
company('GET', '/roles', async (r) => ({ roles: await Roles.listRoles(r.ctx) }));
company('POST', '/roles', async (r) => { r.status = 201; return { role: await Roles.createRole(r.ctx, parse(V.createRoleInput, r.body)) }; });
company('GET', '/roles/:id', (r) => Roles.roleDetail(r.ctx, r.params.id));
company('PATCH', '/roles/:id', async (r) => ({ role: await Roles.updateRole(r.ctx, r.params.id, parse(V.updateRoleInput, r.body)) }));
company('DELETE', '/roles/:id', (r) => Roles.deleteRole(r.ctx, r.params.id, parse(V.deleteRoleInput, r.body).childrenTo));
company('POST', '/roles/:id/duplicate', async (r) => { r.status = 201; return { role: await Roles.duplicateRole(r.ctx, r.params.id, parse(z.object({ name: z.string().trim().min(1).max(120).optional() }), r.body).name) }; });
company('PUT', '/roles/:id/move', async (r) => ({ role: await Roles.moveRole(r.ctx, r.params.id, parse(V.moveRoleInput, r.body)) }));

company('POST', '/roles/:id/responsibilities', async (r) => { r.status = 201; return { responsibility: await Det.addResponsibility(r.ctx, r.params.id, parse(V.responsibilityInput, r.body)) }; });
company('PUT', '/roles/:id/responsibilities/order', async (r) => { await Det.reorder(r.ctx, 'responsibilities', r.params.id, parse(V.idsInput, r.body).ids); return { ok: true }; });
company('PATCH', '/responsibilities/:id', async (r) => ({ responsibility: await Det.updateResponsibility(r.ctx, r.params.id, parse(V.responsibilityInput.partial().extend({ status: z.enum(['active', 'inactive']).optional() }), r.body)) }));
company('DELETE', '/responsibilities/:id', async (r) => { await Det.deleteResponsibility(r.ctx, r.params.id); return { ok: true }; });

company('POST', '/roles/:id/rules', async (r) => { r.status = 201; return { rule: await Det.addRule(r.ctx, r.params.id, parse(V.ruleInput, r.body)) }; });
company('PUT', '/roles/:id/rules/order', async (r) => { await Det.reorder(r.ctx, 'rules', r.params.id, parse(V.idsInput, r.body).ids); return { ok: true }; });
company('PATCH', '/roles/:id/rules/:itemId', async (r) => ({ rule: await Det.updateRule(r.ctx, r.params.id, r.params.itemId, parse(V.ruleInput.partial(), r.body)) }));
company('DELETE', '/roles/:id/rules/:itemId', async (r) => { await Det.deleteRule(r.ctx, r.params.id, r.params.itemId); return { ok: true }; });
company('POST', '/roles/:id/kpis', async (r) => { r.status = 201; return { kpi: await Det.addKpi(r.ctx, r.params.id, parse(V.kpiInput, r.body)) }; });
company('PUT', '/roles/:id/kpis/order', async (r) => { await Det.reorder(r.ctx, 'kpis', r.params.id, parse(V.idsInput, r.body).ids); return { ok: true }; });
company('PATCH', '/roles/:id/kpis/:itemId', async (r) => ({ kpi: await Det.updateKpi(r.ctx, r.params.id, r.params.itemId, parse(V.kpiInput.partial(), r.body)) }));
company('DELETE', '/roles/:id/kpis/:itemId', async (r) => { await Det.deleteKpi(r.ctx, r.params.id, r.params.itemId); return { ok: true }; });

company('GET', '/roles/:id/permissions', (r) => Acc.getRolePermissions(r.ctx, r.params.id));
company('PUT', '/roles/:id/permissions', (r) => Acc.setRolePermissions(r.ctx, r.params.id, parse(z.object({ grants: z.array(V.grantInput).max(200) }), r.body).grants));
company('POST', '/roles/:id/assignments', async (r) => { r.status = 201; const b = parse(z.object({ membershipId: z.string().uuid().optional(), agentId: z.string().uuid().optional() }).refine((x) => !!x.membershipId !== !!x.agentId, 'Provide exactly one of membershipId or agentId'), r.body); return Mem.assignToRole(r.ctx, r.params.id, b); });
company('DELETE', '/roles/:id/assignments/:itemId', async (r) => { await Mem.unassignFromRole(r.ctx, r.params.id, r.params.itemId); return { ok: true }; });
company('POST', '/roles/:id/owner', async (r) => { await Mem.setRoleOwner(r.ctx, r.params.id, parse(z.object({ assignmentId: z.string().uuid() }), r.body).assignmentId); return { ok: true }; });

company('GET', '/members', async (r) => ({ members: await Mem.listMembers(r.ctx), invites: await Mem.listInvites(r.ctx) }));
company('POST', '/invites', async (r) => { r.status = 201; return Mem.createInvite(r.ctx, parse(V.inviteInput, r.body)); });
company('DELETE', '/invites/:id', async (r) => { await Mem.revokeInvite(r.ctx, r.params.id); return { ok: true }; });
company('PATCH', '/members/:id', (r) => Mem.updateMember(r.ctx, r.params.id, parse(V.memberUpdateInput, r.body)));
company('DELETE', '/members/:id', (r) => Mem.removeMember(r.ctx, r.params.id));
company('GET', '/members/:id/permissions', (r) => Acc.getMemberPermissions(r.ctx, r.params.id));
company('PUT', '/members/:id/permissions', (r) => Acc.setMemberPermissions(r.ctx, r.params.id, parse(z.object({ keys: z.array(z.string().max(60)).max(200) }), r.body).keys));

// ───────────── Phase 2: employees ─────────────
company('GET', '/employees', async (r) => ({ employees: await Emp.listEmployees(r.ctx) }));
company('GET', '/employees/:id', (r) => Emp.getEmployee(r.ctx, r.params.id));
company('PATCH', '/employees/:id', (r) => Emp.updateEmployee(r.ctx, r.params.id, parse(V.employeeUpdateInput, r.body)));
company('POST', '/employees/:id/deactivate', (r) => Emp.setEmployeeActive(r.ctx, r.params.id, false));
company('POST', '/employees/:id/reactivate', (r) => Emp.setEmployeeActive(r.ctx, r.params.id, true));
company('GET', '/me/profile', (r) => Emp.myProfile(r.ctx));
company('PATCH', '/me/profile', (r) => Emp.updateMyProfile(r.ctx, parse(z.object({ phone: V.employeeUpdateInput.shape.phone, bio: V.employeeUpdateInput.shape.bio }), r.body)));
company('POST', '/me/onboarding/:itemId', (r) => Emp.setMyOnboardingItem(r.ctx, r.params.itemId, parse(z.object({ done: z.boolean() }), r.body).done));

// ───────────── Phase 2: AI employees ─────────────
company('GET', '/ai/meta', (r) => { if (!r.ctx.hasAny('agents.view')) throw new HttpError(403, 'You do not have permission to do this', 'forbidden'); return Agents.aiMeta(); });
company('GET', '/agents', async (r) => ({ agents: await Agents.listAgents(r.ctx) }));
company('POST', '/agents', async (r) => { r.status = 201; const a = await Agents.createAgent(r.ctx, parse(V.createAgentInput, r.body)); return { agent: { id: a.id, name: a.name } }; });
company('GET', '/agents/:id', (r) => Agents.getAgent(r.ctx, r.params.id));
company('PATCH', '/agents/:id', async (r) => { await Agents.updateAgent(r.ctx, r.params.id, parse(V.updateAgentInput, r.body)); return { ok: true }; });
company('DELETE', '/agents/:id', async (r) => { await Agents.archiveAgent(r.ctx, r.params.id); return { ok: true }; });
company('POST', '/agents/:id/status', async (r) => { await Agents.setAgentStatus(r.ctx, r.params.id, parse(z.object({ status: z.enum(['active', 'inactive']) }), r.body).status); return { ok: true }; });
company('PUT', '/agents/:id/config', async (r) => { await Agents.setAgentConfig(r.ctx, r.params.id, parse(V.agentConfigInput, r.body)); return { ok: true }; });
company('PUT', '/agents/:id/tools', async (r) => { await Agents.setAgentTools(r.ctx, r.params.id, parse(V.agentToolsInput, r.body).tools); return { ok: true }; });
company('PUT', '/agents/:id/responsibilities', async (r) => { await Agents.setAgentResponsibilities(r.ctx, r.params.id, parse(V.idsInput, r.body).ids); return { ok: true }; });
company('POST', '/agents/:id/run', (r) => runAgent(r.ctx, r.params.id, parse(z.object({ input: z.string().trim().min(1).max(8000) }), r.body).input));
company('GET', '/ai-work-items', async (r) => ({ items: await Agents.listWorkItems(r.ctx, { status: r.query.get('status') ?? undefined, agentId: r.query.get('agentId') ?? undefined }) }));
company('POST', '/ai-work-items/:id/review', (r) => { const b = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).nullish() }), r.body); return Agents.reviewWorkItem(r.ctx, r.params.id, b.decision, b.note); });

// ───────────── Phase 2: workforce dashboard ─────────────
company('GET', '/workforce', (r) => WF.workforceOverview(r.ctx));
company('GET', '/workforce/directory', (r) => WF.directory(r.ctx));

// ───────────── Phase 3: tasks, projects, KPIs, reports ─────────────
const qs = (r: R) => Object.fromEntries(r.query.entries());
company('GET', '/tasks', async (r) => { const q = qs(r); return { tasks: await Tasks.listTasks(r.ctx, { status: q.status?.split(',').filter(Boolean), mine: q.mine === '1', ownerMembershipId: q.ownerMembershipId, ownerAgentId: q.ownerAgentId, departmentId: q.departmentId, roleId: q.roleId, projectId: q.projectId, parentTaskId: q.parentTaskId, topLevel: q.topLevel === '1', overdue: q.overdue === '1', dueFrom: q.dueFrom, dueTo: q.dueTo, q: q.q?.slice(0, 100) }) }; });
company('POST', '/tasks', async (r) => { r.status = 201; const t = await Tasks.createTask(r.ctx, parse(V.taskCreateInput, r.body) as any); return { task: { id: t.id, title: t.title, status: t.status } }; });
company('GET', '/tasks/:id', (r) => Tasks.getTask(r.ctx, r.params.id));
company('PATCH', '/tasks/:id', async (r) => { await Tasks.updateTask(r.ctx, r.params.id, parse(V.taskUpdateInput, r.body) as any); return { ok: true }; });
company('DELETE', '/tasks/:id', async (r) => { await Tasks.deleteTask(r.ctx, r.params.id); return { ok: true }; });
company('POST', '/tasks/:id/status', async (r) => { const b = parse(V.taskStatusInput, r.body); await Tasks.setTaskStatus(r.ctx, r.params.id, b.status, { reason: b.reason, note: b.note }); return { ok: true }; });
company('POST', '/tasks/:id/approve', async (r) => { await Tasks.setTaskStatus(r.ctx, r.params.id, 'completed', { note: parse(z.object({ note: z.string().trim().max(2000).nullish() }), r.body).note }); return { ok: true }; });
company('POST', '/tasks/:id/reject', async (r) => { const b = parse(z.object({ reason: z.string().trim().min(1).max(2000) }), r.body); await Tasks.setTaskStatus(r.ctx, r.params.id, 'in_progress', { note: `Not approved: ${b.reason}` }); return { ok: true }; });
company('POST', '/tasks/:id/assign', async (r) => { await Tasks.assignTask(r.ctx, r.params.id, parse(V.taskOwnerInput, r.body)); return { ok: true }; });
company('PUT', '/tasks/:id/dependencies', async (r) => { await Tasks.setDependencies(r.ctx, r.params.id, parse(V.idsInput, r.body).ids); return { ok: true }; });
company('POST', '/tasks/:id/comments', async (r) => { r.status = 201; return { comment: await Tasks.addComment(r.ctx, r.params.id, parse(z.object({ body: z.string().trim().min(1).max(4000) }), r.body).body) }; });
company('POST', '/tasks/:id/attachments', async (r) => { r.status = 201; return { attachment: await Tasks.addAttachment(r.ctx, r.params.id, parse(V.attachmentInput, r.body)) }; });
company('GET', '/tasks/:id/attachments/:itemId', (r) => Tasks.downloadAttachment(r.ctx, r.params.id, r.params.itemId));
company('DELETE', '/tasks/:id/attachments/:itemId', async (r) => { await Tasks.deleteAttachment(r.ctx, r.params.id, r.params.itemId); return { ok: true }; });
company('GET', '/recurring-tasks', async (r) => ({ recurring: await Tasks.listRecurring(r.ctx) }));
company('POST', '/recurring-tasks', async (r) => { r.status = 201; return { recurring: await Tasks.createRecurring(r.ctx, parse(V.recurringInput, r.body) as any) }; });
company('POST', '/recurring-tasks/run', async (r) => { r.ctx.require('tasks.create'); return { created: await Tasks.generateRecurring(r.ctx.db, r.ctx.companyId) }; });
company('POST', '/recurring-tasks/:id/active', async (r) => { await Tasks.setRecurringActive(r.ctx, r.params.id, parse(z.object({ active: z.boolean() }), r.body).active); return { ok: true }; });

company('GET', '/projects', async (r) => ({ projects: await Proj.listProjects(r.ctx) }));
company('POST', '/projects', async (r) => { r.status = 201; const p = await Proj.createProject(r.ctx, parse(V.projectInput, r.body) as any); return { project: { id: p.id, name: p.name } }; });
company('GET', '/projects/:id', (r) => Proj.getProject(r.ctx, r.params.id));
company('PATCH', '/projects/:id', async (r) => { await Proj.updateProject(r.ctx, r.params.id, parse(V.projectUpdateInput, r.body) as any); return { ok: true }; });
company('DELETE', '/projects/:id', async (r) => { await Proj.deleteProject(r.ctx, r.params.id); return { ok: true }; });

company('GET', '/kpis', (r) => { const q = qs(r); return Kpis.listKpis(r.ctx, { roleId: q.roleId, departmentId: q.departmentId, anchor: q.anchor }); });
company('GET', '/kpis/:id/values', async (r) => ({ values: await Kpis.listKpiValues(r.ctx, r.params.id) }));
company('POST', '/kpis/:id/values', async (r) => { r.status = 201; return { value: await Kpis.recordKpiValue(r.ctx, r.params.id, parse(V.kpiValueInput, r.body)) }; });
company('DELETE', '/kpis/:id/values/:itemId', async (r) => { await Kpis.deleteKpiValue(r.ctx, r.params.id, r.params.itemId); return { ok: true }; });
company('GET', '/responsibilities/tracking', async (r) => { const q = qs(r); return { responsibilities: await Kpis.trackResponsibilities(r.ctx, { roleId: q.roleId, departmentId: q.departmentId, period: q.period, anchor: q.anchor }) }; });

company('GET', '/performance', (r) => { const q = qs(r); return Rep.performanceRows(r.ctx, q.dimension ?? 'department', q.period ?? 'monthly', q.anchor, q.from, q.to); });
company('GET', '/dashboard/founder', (r) => Rep.founderDashboard(r.ctx));
company('GET', '/me/work', (r) => Rep.myWork(r.ctx));
company('GET', '/reports/catalog', (r) => Rep.reportCatalog(r.ctx));
company('GET', '/reports/run', (r) => Rep.buildReport(r.ctx, parse(V.reportQuery, qs(r))));
company('GET', '/reports/export', async (r) => {
  const q = qs(r); const format = q.format; if (format !== 'csv' && format !== 'pdf') throw new HttpError(400, 'format must be csv or pdf', 'bad_request');
  const report = await Rep.buildReport(r.ctx, parse(V.reportQuery, q), { forExport: true }); // view + export authorisation happen before anything is rendered
  const safe = report.title.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 60) || 'report'; const file = `${safe}_${report.from}_${report.to}.${format}`;
  await audit(r.ctx.db, r.ctx.companyId, r.ctx.user.id, 'report.exported', 'report', null, { type: report.type, format, from: report.from, to: report.to });
  const body = format === 'csv' ? renderCsv(report) : await renderPdf(report);
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { headers: { 'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf', 'content-disposition': `attachment; filename="${file}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
});
company('GET', '/report-grants', async (r) => ({ grants: await Rep.listReportGrants(r.ctx) }));
company('POST', '/report-grants', async (r) => { r.status = 201; return { grant: await Rep.addReportGrant(r.ctx, parse(V.reportGrantInput, r.body)) }; });
company('DELETE', '/report-grants/:id', async (r) => { await Rep.revokeReportGrant(r.ctx, r.params.id); return { ok: true }; });
company('GET', '/notifications', (r) => Notif.listNotifications(r.ctx, r.query.get('unread') === '1'));
company('POST', '/notifications/read', async (r) => { await Notif.markRead(r.ctx, parse(z.object({ id: z.string().uuid().optional() }), r.body).id); return { ok: true }; });

// ───────────── Phase 4: knowledge, decisions, onboarding, handover ─────────────
company('GET', '/knowledge/meta', () => Know.knowledgeMeta());
company('GET', '/knowledge/search', async (r) => { const q = qs(r); if (!q.q?.trim()) throw new HttpError(400, 'Enter something to search for', 'bad_request'); return Know.searchDocuments(r.ctx, q.q.slice(0, 500), { docType: q.docType, tag: q.tag, departmentId: q.departmentId, roleId: q.roleId, projectId: q.projectId }, Number(q.limit) || 10); });
company('POST', '/knowledge/reindex', (r) => Know.reindexAll(r.ctx));
company('GET', '/knowledge', async (r) => { const q = qs(r); return { documents: await Know.listDocuments(r.ctx, { docType: q.docType, tag: q.tag, departmentId: q.departmentId, roleId: q.roleId, projectId: q.projectId, status: q.status, mine: q.mine === '1', needsReview: q.needsReview === '1', q: q.q }) }; });
company('POST', '/knowledge', async (r) => { r.status = 201; const d = await Know.createDocument(r.ctx, parse(V.docCreateInput, r.body) as any); return { document: { id: d.id, title: d.title, searchable: d.textExtracted } }; });
company('GET', '/knowledge/:id', (r) => Know.getDocument(r.ctx, r.params.id));
company('PATCH', '/knowledge/:id', (r) => Know.updateDocument(r.ctx, r.params.id, parse(V.docUpdateInput, r.body) as any));
company('DELETE', '/knowledge/:id', async (r) => { await Know.archiveDocument(r.ctx, r.params.id); return { ok: true }; });
company('POST', '/knowledge/:id/publish', async (r) => { await Know.publishDocument(r.ctx, r.params.id); return { ok: true }; });
company('PUT', '/knowledge/:id/security', async (r) => { await Know.setDocumentSecurity(r.ctx, r.params.id, parse(V.docSecurityInput, r.body) as any); return { ok: true }; });
company('PUT', '/knowledge/:id/access', async (r) => { await Know.setAccess(r.ctx, r.params.id, parse(V.docAccessInput, r.body).grants); return { ok: true }; });
company('POST', '/knowledge/:id/restore', (r) => Know.restoreVersion(r.ctx, r.params.id, parse(z.object({ version: z.number().int().min(1) }), r.body).version));
company('GET', '/knowledge/:id/file', (r) => Know.downloadFile(r.ctx, r.params.id));
company('GET', '/knowledge/:id/versions/:version', (r) => Know.getVersion(r.ctx, r.params.id, Number(r.params.version)));
company('GET', '/knowledge/:id/versions/:version/file', (r) => Know.downloadFile(r.ctx, r.params.id, Number(r.params.version)));

company('GET', '/decisions', async (r) => { const q = qs(r); return { decisions: await Dec.listDecisions(r.ctx, { status: q.status, roleId: q.roleId, projectId: q.projectId, q: q.q }) }; });
company('POST', '/decisions', async (r) => { r.status = 201; const d = await Dec.createDecision(r.ctx, parse(V.decisionInput, r.body) as any); return { decision: { id: d.id, status: d.status } }; });
company('GET', '/decisions/:id', (r) => Dec.getDecision(r.ctx, r.params.id));
company('PATCH', '/decisions/:id', async (r) => { await Dec.updateDecision(r.ctx, r.params.id, parse(V.decisionPatchInput, r.body) as any); return { ok: true }; });
company('DELETE', '/decisions/:id', async (r) => { await Dec.deleteDecision(r.ctx, r.params.id); return { ok: true }; });
company('POST', '/decisions/:id/approve', async (r) => { await Dec.approveDecision(r.ctx, r.params.id, parse(z.object({ decisionMakerMembershipId: z.string().uuid().nullish(), decidedOn: z.string().nullish() }), r.body) as any); return { ok: true }; });
company('POST', '/decisions/:id/reject', async (r) => { await Dec.rejectDecision(r.ctx, r.params.id, parse(z.object({ note: z.string().trim().min(1).max(2000) }), r.body).note); return { ok: true }; });
company('POST', '/decisions/:id/review', async (r) => { await Dec.addReview(r.ctx, r.params.id, parse(z.object({ outcomeNotes: z.string().trim().max(3000).nullish(), reviewDate: z.string().nullish() }), r.body) as any); return { ok: true }; });
company('POST', '/decisions/:id/supersede', async (r) => { r.status = 201; const d = await Dec.supersedeDecision(r.ctx, r.params.id, parse(V.decisionInput, r.body) as any); return { decision: { id: d.id, status: d.status } }; });

company('GET', '/me/onboarding', (r) => Onb.onboardingPackage(r.ctx, r.ctx.membership.id));
company('GET', '/employees/:id/onboarding', (r) => Onb.onboardingPackage(r.ctx, r.params.id));
company('POST', '/employees/:id/onboarding/regenerate', (r) => Onb.regenerateOnboarding(r.ctx, r.params.id));
company('GET', '/employees/:id/exit-preview', (r) => HO.exitPreview(r.ctx, r.params.id));
company('POST', '/employees/:id/exit', async (r) => { r.status = 201; return HO.executeExit(r.ctx, r.params.id, parse(V.exitInput, r.body) as any); });
company('POST', '/transitions/ai-to-human', async (r) => { r.status = 201; return HO.aiToHuman(r.ctx, parse(V.aiToHumanInput, r.body) as any); });
company('POST', '/roles/:id/transfer', async (r) => { r.status = 201; return HO.transferRole(r.ctx, r.params.id, parse(V.transferRoleInput, r.body) as any); });
company('GET', '/transitions', async (r) => ({ transitions: await HO.listTransitions(r.ctx, r.query.get('status') ?? undefined) }));
company('GET', '/handovers/:id', (r) => HO.getHandover(r.ctx, r.params.id));
company('POST', '/handovers/:id/assign', (r) => { const b = parse(z.object({ itemId: z.string().uuid().nullish(), kind: z.string().max(30).nullish(), to: V.targetInput, includeTasks: z.boolean().optional(), approverMembershipId: z.string().uuid().nullish() }), r.body); return HO.assignItem(r.ctx, r.params.id, b.itemId ?? null, b.to, { kind: b.kind ?? undefined, includeTasks: b.includeTasks, approverMembershipId: b.approverMembershipId ?? null }); });
company('POST', '/handovers/:id/items/:itemId/resolve', (r) => HO.resolveItem(r.ctx, r.params.id, r.params.itemId, parse(z.object({ status: z.enum(['done', 'skipped']), note: z.string().trim().max(1000).nullish() }), r.body)));
company('GET', '/handovers/:id/export', async (r) => {
  const format = r.query.get('format'); if (format !== 'csv' && format !== 'pdf') throw new HttpError(400, 'format must be csv or pdf', 'bad_request');
  const rep = await HO.exportHandover(r.ctx, r.params.id); const body = format === 'csv' ? renderCsv(rep) : await renderPdf(rep);
  return new Response(typeof body === 'string' ? body : new Uint8Array(body), { headers: { 'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/pdf', 'content-disposition': `attachment; filename="Handover_${rep.title.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 50)}.${format}"`, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' } });
});

// ───────────── dispatcher ─────────────
function json(data: unknown, status = 200, cookies: string[] = []) {
  const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  cookies.forEach((c) => h.append('set-cookie', c));
  return new Response(JSON.stringify(data), { status, headers: h });
}

export async function handle(req: Request, dbOverride?: Db): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '') || '/';
    let route: Route | undefined; let m: RegExpMatchArray | null = null;
    const pathMatches = routes.filter((x) => x.re.test(path));
    route = pathMatches.find((x) => x.method === req.method);
    if (!route) { if (pathMatches.length) throw new HttpError(405, 'Method not allowed', 'method_not_allowed'); throw notFound('Unknown endpoint'); }
    m = path.match(route.re)!;
    const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m![i + 1])]));

    const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    if (mutating) {
      const origin = req.headers.get('origin');
      if (origin && new URL(origin).host !== (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? url.host)) throw new HttpError(403, 'Cross-origin request blocked', 'csrf');
    }
    let body: unknown = undefined;
    if (mutating && req.headers.get('content-length') !== '0') {
      const text = await req.text();
      if (text.length > ((req.method === 'POST' && /\/attachments$/.test(path)) || (['POST', 'PATCH'].includes(req.method) && /\/knowledge(\/[^/]+)?$/.test(path)) ? 3_500_000 : 1_000_000)) throw badRequest('Request too large');
      if (text) { try { body = JSON.parse(text); } catch { throw badRequest('Body must be valid JSON'); } }
    }
    const db = dbOverride ?? (await getDb());
    const token = getCookie(req, Auth.SESSION_COOKIE);
    const r = { db, req, params, query: url.searchParams, body, token, ip: (req.headers.get('x-forwarded-for') ?? 'local').split(',')[0].trim(), cookies: [] as string[] } as R;
    if (route.auth !== 'none') {
      const user = await Auth.sessionUser(db, token);
      if (!user) throw unauthorized();
      r.user = user;
      if (route.auth === 'company') r.ctx = await loadCtx(db, user, params.companyId); // verifies ACTIVE membership of THIS company
    }
    const data = await route.handler(r);
    if (data instanceof Response) { r.cookies.forEach((c) => data.headers.append('set-cookie', c)); return data; }
    return json(data ?? { ok: true }, r.status ?? 200, r.cookies);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    if (e instanceof ZodError) return json({ error: e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).slice(0, 5).join('; '), code: 'validation' }, 400);
    const msg = String((e as any)?.message ?? '') + String((e as any)?.cause?.message ?? '');
    if (/violates foreign key|violates unique|duplicate key/i.test(msg)) return json({ error: 'That change conflicts with existing data', code: 'conflict' }, 409);
    console.error('[api] unhandled', e);
    return json({ error: 'Something went wrong', code: 'internal' }, 500);
  }
}
