import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { PROJECT_STATUSES } from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { daysBetween, today } from './metrics';
import { notify } from './notifications';

const S = schema;
const uid = () => globalThis.crypto.randomUUID();
type Proj = typeof S.projects.$inferSelect;
export type ProjectInput = { name: string; description?: string | null; ownerMembershipId?: string | null; departmentId?: string | null; status?: (typeof PROJECT_STATUSES)[number]; startDate?: string | null; deadline?: string | null; goals?: string[]; deliverables?: { id?: string; title: string; done?: boolean }[]; team?: { membershipIds?: string[]; agentIds?: string[] } };

export function projectHealth(p: { status: string; startDate: string | null; deadline: string | null }, t: { total: number; done: number; open: number; overdue: number }, now = new Date()) {
  const t0 = today(now);
  const progress = t.total ? t.done / t.total : null;
  if (p.status === 'completed' || p.status === 'cancelled' || p.status === 'on_hold') return { health: p.status, progress };
  if (p.deadline && p.deadline < t0) return { health: 'late', progress };
  if (!t.total) return { health: 'not_started', progress };
  if (p.startDate && p.deadline && p.deadline > p.startDate) {
    const elapsed = Math.min(1, Math.max(0, daysBetween(p.startDate, t0) / daysBetween(p.startDate, p.deadline)));
    if (progress! < elapsed - 0.2) return { health: 'at_risk', progress };
  }
  if (t.open && t.overdue / t.open > 0.25) return { health: 'at_risk', progress };
  return { health: 'on_track', progress };
}

async function checkRefs(ctx: Ctx, p: ProjectInput) {
  if (p.departmentId) { const [d] = await ctx.db.select({ id: S.departments.id }).from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, p.departmentId), isNull(S.departments.archivedAt))); if (!d) throw badRequest('Department not found'); }
  const mids = [...new Set([...(p.team?.membershipIds ?? []), ...(p.ownerMembershipId ? [p.ownerMembershipId] : [])])];
  for (const m of mids) { const [x] = await ctx.db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, m), eq(S.companyMemberships.status, 'active'))); if (!x) throw badRequest('Team members must be active employees'); }
  for (const a of p.team?.agentIds ?? []) { const [x] = await ctx.db.select({ id: S.aiAgents.id }).from(S.aiAgents).where(and(eq(S.aiAgents.companyId, ctx.companyId), eq(S.aiAgents.id, a), isNull(S.aiAgents.archivedAt))); if (!x) throw badRequest('AI employee not found'); }
  if (p.startDate && p.deadline && p.deadline < p.startDate) throw badRequest('The deadline cannot be before the start date');
}
const isMemberOf = async (ctx: Ctx, p: Proj) => p.ownerMembershipId === ctx.membership.id || (await ctx.db.select({ id: S.projectMembers.id }).from(S.projectMembers).where(and(eq(S.projectMembers.companyId, ctx.companyId), eq(S.projectMembers.projectId, p.id), eq(S.projectMembers.membershipId, ctx.membership.id)))).length > 0;
async function load(ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Project not found');
  const [p] = await ctx.db.select().from(S.projects).where(and(eq(S.projects.companyId, ctx.companyId), eq(S.projects.id, id), isNull(S.projects.archivedAt)));
  if (!p) throw notFound('Project not found');
  const member = await isMemberOf(ctx, p);
  if (!member && !ctx.can('projects.view', { departmentId: p.departmentId })) throw notFound('Project not found');
  return { p, member };
}

export async function createProject(ctx: Ctx, i: ProjectInput) {
  const owner = i.ownerMembershipId ?? ctx.membership.id; const tg = { departmentId: i.departmentId ?? null };
  ctx.require('projects.create', tg); if (owner !== ctx.membership.id) ctx.require('projects.assign', tg);
  await checkRefs(ctx, { ...i, ownerMembershipId: owner });
  return ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const [p] = await db.insert(S.projects).values({ companyId: ctx.companyId, name: i.name, description: i.description ?? null, ownerMembershipId: owner, departmentId: i.departmentId ?? null, status: i.status ?? 'planning', startDate: i.startDate ?? null, deadline: i.deadline ?? null, goals: i.goals ?? [], deliverables: (i.deliverables ?? []).map((d) => ({ id: uid(), title: d.title, done: !!d.done })), createdBy: ctx.user.id }).returning();
    const rows: any[] = [...new Set(i.team?.membershipIds ?? [])].filter((m) => m !== owner).map((m) => ({ companyId: ctx.companyId, projectId: p.id, membershipId: m })).concat([...new Set(i.team?.agentIds ?? [])].map((a) => ({ companyId: ctx.companyId, projectId: p.id, agentId: a })) as any);
    if (rows.length) await db.insert(S.projectMembers).values(rows);
    await audit(db, ctx.companyId, ctx.user.id, 'project.created', 'project', p.id, { name: p.name });
    if (owner !== ctx.membership.id) { const [m] = await db.select({ u: S.companyMemberships.userId }).from(S.companyMemberships).where(eq(S.companyMemberships.id, owner)); await notify(db, ctx.companyId, [m?.u], { kind: 'project_assigned', title: `You own a new project: ${p.name}`, link: `/c/${ctx.companyId}/projects?project=${p.id}`, dedupeKey: `proj:${p.id}` }); }
    return p;
  });
}

async function stats(ctx: Ctx) {
  const rows = await ctx.db.select({ projectId: S.tasks.projectId, status: S.tasks.status, due: S.tasks.dueDate }).from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), isNull(S.tasks.archivedAt), sql`${S.tasks.projectId} is not null`));
  const t0 = today(); const m = new Map<string, { total: number; done: number; open: number; overdue: number }>();
  for (const r of rows) { if (r.status === 'cancelled') continue; const s = m.get(r.projectId!) ?? { total: 0, done: 0, open: 0, overdue: 0 }; s.total++; if (r.status === 'completed') s.done++; else { s.open++; if (r.due && r.due < t0) s.overdue++; } m.set(r.projectId!, s); }
  return m;
}

export async function listProjects(ctx: Ctx) {
  const [ps, people, depts, team, st] = await Promise.all([
    ctx.db.select().from(S.projects).where(and(eq(S.projects.companyId, ctx.companyId), isNull(S.projects.archivedAt))).orderBy(asc(S.projects.deadline)),
    ctx.db.select({ id: S.companyMemberships.id, name: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(eq(S.companyMemberships.companyId, ctx.companyId)),
    ctx.db.select({ id: S.departments.id, name: S.departments.name }).from(S.departments).where(eq(S.departments.companyId, ctx.companyId)),
    ctx.db.select().from(S.projectMembers).where(eq(S.projectMembers.companyId, ctx.companyId)), stats(ctx),
  ]);
  const pn = new Map(people.map((p) => [p.id, p.name])), dn = new Map(depts.map((d) => [d.id, d.name]));
  return ps.filter((p) => p.ownerMembershipId === ctx.membership.id || team.some((t) => t.projectId === p.id && t.membershipId === ctx.membership.id) || ctx.can('projects.view', { departmentId: p.departmentId })).map((p) => {
    const s = st.get(p.id) ?? { total: 0, done: 0, open: 0, overdue: 0 }; const h = projectHealth(p, s);
    return { id: p.id, name: p.name, description: p.description, status: p.status, startDate: p.startDate, deadline: p.deadline, ownerMembershipId: p.ownerMembershipId, ownerName: pn.get(p.ownerMembershipId) ?? '', departmentId: p.departmentId, departmentName: p.departmentId ? dn.get(p.departmentId) ?? null : null,
      goals: p.goals, deliverables: p.deliverables, teamSize: team.filter((t) => t.projectId === p.id).length + 1, tasks: s, health: h.health, progress: h.progress, deliverablesDone: p.deliverables.filter((d) => d.done).length };
  });
}

export async function getProject(ctx: Ctx, id: string) {
  const { p, member } = await load(ctx, id);
  const list = (await listProjects(ctx)).find((x) => x.id === id)!;
  const [team, tasks] = await Promise.all([
    ctx.db.select({ id: S.projectMembers.id, membershipId: S.projectMembers.membershipId, agentId: S.projectMembers.agentId, person: S.users.name, agent: S.aiAgents.name }).from(S.projectMembers)
      .leftJoin(S.companyMemberships, and(eq(S.companyMemberships.companyId, S.projectMembers.companyId), eq(S.companyMemberships.id, S.projectMembers.membershipId))).leftJoin(S.users, eq(S.users.id, S.companyMemberships.userId))
      .leftJoin(S.aiAgents, and(eq(S.aiAgents.companyId, S.projectMembers.companyId), eq(S.aiAgents.id, S.projectMembers.agentId))).where(and(eq(S.projectMembers.companyId, ctx.companyId), eq(S.projectMembers.projectId, id))),
    ctx.db.select({ id: S.tasks.id, title: S.tasks.title, status: S.tasks.status, priority: S.tasks.priority, dueDate: S.tasks.dueDate, ownerMembershipId: S.tasks.ownerMembershipId, ownerAgentId: S.tasks.ownerAgentId }).from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.projectId, id), isNull(S.tasks.archivedAt))).orderBy(asc(S.tasks.dueDate)),
  ]);
  return { project: list, team: team.map((t) => ({ id: t.id, kind: t.agentId ? 'ai' : 'human', membershipId: t.membershipId, agentId: t.agentId, name: t.person ?? t.agent ?? '' })), tasks, can: { edit: member || ctx.can('projects.edit', { departmentId: p.departmentId }) && true, assign: ctx.can('projects.assign', { departmentId: p.departmentId }), delete: ctx.can('projects.delete', { departmentId: p.departmentId }) } };
}

export async function updateProject(ctx: Ctx, id: string, i: Partial<ProjectInput>) {
  const { p } = await load(ctx, id);
  const isOwner = p.ownerMembershipId === ctx.membership.id;
  if (!isOwner && !ctx.can('projects.edit', { departmentId: p.departmentId })) throw forbidden();
  if ((i.ownerMembershipId && i.ownerMembershipId !== p.ownerMembershipId) || i.team) ctx.require('projects.assign', { departmentId: p.departmentId });
  await checkRefs(ctx, { name: p.name, ...i, startDate: i.startDate ?? p.startDate, deadline: i.deadline ?? p.deadline });
  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db; const set: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of ['name', 'description', 'departmentId', 'status', 'startDate', 'deadline', 'goals', 'ownerMembershipId'] as const) if (i[k] !== undefined) set[k] = i[k];
    if (i.deliverables) { const ex = new Map(p.deliverables.map((d) => [d.id, d])); set.deliverables = i.deliverables.map((d) => ({ id: d.id && ex.has(d.id) ? d.id : uid(), title: d.title, done: !!d.done })); }
    await db.update(S.projects).set(set).where(and(eq(S.projects.companyId, ctx.companyId), eq(S.projects.id, id)));
    if (i.team) {
      await db.delete(S.projectMembers).where(and(eq(S.projectMembers.companyId, ctx.companyId), eq(S.projectMembers.projectId, id)));
      const owner = i.ownerMembershipId ?? p.ownerMembershipId;
      const rows: any[] = [...new Set(i.team.membershipIds ?? [])].filter((m) => m !== owner).map((m) => ({ companyId: ctx.companyId, projectId: id, membershipId: m })).concat([...new Set(i.team.agentIds ?? [])].map((a) => ({ companyId: ctx.companyId, projectId: id, agentId: a })) as any);
      if (rows.length) await db.insert(S.projectMembers).values(rows);
    }
    await audit(db, ctx.companyId, ctx.user.id, 'project.updated', 'project', id, { name: p.name, fields: Object.keys(i) });
  });
}

export async function deleteProject(ctx: Ctx, id: string) {
  const { p } = await load(ctx, id);
  if (!(ctx.can('projects.delete', { departmentId: p.departmentId }) || (p.ownerMembershipId === ctx.membership.id && p.status === 'planning'))) throw forbidden();
  const [n] = await ctx.db.select({ n: sql<number>`count(*)` }).from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.projectId, id), isNull(S.tasks.archivedAt), sql`${S.tasks.status} not in ('completed','cancelled')`));
  if (Number(n.n) > 0) throw conflict(`This project still has ${n.n} open task(s). Complete or cancel them first.`);
  await ctx.db.update(S.projects).set({ archivedAt: new Date() }).where(and(eq(S.projects.companyId, ctx.companyId), eq(S.projects.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'project.deleted', 'project', id, { name: p.name });
}
