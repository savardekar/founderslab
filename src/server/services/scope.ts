import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import type { Ctx } from '../authz';
import type { TaskLite } from './metrics';

const S = schema;

/** Everything the operational reports need, loaded once per request (company-sized data). */
export async function loadOps(db: Db, companyId: string) {
  const live = <T extends { companyId: any; archivedAt: any }>(t: T) => and(eq(t.companyId, companyId), isNull(t.archivedAt));
  const [roles, depts, members, agents, projects, projectMembers, tasks, kpis, values, resp, assigns] = await Promise.all([
    db.select().from(S.roles).where(live(S.roles)),
    db.select().from(S.departments).where(live(S.departments)),
    db.select({ id: S.companyMemberships.id, userId: S.companyMemberships.userId, name: S.users.name, status: S.companyMemberships.status, jobTitle: S.companyMemberships.jobTitle, departmentId: S.employees.departmentId, managerId: S.employees.managerMembershipId, empStatus: S.employees.status })
      .from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).leftJoin(S.employees, and(eq(S.employees.companyId, S.companyMemberships.companyId), eq(S.employees.membershipId, S.companyMemberships.id))).where(eq(S.companyMemberships.companyId, companyId)),
    db.select().from(S.aiAgents).where(live(S.aiAgents)),
    db.select().from(S.projects).where(live(S.projects)),
    db.select().from(S.projectMembers).where(eq(S.projectMembers.companyId, companyId)),
    db.select().from(S.tasks).where(live(S.tasks)),
    db.select().from(S.roleKpis).where(live(S.roleKpis)),
    db.select().from(S.kpiValues).where(eq(S.kpiValues.companyId, companyId)),
    db.select().from(S.roleResponsibilities).where(and(live(S.roleResponsibilities), eq(S.roleResponsibilities.status, 'active'))),
    db.select().from(S.roleAssignments).where(and(eq(S.roleAssignments.companyId, companyId), isNull(S.roleAssignments.endedAt))),
  ]);
  return { roles, depts, members, agents, projects, projectMembers, tasks, kpis, values, resp, assigns };
}
export type Ops = Awaited<ReturnType<typeof loadOps>>;
export const lite = (t: Ops['tasks'][number]): TaskLite => ({ id: t.id, title: t.title, status: t.status, dueDate: t.dueDate, startDate: t.startDate, completedAt: t.completedAt, createdAt: t.createdAt, priority: t.priority, roleId: t.roleId, departmentId: t.departmentId, ownerMembershipId: t.ownerMembershipId, ownerAgentId: t.ownerAgentId, projectId: t.projectId, statusChangedAt: t.statusChangedAt });

/**
 * What the caller may build reports about. Access comes ONLY from:
 *   • being the company owner,
 *   • a reports.view grant — its scope decides the extent: company = everything, department = own department(s), own = own role(s) and the roles below them,
 *   • explicit report_grants rows (custom reporting permissions),
 *   • yourself (personal report).
 * A manager title or reporting line on its own grants nothing. Financial / HR data needs its own permission (finance.view / members.view).
 */
export type Scope = { can: (key: string, t?: { roleId?: string | null; departmentId?: string | null }) => boolean; roleDept: Map<string, string | null>; all: boolean; departmentIds: Set<string>; roleIds: Set<string>; employeeIds: Set<string>; projectIds: Set<string>; me: string; financial: boolean; hr: boolean; hasReports: boolean };

export async function reportScope(ctx: Ctx, ops: Ops): Promise<Scope> {
  const sc: Scope = { can: (k, t) => ctx.can(k, t), roleDept: new Map(ops.roles.map((r) => [r.id, r.departmentId])), all: false, departmentIds: new Set(), roleIds: new Set(), employeeIds: new Set([ctx.membership.id]), projectIds: new Set(), me: ctx.membership.id, financial: ctx.can('finance.view'), hr: ctx.can('members.view'), hasReports: ctx.hasAny('reports.view') };
  const scopes = ctx.scopesOf('reports.view');
  if (scopes.has('company')) sc.all = true;
  if (scopes.has('department')) ctx.myDepartmentIds.forEach((d) => sc.departmentIds.add(d));
  if (scopes.has('own')) {
    const kids = new Map<string, string[]>(); ops.roles.forEach((r) => r.reportsToRoleId && kids.set(r.reportsToRoleId, [...(kids.get(r.reportsToRoleId) ?? []), r.id]));
    const st = [...ctx.myRoleIds]; while (st.length) { const c = st.pop()!; if (sc.roleIds.has(c)) continue; sc.roleIds.add(c); st.push(...(kids.get(c) ?? [])); }
  }
  const grants = await ctx.db.select().from(S.reportGrants).where(and(eq(S.reportGrants.companyId, ctx.companyId), eq(S.reportGrants.membershipId, ctx.membership.id), isNull(S.reportGrants.revokedAt)));
  for (const g of grants) ({ department: sc.departmentIds, role: sc.roleIds, project: sc.projectIds, employee: sc.employeeIds } as Record<string, Set<string>>)[g.scopeType]?.add(g.scopeId);
  return sc;
}

export function makePredicates(sc: Scope, ops: Ops) {
  const roleById = new Map(ops.roles.map((r) => [r.id, r]));
  const rolesOfMember = (mid: string) => ops.assigns.filter((a) => a.membershipId === mid).map((a) => a.roleId);
  const rolesOfAgent = (aid: string) => ops.assigns.filter((a) => a.agentId === aid).map((a) => a.roleId);
  const roleIn = (roleId: string | null | undefined) => { if (!roleId) return false; if (sc.all || sc.roleIds.has(roleId)) return true; const r = roleById.get(roleId); return !!r?.departmentId && sc.departmentIds.has(r.departmentId); };
  const deptIn = (d: string | null | undefined) => !!d && (sc.all || sc.departmentIds.has(d));
  const employeeIn = (mid: string) => {
    if (sc.all || sc.employeeIds.has(mid)) return true;
    const m = ops.members.find((x) => x.id === mid); if (m?.departmentId && sc.departmentIds.has(m.departmentId)) return true;
    return rolesOfMember(mid).some(roleIn);
  };
  const agentIn = (aid: string) => { if (sc.all) return true; const a = ops.agents.find((x) => x.id === aid); if (!a) return false; return a.managerMembershipId === sc.me || (!!a.departmentId && sc.departmentIds.has(a.departmentId)) || rolesOfAgent(aid).some(roleIn); };
  const projectIn = (pid: string) => {
    if (sc.all || sc.projectIds.has(pid)) return true; const p = ops.projects.find((x) => x.id === pid); if (!p) return false;
    return p.ownerMembershipId === sc.me || ops.projectMembers.some((m) => m.projectId === pid && m.membershipId === sc.me) || (!!p.departmentId && sc.departmentIds.has(p.departmentId));
  };
  /** A task is in the caller's report scope through its role, department, owner or project. */
  const taskIn = (t: { roleId: string | null; departmentId: string | null; ownerMembershipId: string | null; ownerAgentId: string | null; projectId: string | null }) =>
    sc.all || roleIn(t.roleId) || deptIn(t.departmentId) || (!!t.ownerMembershipId && (t.ownerMembershipId === sc.me || sc.employeeIds.has(t.ownerMembershipId))) || (!!t.ownerAgentId && agentIn(t.ownerAgentId)) || (!!t.projectId && projectIn(t.projectId));
  return { roleIn, deptIn, employeeIn, agentIn, projectIn, taskIn, rolesOfMember, rolesOfAgent, roleById };
}

/** Sensitive KPIs need their own permission regardless of hierarchy or report scope. */
export const kpiAllowed = (sc: Scope, k: { sensitivity: string; roleId: string }) => {
  const t = { roleId: k.roleId, departmentId: sc.roleDept.get(k.roleId) ?? null };
  return k.sensitivity === 'financial' ? sc.can('finance.view', t) : k.sensitivity === 'hr' ? sc.can('members.view', t) : true;
};
