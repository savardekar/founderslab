import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { OPEN_STATUSES, TASK_STATUS_LABEL, TASK_TRANSITIONS, type TaskStatus } from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { notify, ownerUserIds, recipientsFor } from './notifications';
import { addDays, today } from './metrics';
import { touchOnboarding } from './onboarding';

const S = schema;
export type TaskRow = typeof S.tasks.$inferSelect;
type Owner = { membershipId?: string | null; agentId?: string | null };
type Actor = { userId?: string | null; agentId?: string | null };
export type TaskInput = {
  title: string; description?: string | null; departmentId?: string | null; roleId?: string | null; responsibilityId?: string | null; projectId?: string | null; parentTaskId?: string | null;
  owner: Owner; priority?: 'low' | 'medium' | 'high' | 'critical'; status?: 'backlog' | 'todo'; startDate?: string | null; dueDate?: string | null; estimatedHours?: number | null;
  requiresApproval?: boolean; deliverables?: string[]; dependsOn?: string[]; recurringId?: string | null;
};
const uid = () => globalThis.crypto.randomUUID();
const MAX_DEPTH = 3, MAX_ATTACH_BYTES = 2 * 1024 * 1024, MAX_ATTACH_PER_TASK = 10;

export async function logActivity(db: Db, companyId: string, taskId: string, actor: Actor, action: string, metadata: Record<string, unknown> = {}) {
  await db.insert(S.taskActivity).values({ companyId, taskId, actorUserId: actor.userId ?? null, actorAgentId: actor.agentId ?? null, action, metadata });
}

async function resolveOwner(db: Db, companyId: string, o: Owner) {
  if (!!o.membershipId === !!o.agentId) throw badRequest('A task needs exactly one owner: a person or an AI employee');
  if (o.membershipId) {
    const [m] = await db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, companyId), eq(S.companyMemberships.id, o.membershipId), eq(S.companyMemberships.status, 'active')));
    if (!m) throw badRequest('The owner must be an active employee');
  } else {
    const [a] = await db.select({ s: S.aiAgents.status }).from(S.aiAgents).where(and(eq(S.aiAgents.companyId, companyId), eq(S.aiAgents.id, o.agentId!), isNull(S.aiAgents.archivedAt)));
    if (!a) throw badRequest('AI employee not found');
    if (a.s !== 'active') throw badRequest('The AI employee must be active to own tasks');
  }
}

async function depthOf(db: Db, companyId: string, parentId: string | null) {
  let d = 0; let cur = parentId; const seen = new Set<string>();
  while (cur && !seen.has(cur)) { seen.add(cur); d++; const [p] = await db.select({ p: S.tasks.parentTaskId }).from(S.tasks).where(and(eq(S.tasks.companyId, companyId), eq(S.tasks.id, cur))); cur = p?.p ?? null; }
  return d;
}

/** Validates every reference and inserts the task. Authorisation is the caller's job. */
export async function insertTask(db: Db, companyId: string, actor: Actor, i: TaskInput): Promise<TaskRow> {
  await resolveOwner(db, companyId, i.owner);
  let { departmentId, roleId } = i; const responsibilityId = i.responsibilityId ?? null;
  if (responsibilityId) {
    const [r] = await db.select().from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, companyId), eq(S.roleResponsibilities.id, responsibilityId), isNull(S.roleResponsibilities.archivedAt)));
    if (!r) throw badRequest('Responsibility not found');
    if (roleId && roleId !== r.roleId) throw badRequest('That responsibility belongs to a different role');
    roleId = r.roleId;
  }
  if (roleId) {
    const [r] = await db.select().from(S.roles).where(and(eq(S.roles.companyId, companyId), eq(S.roles.id, roleId), isNull(S.roles.archivedAt)));
    if (!r) throw badRequest('Role not found');
    departmentId = departmentId ?? r.departmentId;
  }
  if (departmentId) { const [d] = await db.select({ id: S.departments.id }).from(S.departments).where(and(eq(S.departments.companyId, companyId), eq(S.departments.id, departmentId), isNull(S.departments.archivedAt))); if (!d) throw badRequest('Department not found'); }
  if (i.projectId) { const [p] = await db.select({ id: S.projects.id }).from(S.projects).where(and(eq(S.projects.companyId, companyId), eq(S.projects.id, i.projectId), isNull(S.projects.archivedAt))); if (!p) throw badRequest('Project not found'); }
  if (i.parentTaskId) {
    const [p] = await db.select({ id: S.tasks.id }).from(S.tasks).where(and(eq(S.tasks.companyId, companyId), eq(S.tasks.id, i.parentTaskId), isNull(S.tasks.archivedAt)));
    if (!p) throw badRequest('Parent task not found');
    if ((await depthOf(db, companyId, i.parentTaskId)) >= MAX_DEPTH) throw badRequest(`Subtasks can be nested at most ${MAX_DEPTH} levels deep`);
  }
  if (i.startDate && i.dueDate && i.dueDate < i.startDate) throw badRequest('The due date cannot be before the start date');
  const deps = [...new Set(i.dependsOn ?? [])];
  if (deps.length) { const f = await db.select({ id: S.tasks.id }).from(S.tasks).where(and(eq(S.tasks.companyId, companyId), inArray(S.tasks.id, deps), isNull(S.tasks.archivedAt))); if (f.length !== deps.length) throw badRequest('A dependency was not found'); }
  const [t] = await db.insert(S.tasks).values({
    companyId, title: i.title, description: i.description ?? null, departmentId: departmentId ?? null, roleId: roleId ?? null, responsibilityId, projectId: i.projectId ?? null, parentTaskId: i.parentTaskId ?? null,
    ownerMembershipId: i.owner.membershipId ?? null, ownerAgentId: i.owner.agentId ?? null, createdBy: actor.userId ?? null, createdByAgentId: actor.agentId ?? null,
    priority: i.priority ?? 'medium', status: i.status ?? 'todo', startDate: i.startDate ?? null, dueDate: i.dueDate ?? null, estimatedHours: i.estimatedHours == null ? null : String(i.estimatedHours),
    requiresApproval: !!i.requiresApproval, deliverables: (i.deliverables ?? []).map((title) => ({ id: uid(), title, done: false })), recurringId: i.recurringId ?? null,
  }).returning();
  if (deps.length) await db.insert(S.taskDependencies).values(deps.map((d) => ({ companyId, taskId: t.id, dependsOnTaskId: d })));
  await logActivity(db, companyId, t.id, actor, 'created', { owner: i.owner, dependsOn: deps });
  return t;
}

// ───────────── visibility & permissions ─────────────
async function myProjects(ctx: Ctx): Promise<Set<string>> {
  const a = await ctx.db.select({ id: S.projects.id }).from(S.projects).where(and(eq(S.projects.companyId, ctx.companyId), eq(S.projects.ownerMembershipId, ctx.membership.id), isNull(S.projects.archivedAt)));
  const b = await ctx.db.select({ id: S.projectMembers.projectId }).from(S.projectMembers).where(and(eq(S.projectMembers.companyId, ctx.companyId), eq(S.projectMembers.membershipId, ctx.membership.id)));
  return new Set([...a, ...b].map((x) => x.id));
}
const target = (t: Pick<TaskRow, 'departmentId' | 'roleId'>) => ({ departmentId: t.departmentId, roleId: t.roleId });
const isOwnerOf = (ctx: Ctx, t: TaskRow) => t.ownerMembershipId === ctx.membership.id;
const involved = (ctx: Ctx, t: TaskRow, mp: Set<string>) => isOwnerOf(ctx, t) || t.createdBy === ctx.user.id || (!!t.projectId && mp.has(t.projectId));
export const canViewTask = (ctx: Ctx, t: TaskRow, mp: Set<string>) => involved(ctx, t, mp) || ctx.can('tasks.view', target(t));

async function load(ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Task not found');
  const [t] = await ctx.db.select().from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.id, id), isNull(S.tasks.archivedAt))).limit(1);
  if (!t) throw notFound('Task not found');
  const mp = await myProjects(ctx);
  if (!canViewTask(ctx, t, mp)) throw notFound('Task not found'); // do not reveal tasks the caller cannot see
  return { t, mp };
}
const canEditText = (ctx: Ctx, t: TaskRow) => isOwnerOf(ctx, t) || t.createdBy === ctx.user.id || ctx.can('tasks.edit', target(t));

// ───────────── create / list / read ─────────────
export async function createTask(ctx: Ctx, i: TaskInput) {
  const owner: Owner = i.owner?.membershipId || i.owner?.agentId ? i.owner : { membershipId: ctx.membership.id };
  const input = { ...i, owner };
  const mine = owner.membershipId === ctx.membership.id;
  const tg = { departmentId: i.departmentId ?? null, roleId: i.roleId ?? null };
  if (mine && !ctx.can('tasks.create', tg)) {
    // self-service: anyone can plan their own work within their own roles and projects
    if (i.roleId && !ctx.myRoleIds.has(i.roleId)) throw forbidden();
    if (i.projectId && !(await myProjects(ctx)).has(i.projectId)) throw forbidden();
    if (i.requiresApproval) throw forbidden('Only people with tasks.create can require approval');
  } else {
    ctx.require('tasks.create', tg);
    if (!mine) ctx.require('tasks.assign', tg);
  }
  const created = await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const t = await insertTask(db, ctx.companyId, { userId: ctx.user.id }, input);
    await audit(db, ctx.companyId, ctx.user.id, 'task.created', 'task', t.id, { title: t.title, owner });
    if (!mine) await notify(db, ctx.companyId, await recipientsFor(db, ctx.companyId, owner), { kind: 'task_assigned', title: `New task: ${t.title}`, body: `${ctx.user.name} assigned you a task${t.dueDate ? `, due ${t.dueDate}` : ''}.`, link: `/c/${ctx.companyId}/tasks?task=${t.id}`, dedupeKey: `assigned:${t.id}:${owner.membershipId ?? owner.agentId}` });
    return t;
  });
  await touchOnboarding(ctx.db, ctx.companyId, owner.membershipId);
  return created;
}

export type TaskFilters = { status?: string[]; mine?: boolean; ownerMembershipId?: string; ownerAgentId?: string; departmentId?: string; roleId?: string; projectId?: string; parentTaskId?: string; topLevel?: boolean; overdue?: boolean; dueFrom?: string; dueTo?: string; q?: string };

export async function listTasks(ctx: Ctx, f: TaskFilters = {}) {
  await generateRecurring(ctx.db, ctx.companyId); // idempotent; a scheduled worker arrives in Phase 5
  const mp = await myProjects(ctx);
  const rows = await ctx.db.select().from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), isNull(S.tasks.archivedAt),
    f.status?.length ? inArray(S.tasks.status, f.status as TaskStatus[]) : undefined,
    f.mine ? eq(S.tasks.ownerMembershipId, ctx.membership.id) : undefined, f.ownerMembershipId ? eq(S.tasks.ownerMembershipId, f.ownerMembershipId) : undefined, f.ownerAgentId ? eq(S.tasks.ownerAgentId, f.ownerAgentId) : undefined,
    f.departmentId ? eq(S.tasks.departmentId, f.departmentId) : undefined, f.roleId ? eq(S.tasks.roleId, f.roleId) : undefined, f.projectId ? eq(S.tasks.projectId, f.projectId) : undefined,
    f.parentTaskId ? eq(S.tasks.parentTaskId, f.parentTaskId) : undefined, f.topLevel ? isNull(S.tasks.parentTaskId) : undefined,
    f.overdue ? and(sql`${S.tasks.dueDate} < ${today()}`, inArray(S.tasks.status, OPEN_STATUSES)) : undefined,
    f.dueFrom ? sql`${S.tasks.dueDate} >= ${f.dueFrom}` : undefined, f.dueTo ? sql`${S.tasks.dueDate} <= ${f.dueTo}` : undefined,
    f.q ? sql`${S.tasks.title} ilike ${'%' + f.q.replace(/[%_]/g, '') + '%'}` : undefined)).orderBy(asc(S.tasks.dueDate), desc(S.tasks.createdAt)).limit(600);
  const visible = rows.filter((t) => canViewTask(ctx, t, mp));
  const ids = visible.map((t) => t.id);
  const [people, agents, roles, depts, projs, deps, subs] = await Promise.all([
    ctx.db.select({ id: S.companyMemberships.id, name: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(eq(S.companyMemberships.companyId, ctx.companyId)),
    ctx.db.select({ id: S.aiAgents.id, name: S.aiAgents.name }).from(S.aiAgents).where(eq(S.aiAgents.companyId, ctx.companyId)),
    ctx.db.select({ id: S.roles.id, name: S.roles.name }).from(S.roles).where(eq(S.roles.companyId, ctx.companyId)),
    ctx.db.select({ id: S.departments.id, name: S.departments.name }).from(S.departments).where(eq(S.departments.companyId, ctx.companyId)),
    ctx.db.select({ id: S.projects.id, name: S.projects.name }).from(S.projects).where(eq(S.projects.companyId, ctx.companyId)),
    ids.length ? ctx.db.select({ taskId: S.taskDependencies.taskId, dep: S.tasks.status }).from(S.taskDependencies).innerJoin(S.tasks, and(eq(S.tasks.companyId, S.taskDependencies.companyId), eq(S.tasks.id, S.taskDependencies.dependsOnTaskId))).where(and(eq(S.taskDependencies.companyId, ctx.companyId), inArray(S.taskDependencies.taskId, ids))) : Promise.resolve([]),
    ctx.db.select({ parent: S.tasks.parentTaskId, status: S.tasks.status }).from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), isNull(S.tasks.archivedAt), sql`${S.tasks.parentTaskId} is not null`)),
  ]);
  const nm = (arr: { id: string; name: string }[]) => new Map(arr.map((x) => [x.id, x.name]));
  const [pn, an, rn, dn, jn] = [nm(people), nm(agents), nm(roles), nm(depts), nm(projs)];
  const t0 = today();
  return visible.map((t) => ({
    id: t.id, title: t.title, status: t.status, priority: t.priority, startDate: t.startDate, dueDate: t.dueDate, completedAt: t.completedAt, requiresApproval: t.requiresApproval, parentTaskId: t.parentTaskId,
    ownerKind: t.ownerAgentId ? 'ai' : 'human', ownerMembershipId: t.ownerMembershipId, ownerAgentId: t.ownerAgentId, ownerName: t.ownerAgentId ? an.get(t.ownerAgentId) ?? '' : pn.get(t.ownerMembershipId!) ?? '',
    departmentId: t.departmentId, departmentName: t.departmentId ? dn.get(t.departmentId) ?? null : null, roleId: t.roleId, roleName: t.roleId ? rn.get(t.roleId) ?? null : null,
    projectId: t.projectId, projectName: t.projectId ? jn.get(t.projectId) ?? null : null, responsibilityId: t.responsibilityId,
    overdue: !!t.dueDate && t.dueDate < t0 && (OPEN_STATUSES as string[]).includes(t.status),
    waitingOnDependencies: deps.filter((d) => d.taskId === t.id && d.dep !== 'completed').length,
    subtasks: { total: subs.filter((s) => s.parent === t.id && s.status !== 'cancelled').length, done: subs.filter((s) => s.parent === t.id && s.status === 'completed').length },
    mine: t.ownerMembershipId === ctx.membership.id,
  }));
}

export async function getTask(ctx: Ctx, id: string) {
  const { t, mp } = await load(ctx, id);
  const [rows, comments, attachments, activity, deps, dependents, subtasks, lookups] = await Promise.all([
    Promise.resolve(null),
    ctx.db.select({ id: S.taskComments.id, body: S.taskComments.body, createdAt: S.taskComments.createdAt, user: S.users.name, agent: S.aiAgents.name }).from(S.taskComments).leftJoin(S.users, eq(S.users.id, S.taskComments.authorUserId)).leftJoin(S.aiAgents, and(eq(S.aiAgents.companyId, S.taskComments.companyId), eq(S.aiAgents.id, S.taskComments.authorAgentId))).where(and(eq(S.taskComments.companyId, ctx.companyId), eq(S.taskComments.taskId, id))).orderBy(asc(S.taskComments.createdAt)),
    ctx.db.select({ id: S.taskAttachments.id, fileName: S.taskAttachments.fileName, contentType: S.taskAttachments.contentType, sizeBytes: S.taskAttachments.sizeBytes, sha256: S.taskAttachments.sha256, createdAt: S.taskAttachments.createdAt }).from(S.taskAttachments).where(and(eq(S.taskAttachments.companyId, ctx.companyId), eq(S.taskAttachments.taskId, id), isNull(S.taskAttachments.archivedAt))),
    ctx.db.select({ id: S.taskActivity.id, action: S.taskActivity.action, metadata: S.taskActivity.metadata, createdAt: S.taskActivity.createdAt, user: S.users.name, agent: S.aiAgents.name }).from(S.taskActivity).leftJoin(S.users, eq(S.users.id, S.taskActivity.actorUserId)).leftJoin(S.aiAgents, and(eq(S.aiAgents.companyId, S.taskActivity.companyId), eq(S.aiAgents.id, S.taskActivity.actorAgentId))).where(and(eq(S.taskActivity.companyId, ctx.companyId), eq(S.taskActivity.taskId, id))).orderBy(desc(S.taskActivity.createdAt)).limit(80),
    ctx.db.select({ id: S.tasks.id, title: S.tasks.title, status: S.tasks.status }).from(S.taskDependencies).innerJoin(S.tasks, and(eq(S.tasks.companyId, S.taskDependencies.companyId), eq(S.tasks.id, S.taskDependencies.dependsOnTaskId))).where(and(eq(S.taskDependencies.companyId, ctx.companyId), eq(S.taskDependencies.taskId, id))),
    ctx.db.select({ id: S.tasks.id, title: S.tasks.title, status: S.tasks.status }).from(S.taskDependencies).innerJoin(S.tasks, and(eq(S.tasks.companyId, S.taskDependencies.companyId), eq(S.tasks.id, S.taskDependencies.taskId))).where(and(eq(S.taskDependencies.companyId, ctx.companyId), eq(S.taskDependencies.dependsOnTaskId, id))),
    ctx.db.select({ id: S.tasks.id, title: S.tasks.title, status: S.tasks.status, ownerMembershipId: S.tasks.ownerMembershipId, dueDate: S.tasks.dueDate }).from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.parentTaskId, id), isNull(S.tasks.archivedAt))),
    listTasks(ctx, {}).then((l) => l.find((x) => x.id === id)),
  ]);
  void rows;
  const [resp] = t.responsibilityId ? await ctx.db.select({ title: S.roleResponsibilities.title }).from(S.roleResponsibilities).where(eq(S.roleResponsibilities.id, t.responsibilityId)) : [];
  const [creator] = t.createdBy ? await ctx.db.select({ name: S.users.name }).from(S.users).where(eq(S.users.id, t.createdBy)) : [];
  const [creatorAgent] = t.createdByAgentId ? await ctx.db.select({ name: S.aiAgents.name }).from(S.aiAgents).where(eq(S.aiAgents.id, t.createdByAgentId)) : [];
  const waiting = deps.filter((d) => d.status !== 'completed');
  const moves = TASK_TRANSITIONS[t.status].filter((s) => canMove(ctx, t, s).ok);
  return {
    task: { ...t, estimatedHours: t.estimatedHours == null ? null : Number(t.estimatedHours), actualHours: t.actualHours == null ? null : Number(t.actualHours) },
    view: lookups ?? null, responsibilityTitle: resp?.title ?? null, createdByName: creator?.name ?? (creatorAgent ? `◉ ${creatorAgent.name}` : null),
    dependencies: deps, dependents, waitingOn: waiting, subtasks, comments, attachments, activity,
    allowedMoves: moves, can: { editText: canEditText(ctx, t), editStructure: ctx.can('tasks.edit', target(t)), assign: ctx.can('tasks.assign', target(t)), approve: ctx.can('tasks.approve', target(t)) && (!isOwnerOf(ctx, t) || ctx.isOwner), delete: ctx.can('tasks.delete', target(t)) || (t.createdBy === ctx.user.id && ['backlog', 'todo'].includes(t.status)) },
    isMine: isOwnerOf(ctx, t), projectMember: !!t.projectId && mp.has(t.projectId),
  };
}

// ───────────── edit / assign / status ─────────────
export async function updateTask(ctx: Ctx, id: string, p: Partial<Omit<TaskInput, 'owner' | 'dependsOn' | 'deliverables'>> & { actualHours?: number | null; blockedReason?: string | null; deliverables?: { id?: string; title: string; done?: boolean }[] }) {
  const { t } = await load(ctx, id);
  if (!canEditText(ctx, t)) throw forbidden();
  if (t.status === 'completed' || t.status === 'cancelled') throw conflict('Reopen the task before editing it');
  const structure = ['departmentId', 'roleId', 'responsibilityId', 'projectId', 'requiresApproval'] as const;
  if (structure.some((k) => p[k] !== undefined && p[k] !== (t as any)[k])) ctx.require('tasks.edit', target(t));
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['title', 'description', 'priority', 'startDate', 'dueDate', 'departmentId', 'roleId', 'responsibilityId', 'projectId', 'requiresApproval'] as const) if (p[k] !== undefined) set[k] = p[k];
  if (p.estimatedHours !== undefined) set.estimatedHours = p.estimatedHours == null ? null : String(p.estimatedHours);
  if (p.actualHours !== undefined) set.actualHours = p.actualHours == null ? null : String(p.actualHours);
  if (p.deliverables) { const ex = new Map((t.deliverables ?? []).map((d) => [d.id, d])); set.deliverables = p.deliverables.map((d) => ({ id: d.id && ex.has(d.id) ? d.id : uid(), title: d.title, done: !!d.done })); }
  const start = (p.startDate !== undefined ? p.startDate : t.startDate), due = (p.dueDate !== undefined ? p.dueDate : t.dueDate);
  if (start && due && due < start) throw badRequest('The due date cannot be before the start date');
  if (p.roleId && p.roleId !== t.roleId) { const [r] = await ctx.db.select({ d: S.roles.departmentId }).from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, p.roleId), isNull(S.roles.archivedAt))); if (!r) throw badRequest('Role not found'); if (p.departmentId === undefined) set.departmentId = r.d; }
  const [u] = await ctx.db.update(S.tasks).set(set).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.id, id))).returning();
  await logActivity(ctx.db, ctx.companyId, id, { userId: ctx.user.id }, 'updated', { fields: Object.keys(p) });
  return u;
}

export async function assignTask(ctx: Ctx, id: string, owner: Owner) {
  try { return await assignTaskInner(ctx, id, owner); } finally { await touchOnboarding(ctx.db, ctx.companyId, owner.membershipId); }
}
async function assignTaskInner(ctx: Ctx, id: string, owner: Owner) {
  const { t } = await load(ctx, id);
  ctx.require('tasks.assign', target(t));
  if (t.status === 'completed' || t.status === 'cancelled') throw conflict('Reopen the task before reassigning it');
  await resolveOwner(ctx.db, ctx.companyId, owner);
  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    await db.update(S.tasks).set({ ownerMembershipId: owner.membershipId ?? null, ownerAgentId: owner.agentId ?? null, updatedAt: new Date() }).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.id, id)));
    await logActivity(db, ctx.companyId, id, { userId: ctx.user.id }, 'assigned', { from: { membershipId: t.ownerMembershipId, agentId: t.ownerAgentId }, to: owner });
    await audit(db, ctx.companyId, ctx.user.id, 'task.assigned', 'task', id, { title: t.title, to: owner });
    await notify(db, ctx.companyId, await recipientsFor(db, ctx.companyId, owner), { kind: 'task_assigned', title: `Task assigned to you: ${t.title}`, body: `${ctx.user.name} assigned this to you${t.dueDate ? `, due ${t.dueDate}` : ''}.`, link: `/c/${ctx.companyId}/tasks?task=${id}`, dedupeKey: `assigned:${id}:${owner.membershipId ?? owner.agentId}` });
  });
}

function canMove(ctx: Ctx, t: TaskRow, to: TaskStatus): { ok: boolean; why?: string } {
  if (!TASK_TRANSITIONS[t.status].includes(to)) return { ok: false, why: `A task cannot move from ${TASK_STATUS_LABEL[t.status]} to ${TASK_STATUS_LABEL[to]}` };
  const own = isOwnerOf(ctx, t) || ctx.can('tasks.edit', target(t));
  if (to === 'completed' && t.requiresApproval) {
    if (!ctx.can('tasks.approve', target(t))) return { ok: false, why: 'This task needs approval from someone with approval authority' };
    if (isOwnerOf(ctx, t) && !ctx.isOwner) return { ok: false, why: 'You cannot approve your own task' };
    return { ok: true };
  }
  if (t.status === 'awaiting_approval' && to === 'in_progress') return ctx.can('tasks.approve', target(t)) || own ? { ok: true } : { ok: false, why: 'Not allowed' };
  if (t.status === 'completed') return ctx.can('tasks.edit', target(t)) ? { ok: true } : { ok: false, why: 'Only someone with tasks.edit can reopen a completed task' };
  if (!own) return { ok: false, why: 'Only the owner or someone with tasks.edit can change this task\'s status' };
  if (to === 'awaiting_approval' && !t.requiresApproval) return { ok: false, why: 'This task does not require approval' };
  if (to === 'completed' && t.requiresApproval) return { ok: false, why: 'Needs approval' };
  return { ok: true };
}

export async function setTaskStatus(ctx: Ctx, id: string, to: TaskStatus, opts: { reason?: string | null; note?: string | null } = {}) {
  const { t } = await load(ctx, id);
  const m = canMove(ctx, t, to);
  if (!m.ok) { if (!TASK_TRANSITIONS[t.status].includes(to)) throw conflict(m.why!); throw forbidden(m.why); }
  if (to === 'blocked' && !opts.reason?.trim()) throw badRequest('Say what the task is blocked by');
  if (['in_progress', 'in_review', 'awaiting_approval', 'completed'].includes(to)) {
    const deps = await ctx.db.select({ title: S.tasks.title, status: S.tasks.status }).from(S.taskDependencies).innerJoin(S.tasks, and(eq(S.tasks.companyId, S.taskDependencies.companyId), eq(S.tasks.id, S.taskDependencies.dependsOnTaskId))).where(and(eq(S.taskDependencies.companyId, ctx.companyId), eq(S.taskDependencies.taskId, id)));
    const waiting = deps.filter((d) => d.status !== 'completed');
    if (waiting.length && !(t.status === 'awaiting_approval' && to === 'in_progress')) throw conflict(`Waiting on: ${waiting.map((w) => w.title).join(', ')}`);
  }
  if (to === 'completed' || to === 'awaiting_approval' || to === 'in_review') {
    const open = (t.deliverables ?? []).filter((d) => !d.done);
    if (open.length && to !== 'in_review') throw conflict(`Deliverables not done: ${open.map((d) => d.title).join(', ')}`);
  }
  if (to === 'completed') {
    const subs = await ctx.db.select({ title: S.tasks.title }).from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.parentTaskId, id), isNull(S.tasks.archivedAt), inArray(S.tasks.status, OPEN_STATUSES)));
    if (subs.length) throw conflict(`Finish or cancel the subtasks first: ${subs.map((s) => s.title).join(', ')}`);
  }
  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const set: Record<string, unknown> = { status: to, statusChangedAt: new Date(), updatedAt: new Date() };
    if (to === 'blocked') set.blockedReason = opts.reason!.trim(); else if (t.status === 'blocked') set.blockedReason = null;
    if (to === 'completed') { set.completedAt = new Date(); if (t.requiresApproval) set.approvedBy = ctx.user.id; } else if (t.status === 'completed') { set.completedAt = null; set.approvedBy = null; }
    await db.update(S.tasks).set(set).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.id, id)));
    await logActivity(db, ctx.companyId, id, { userId: ctx.user.id }, 'status_changed', { from: t.status, to, reason: opts.reason ?? null, note: opts.note ?? null });
    if (opts.note) await db.insert(S.taskComments).values({ companyId: ctx.companyId, taskId: id, authorUserId: ctx.user.id, body: opts.note });
    if (to === 'completed') await audit(db, ctx.companyId, ctx.user.id, 'task.completed', 'task', id, { title: t.title, approved: t.requiresApproval });
    const link = `/c/${ctx.companyId}/tasks?task=${id}`;
    const others = [...(t.createdBy && t.createdBy !== ctx.user.id ? [t.createdBy] : [])];
    if (to === 'awaiting_approval') await notify(db, ctx.companyId, [...others, ...(await ownerUserIds(db, ctx.companyId))].filter((u) => u !== ctx.user.id), { kind: 'approval_requested', title: `Approval requested: ${t.title}`, body: `${ctx.user.name} submitted this for approval.`, link, dedupeKey: `approval:${id}:${Date.now()}` });
    if (to === 'completed' || to === 'blocked') await notify(db, ctx.companyId, others, { kind: `task_${to}`, title: `${to === 'completed' ? 'Completed' : 'Blocked'}: ${t.title}`, body: to === 'blocked' ? opts.reason ?? null : null, link, dedupeKey: `${to}:${id}:${Date.now()}` });
    if (!isOwnerOf(ctx, t)) await notify(db, ctx.companyId, await recipientsFor(db, ctx.companyId, { membershipId: t.ownerMembershipId, agentId: t.ownerAgentId }), { kind: 'task_status', title: `${t.title} → ${TASK_STATUS_LABEL[to]}`, body: `Changed by ${ctx.user.name}.`, link, dedupeKey: `status:${id}:${Date.now()}` });
  });
}

export async function deleteTask(ctx: Ctx, id: string) {
  const { t } = await load(ctx, id);
  if (!(ctx.can('tasks.delete', target(t)) || (t.createdBy === ctx.user.id && ['backlog', 'todo'].includes(t.status)))) throw forbidden();
  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    await db.update(S.tasks).set({ archivedAt: new Date() }).where(and(eq(S.tasks.companyId, ctx.companyId), or(eq(S.tasks.id, id), eq(S.tasks.parentTaskId, id))));
    await logActivity(db, ctx.companyId, id, { userId: ctx.user.id }, 'deleted', {});
    await audit(db, ctx.companyId, ctx.user.id, 'task.deleted', 'task', id, { title: t.title });
  });
}

export async function setDependencies(ctx: Ctx, id: string, ids: string[]) {
  const { t } = await load(ctx, id);
  if (!canEditText(ctx, t)) throw forbidden();
  const want = [...new Set(ids)];
  if (want.includes(id)) throw badRequest('A task cannot depend on itself');
  const found = want.length ? await ctx.db.select({ id: S.tasks.id }).from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), inArray(S.tasks.id, want), isNull(S.tasks.archivedAt))) : [];
  if (found.length !== want.length) throw badRequest('A dependency was not found');
  const all = await ctx.db.select().from(S.taskDependencies).where(eq(S.taskDependencies.companyId, ctx.companyId));
  const g = new Map<string, string[]>(); all.filter((d) => d.taskId !== id).forEach((d) => g.set(d.taskId, [...(g.get(d.taskId) ?? []), d.dependsOnTaskId]));
  for (const w of want) { const seen = new Set<string>(); const st = [w]; while (st.length) { const c = st.pop()!; if (c === id) throw badRequest('That would create a circular dependency'); if (seen.has(c)) continue; seen.add(c); st.push(...(g.get(c) ?? [])); } }
  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    await db.delete(S.taskDependencies).where(and(eq(S.taskDependencies.companyId, ctx.companyId), eq(S.taskDependencies.taskId, id)));
    if (want.length) await db.insert(S.taskDependencies).values(want.map((d) => ({ companyId: ctx.companyId, taskId: id, dependsOnTaskId: d })));
    await logActivity(db, ctx.companyId, id, { userId: ctx.user.id }, 'dependencies_changed', { dependsOn: want });
  });
}

// ───────────── comments & attachments ─────────────
export async function addComment(ctx: Ctx, id: string, body: string) {
  const { t } = await load(ctx, id);
  const [c] = await ctx.db.insert(S.taskComments).values({ companyId: ctx.companyId, taskId: id, authorUserId: ctx.user.id, body }).returning();
  await logActivity(ctx.db, ctx.companyId, id, { userId: ctx.user.id }, 'commented', {});
  const to = [...(await recipientsFor(ctx.db, ctx.companyId, { membershipId: t.ownerMembershipId, agentId: t.ownerAgentId })), ...(t.createdBy ? [t.createdBy] : [])].filter((u) => u !== ctx.user.id);
  await notify(ctx.db, ctx.companyId, to, { kind: 'task_comment', title: `New comment on ${t.title}`, body: body.slice(0, 200), link: `/c/${ctx.companyId}/tasks?task=${id}`, dedupeKey: `comment:${c.id}` });
  return c;
}

const ALLOWED_TYPES: Record<string, string[]> = { pdf: ['application/pdf'], png: ['image/png'], jpg: ['image/jpeg'], jpeg: ['image/jpeg'], gif: ['image/gif'], webp: ['image/webp'], txt: ['text/plain'], csv: ['text/csv', 'text/plain'], md: ['text/markdown', 'text/plain'], docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'] };
export async function addAttachment(ctx: Ctx, id: string, a: { fileName: string; contentType: string; dataBase64: string }) {
  const { t } = await load(ctx, id);
  if (!canEditText(ctx, t)) throw forbidden();
  const name = a.fileName.replace(/[\\/\0\r\n"]/g, '_').replace(/^\.+/, '').trim().slice(0, 120) || 'file';
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (!ALLOWED_TYPES[ext]?.includes(a.contentType.toLowerCase())) throw badRequest('This file type is not allowed. Allowed: pdf, png, jpg, gif, webp, txt, csv, md, docx, xlsx, pptx');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(a.dataBase64)) throw badRequest('Invalid file data');
  const buf = Buffer.from(a.dataBase64, 'base64');
  if (buf.length === 0 || buf.length > MAX_ATTACH_BYTES) throw badRequest(`Files must be between 1 byte and ${MAX_ATTACH_BYTES / 1024 / 1024} MB`);
  const [n] = await ctx.db.select({ n: sql<number>`count(*)` }).from(S.taskAttachments).where(and(eq(S.taskAttachments.companyId, ctx.companyId), eq(S.taskAttachments.taskId, id), isNull(S.taskAttachments.archivedAt)));
  if (Number(n.n) >= MAX_ATTACH_PER_TASK) throw conflict(`A task can have at most ${MAX_ATTACH_PER_TASK} attachments`);
  const [row] = await ctx.db.insert(S.taskAttachments).values({ companyId: ctx.companyId, taskId: id, fileName: name, contentType: a.contentType.toLowerCase(), sizeBytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), dataBase64: a.dataBase64, uploadedBy: ctx.user.id }).returning({ id: S.taskAttachments.id, fileName: S.taskAttachments.fileName, sizeBytes: S.taskAttachments.sizeBytes, sha256: S.taskAttachments.sha256 });
  await logActivity(ctx.db, ctx.companyId, id, { userId: ctx.user.id }, 'attachment_added', { fileName: name });
  return row;
}
export async function downloadAttachment(ctx: Ctx, taskId: string, attId: string) {
  await load(ctx, taskId); // same visibility rule as the task itself
  const [a] = await ctx.db.select().from(S.taskAttachments).where(and(eq(S.taskAttachments.companyId, ctx.companyId), eq(S.taskAttachments.taskId, taskId), eq(S.taskAttachments.id, attId), isNull(S.taskAttachments.archivedAt)));
  if (!a) throw notFound('Attachment not found');
  return new Response(Buffer.from(a.dataBase64, 'base64'), { headers: { 'content-type': a.contentType, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.fileName)}`, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, no-store' } });
}
export async function deleteAttachment(ctx: Ctx, taskId: string, attId: string) {
  const { t } = await load(ctx, taskId);
  if (!canEditText(ctx, t)) throw forbidden();
  const r = await ctx.db.update(S.taskAttachments).set({ archivedAt: new Date() }).where(and(eq(S.taskAttachments.companyId, ctx.companyId), eq(S.taskAttachments.taskId, taskId), eq(S.taskAttachments.id, attId), isNull(S.taskAttachments.archivedAt))).returning({ id: S.taskAttachments.id });
  if (!r.length) throw notFound('Attachment not found');
  await logActivity(ctx.db, ctx.companyId, taskId, { userId: ctx.user.id }, 'attachment_removed', {});
}

// ───────────── recurring tasks ─────────────
export function nextOccurrence(day: string, cadence: string) {
  if (cadence === 'daily') return addDays(day, 1);
  if (cadence === 'weekly') return addDays(day, 7);
  const d = new Date(day + 'T00:00:00Z'); const dom = d.getUTCDate(); const add = cadence === 'quarterly' ? 3 : 1;
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + add, 1)); const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(dom, last)); return first.toISOString().slice(0, 10);
}
export type RecurringInput = { title: string; description?: string | null; departmentId?: string | null; roleId?: string | null; projectId?: string | null; owner?: Owner; priority?: 'low' | 'medium' | 'high' | 'critical'; cadence: 'daily' | 'weekly' | 'monthly' | 'quarterly'; dueAfterDays?: number; startOn?: string | null; endsOn?: string | null; requiresApproval?: boolean };

export async function createRecurring(ctx: Ctx, i: RecurringInput) {
  const owner: Owner = i.owner?.membershipId || i.owner?.agentId ? i.owner : { membershipId: ctx.membership.id };
  const tg = { departmentId: i.departmentId ?? null, roleId: i.roleId ?? null };
  ctx.require('tasks.create', tg); if (owner.membershipId !== ctx.membership.id) ctx.require('tasks.assign', tg);
  await resolveOwner(ctx.db, ctx.companyId, owner);
  if (i.roleId) { const [r] = await ctx.db.select({ id: S.roles.id }).from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, i.roleId), isNull(S.roles.archivedAt))); if (!r) throw badRequest('Role not found'); }
  const [r] = await ctx.db.insert(S.recurringTasks).values({ companyId: ctx.companyId, title: i.title, description: i.description ?? null, departmentId: i.departmentId ?? null, roleId: i.roleId ?? null, projectId: i.projectId ?? null, ownerMembershipId: owner.membershipId ?? null, ownerAgentId: owner.agentId ?? null, priority: i.priority ?? 'medium', cadence: i.cadence, dueAfterDays: i.dueAfterDays ?? 0, requiresApproval: !!i.requiresApproval, nextRunOn: i.startOn ?? today(), endsOn: i.endsOn ?? null, createdBy: ctx.user.id }).returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'recurring_task.created', 'recurring_task', r.id, { title: r.title, cadence: r.cadence });
  await generateRecurring(ctx.db, ctx.companyId);
  return r;
}
export async function listRecurring(ctx: Ctx) {
  if (!ctx.hasAny('tasks.view')) throw forbidden();
  return ctx.db.select().from(S.recurringTasks).where(eq(S.recurringTasks.companyId, ctx.companyId)).orderBy(asc(S.recurringTasks.nextRunOn));
}
export async function setRecurringActive(ctx: Ctx, id: string, active: boolean) {
  const [r] = await ctx.db.select().from(S.recurringTasks).where(and(eq(S.recurringTasks.companyId, ctx.companyId), eq(S.recurringTasks.id, id)));
  if (!r) throw notFound('Recurring task not found');
  ctx.require('tasks.edit', { departmentId: r.departmentId, roleId: r.roleId });
  await ctx.db.update(S.recurringTasks).set({ active }).where(eq(S.recurringTasks.id, id));
  await audit(ctx.db, ctx.companyId, ctx.user.id, active ? 'recurring_task.resumed' : 'recurring_task.paused', 'recurring_task', id, { title: r.title });
}

/** Creates the task instances that are due. Idempotent (unique recurring+start date); catches up at most 31 occurrences per template per call. */
export async function generateRecurring(db: Db, companyId: string, now = new Date()) {
  const t0 = today(now); let created = 0;
  const due = await db.select().from(S.recurringTasks).where(and(eq(S.recurringTasks.companyId, companyId), eq(S.recurringTasks.active, true), sql`${S.recurringTasks.nextRunOn} <= ${t0}`));
  for (const r of due) {
    let run = r.nextRunOn;
    for (let n = 0; n < 31 && run <= t0 && (!r.endsOn || run <= r.endsOn); n++) {
      try {
        await db.transaction(async (tx) => {
          const x = tx as unknown as Db;
          const exists = await x.select({ id: S.tasks.id }).from(S.tasks).where(and(eq(S.tasks.recurringId, r.id), eq(S.tasks.startDate, run))).limit(1);
          if (!exists.length) { await insertTask(x, companyId, { userId: r.createdBy }, { title: r.title, description: r.description, departmentId: r.departmentId, roleId: r.roleId, projectId: r.projectId, owner: { membershipId: r.ownerMembershipId, agentId: r.ownerAgentId }, priority: r.priority, startDate: run, dueDate: addDays(run, r.dueAfterDays), requiresApproval: r.requiresApproval, recurringId: r.id }); created++; }
        });
      } catch { /* owner inactive etc.: skip this occurrence, keep the schedule moving */ }
      run = nextOccurrence(run, r.cadence);
    }
    await db.update(S.recurringTasks).set({ nextRunOn: run, lastGeneratedAt: new Date(), active: !r.endsOn || run <= r.endsOn }).where(eq(S.recurringTasks.id, r.id));
  }
  return created;
}
