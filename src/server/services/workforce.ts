import { and, eq, isNull } from 'drizzle-orm';
import { schema } from '@/db/client';
import { forbidden } from '@/lib/errors';
import type { Ctx } from '../authz';
import { listAgents } from './agents';
import { listEmployees } from './employees';
import { listRoles } from './roles';

const S = schema;

/** Role-assignment dashboard: every role with who/what holds it, its mode, owner, manager, department and responsibilities. */
export async function workforceOverview(ctx: Ctx) {
  const roles = await listRoles(ctx); // already scoped to what the caller may view
  const resp = await ctx.db.select({ roleId: S.roleResponsibilities.roleId, title: S.roleResponsibilities.title }).from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), isNull(S.roleResponsibilities.archivedAt)));
  const rows = roles.map((r) => ({
    id: r.id, name: r.name, departmentId: r.departmentId, departmentName: r.departmentName, reportsToName: r.reportsToName, mode: r.roleType, status: r.status,
    owner: r.assignees.find((a: any) => a.isOwner) ?? null, assignees: r.assignees,
    responsibilities: resp.filter((x) => x.roleId === r.id).map((x) => x.title),
  }));
  const count = (m: string) => rows.filter((r) => r.mode === m).length;
  return { counts: { ai: count('ai'), human: count('human'), hybrid: count('hybrid'), vacant: count('vacant'), total: rows.length }, roles: rows };
}

/** Directory of everyone who works here: people and AI employees. Each half is included only if the caller may view it. */
export async function directory(ctx: Ctx) {
  const canHumans = ctx.can('members.view'), canAi = ctx.hasAny('agents.view');
  if (!canHumans && !canAi) throw forbidden();
  const [humans, ais] = await Promise.all([canHumans ? listEmployees(ctx) : Promise.resolve([]), canAi ? listAgents(ctx) : Promise.resolve([])]);
  return {
    people: [
      ...humans.map((h) => ({ kind: 'human' as const, id: h.membershipId, name: h.name, email: h.email, status: h.status, jobTitle: h.jobTitle, departmentName: h.departmentName, managerName: h.managerName, roles: h.roles.map((r) => r.roleName) })),
      ...ais.map((a) => ({ kind: 'ai' as const, id: a.id, name: a.name, email: null, status: a.status === 'active' ? 'active' : 'inactive', jobTitle: 'AI employee', departmentName: a.departmentName, managerName: a.managerName, roles: a.roles.map((r) => r.name) })),
    ].sort((x, y) => x.name.localeCompare(y.name)),
    counts: { humans: humans.filter((h) => h.status !== 'inactive').length, inactiveHumans: humans.filter((h) => h.status === 'inactive').length, ai: ais.filter((a) => a.status === 'active').length, inactiveAi: ais.filter((a) => a.status !== 'active').length },
  };
}
