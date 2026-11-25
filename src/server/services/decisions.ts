import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { notify, ownerUserIds } from './notifications';
import { today } from './metrics';

const S = schema;
type D = typeof S.decisions.$inferSelect;
export type DecisionInput = { title: string; description?: string; reason?: string | null; alternatives?: { option: string; reason?: string }[]; expectedOutcome?: string | null; relatedRoleId?: string | null; relatedProjectId?: string | null; reviewDate?: string | null; decidedOn?: string | null; decisionMakerMembershipId?: string | null; confidential?: boolean; approve?: boolean };
const target = (d: Pick<D, 'relatedRoleId'>, roleDept: Map<string, string | null>) => ({ roleId: d.relatedRoleId, departmentId: d.relatedRoleId ? roleDept.get(d.relatedRoleId) ?? null : null });
async function roleDepts(db: Db, companyId: string) { return new Map((await db.select({ id: S.roles.id, d: S.roles.departmentId }).from(S.roles).where(eq(S.roles.companyId, companyId))).map((r) => [r.id, r.d])); }

async function checkRefs(db: Db, companyId: string, i: Partial<DecisionInput>) {
  if (i.relatedRoleId) { const [r] = await db.select({ id: S.roles.id }).from(S.roles).where(and(eq(S.roles.companyId, companyId), eq(S.roles.id, i.relatedRoleId), isNull(S.roles.archivedAt))); if (!r) throw badRequest('Role not found'); }
  if (i.relatedProjectId) { const [r] = await db.select({ id: S.projects.id }).from(S.projects).where(and(eq(S.projects.companyId, companyId), eq(S.projects.id, i.relatedProjectId), isNull(S.projects.archivedAt))); if (!r) throw badRequest('Project not found'); }
  if (i.decisionMakerMembershipId) { const [r] = await db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, companyId), eq(S.companyMemberships.id, i.decisionMakerMembershipId), eq(S.companyMemberships.status, 'active'))); if (!r) throw badRequest('The decision maker must be an active employee'); }
}
const canSee = (ctx: Ctx, d: D, rd: Map<string, string | null>) => ctx.isOwner || d.createdBy === ctx.user.id || d.decisionMakerMembershipId === ctx.membership.id || ctx.can('decisions.view', target(d, rd)) || ((d.status === 'approved' || d.status === 'superseded') && !d.confidential);

async function load(ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Decision not found');
  const [d] = await ctx.db.select().from(S.decisions).where(and(eq(S.decisions.companyId, ctx.companyId), eq(S.decisions.id, id), isNull(S.decisions.archivedAt)));
  const rd = await roleDepts(ctx.db, ctx.companyId);
  if (!d || !canSee(ctx, d, rd)) throw notFound('Decision not found');
  return { d, rd };
}

export async function createDecision(ctx: Ctx, i: DecisionInput) {
  const rd = await roleDepts(ctx.db, ctx.companyId); const tg = { roleId: i.relatedRoleId ?? null, departmentId: i.relatedRoleId ? rd.get(i.relatedRoleId) ?? null : null };
  ctx.require('decisions.create', tg); await checkRefs(ctx.db, ctx.companyId, i);
  if (i.approve) ctx.require('decisions.approve', tg);
  return ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    const [d] = await db.insert(S.decisions).values({ companyId: ctx.companyId, title: i.title, description: i.description ?? '', reason: i.reason ?? null, alternatives: i.alternatives ?? [], expectedOutcome: i.expectedOutcome ?? null, relatedRoleId: i.relatedRoleId ?? null, relatedProjectId: i.relatedProjectId ?? null, reviewDate: i.reviewDate ?? null, confidential: !!i.confidential, createdBy: ctx.user.id,
      ...(i.approve ? { status: 'approved' as const, decisionMakerMembershipId: i.decisionMakerMembershipId ?? ctx.membership.id, decidedOn: i.decidedOn ?? today(), approvedBy: ctx.user.id, approvedAt: new Date() } : { decisionMakerMembershipId: i.decisionMakerMembershipId ?? null, decidedOn: i.decidedOn ?? null }) }).returning();
    await audit(db, ctx.companyId, ctx.user.id, i.approve ? 'decision.approved' : 'decision.proposed', 'decision', d.id, { name: d.title });
    return d;
  });
}

export async function approveDecision(ctx: Ctx, id: string, p: { decisionMakerMembershipId?: string | null; decidedOn?: string | null } = {}) {
  const { d, rd } = await load(ctx, id); ctx.require('decisions.approve', target(d, rd));
  if (d.status !== 'proposed') throw conflict(`This decision is already ${d.status}`);
  if (d.createdBy === ctx.user.id && !ctx.isOwner) throw forbidden('You cannot approve your own proposal');
  await checkRefs(ctx.db, ctx.companyId, p);
  await ctx.db.transaction(async (tx) => {
    const db = tx as unknown as Db;
    await db.update(S.decisions).set({ status: 'approved', approvedBy: ctx.user.id, approvedAt: new Date(), decisionMakerMembershipId: p.decisionMakerMembershipId ?? d.decisionMakerMembershipId ?? ctx.membership.id, decidedOn: p.decidedOn ?? d.decidedOn ?? today(), updatedAt: new Date() }).where(and(eq(S.decisions.companyId, ctx.companyId), eq(S.decisions.id, id)));
    if (d.supersedesId) { await db.update(S.decisions).set({ status: 'superseded', updatedAt: new Date() }).where(and(eq(S.decisions.companyId, ctx.companyId), eq(S.decisions.id, d.supersedesId), eq(S.decisions.status, 'approved'))); await audit(db, ctx.companyId, ctx.user.id, 'decision.superseded', 'decision', d.supersedesId, { by: id }); }
    await audit(db, ctx.companyId, ctx.user.id, 'decision.approved', 'decision', id, { name: d.title, proposedByAi: !!d.createdByAgentId });
    if (d.createdBy && d.createdBy !== ctx.user.id) await notify(db, ctx.companyId, [d.createdBy], { kind: 'decision_approved', title: `Decision approved: ${d.title}`, link: `/c/${ctx.companyId}/decisions`, dedupeKey: `dec-ok:${id}` });
  });
}
export async function rejectDecision(ctx: Ctx, id: string, note: string) {
  const { d, rd } = await load(ctx, id); ctx.require('decisions.approve', target(d, rd));
  if (d.status !== 'proposed') throw conflict(`This decision is already ${d.status}`);
  await ctx.db.update(S.decisions).set({ status: 'rejected', outcomeNotes: note, updatedAt: new Date() }).where(and(eq(S.decisions.companyId, ctx.companyId), eq(S.decisions.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'decision.rejected', 'decision', id, { name: d.title });
}

/** Proposals can be edited; approved decisions cannot (they are superseded by a new decision or annotated with a review). */
export async function updateDecision(ctx: Ctx, id: string, p: Partial<DecisionInput>) {
  const { d, rd } = await load(ctx, id);
  if (d.status !== 'proposed') throw conflict('Approved decisions are preserved and cannot be edited. Supersede it with a new decision, or add a review note.');
  if (!(d.createdBy === ctx.user.id || ctx.can('decisions.edit', target(d, rd)))) throw forbidden();
  await checkRefs(ctx.db, ctx.companyId, p);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['title', 'description', 'reason', 'alternatives', 'expectedOutcome', 'relatedRoleId', 'relatedProjectId', 'reviewDate', 'decidedOn', 'decisionMakerMembershipId', 'confidential'] as const) if (p[k] !== undefined) set[k] = p[k];
  await ctx.db.update(S.decisions).set(set).where(and(eq(S.decisions.companyId, ctx.companyId), eq(S.decisions.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'decision.updated', 'decision', id, { name: d.title, fields: Object.keys(p) });
}
export async function addReview(ctx: Ctx, id: string, p: { outcomeNotes?: string | null; reviewDate?: string | null }) {
  const { d, rd } = await load(ctx, id); if (!ctx.can('decisions.edit', target(d, rd)) && d.decisionMakerMembershipId !== ctx.membership.id) throw forbidden();
  if (d.status !== 'approved') throw conflict('Only approved decisions are reviewed');
  const notes = p.outcomeNotes ? [d.outcomeNotes, `${today()} · ${ctx.user.name}: ${p.outcomeNotes}`].filter(Boolean).join('\n') : d.outcomeNotes;   // append-only
  await ctx.db.update(S.decisions).set({ outcomeNotes: notes, ...(p.reviewDate !== undefined ? { reviewDate: p.reviewDate } : {}), updatedAt: new Date() }).where(and(eq(S.decisions.companyId, ctx.companyId), eq(S.decisions.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'decision.reviewed', 'decision', id, { name: d.title });
}
export async function supersedeDecision(ctx: Ctx, id: string, i: DecisionInput) {
  const { d } = await load(ctx, id); if (d.status !== 'approved') throw conflict('Only an approved decision can be superseded');
  const created = await createDecision(ctx, { ...i, approve: false });
  await ctx.db.update(S.decisions).set({ supersedesId: id }).where(eq(S.decisions.id, created.id));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'decision.supersede_proposed', 'decision', created.id, { replaces: id });
  await notify(ctx.db, ctx.companyId, await ownerUserIds(ctx.db, ctx.companyId), { kind: 'decision_review', title: `Proposal to replace: ${d.title}`, link: `/c/${ctx.companyId}/decisions`, dedupeKey: `dec-sup:${created.id}` });
  return created;
}
export async function deleteDecision(ctx: Ctx, id: string) {
  const { d, rd } = await load(ctx, id);
  if (!['proposed', 'rejected'].includes(d.status)) throw conflict('Approved decisions are part of the company record and cannot be deleted');
  if (!(d.createdBy === ctx.user.id || ctx.can('decisions.delete', target(d, rd)))) throw forbidden();
  await ctx.db.update(S.decisions).set({ archivedAt: new Date() }).where(and(eq(S.decisions.companyId, ctx.companyId), eq(S.decisions.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'decision.deleted', 'decision', id, { name: d.title });
}

export async function listDecisions(ctx: Ctx, f: { status?: string; roleId?: string; projectId?: string; q?: string } = {}) {
  const rd = await roleDepts(ctx.db, ctx.companyId);
  const rows = await ctx.db.select().from(S.decisions).where(and(eq(S.decisions.companyId, ctx.companyId), isNull(S.decisions.archivedAt), f.status ? eq(S.decisions.status, f.status as D['status']) : undefined, f.roleId ? eq(S.decisions.relatedRoleId, f.roleId) : undefined, f.projectId ? eq(S.decisions.relatedProjectId, f.projectId) : undefined)).orderBy(desc(S.decisions.updatedAt)).limit(300);
  const [people, roles, projs, agents] = await Promise.all([ctx.db.select({ id: S.companyMemberships.id, n: S.users.name }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(eq(S.companyMemberships.companyId, ctx.companyId)), ctx.db.select({ id: S.roles.id, n: S.roles.name }).from(S.roles).where(eq(S.roles.companyId, ctx.companyId)), ctx.db.select({ id: S.projects.id, n: S.projects.name }).from(S.projects).where(eq(S.projects.companyId, ctx.companyId)), ctx.db.select({ id: S.aiAgents.id, n: S.aiAgents.name }).from(S.aiAgents).where(eq(S.aiAgents.companyId, ctx.companyId))]);
  const m = (a: { id: string; n: string }[]) => new Map(a.map((x) => [x.id, x.n])); const [pn, rn, jn, an] = [m(people), m(roles), m(projs), m(agents)]; const q = f.q?.toLowerCase();
  const t0 = today();
  return rows.filter((d) => canSee(ctx, d, rd) && (!q || (d.title + ' ' + d.description).toLowerCase().includes(q))).map((d) => ({
    id: d.id, title: d.title, description: d.description, status: d.status, decidedOn: d.decidedOn, reason: d.reason, alternatives: d.alternatives, expectedOutcome: d.expectedOutcome, outcomeNotes: d.outcomeNotes, reviewDate: d.reviewDate, reviewDue: d.status === 'approved' && !!d.reviewDate && d.reviewDate <= t0, confidential: d.confidential,
    decisionMakerMembershipId: d.decisionMakerMembershipId, decisionMaker: d.decisionMakerMembershipId ? pn.get(d.decisionMakerMembershipId) ?? null : null, relatedRoleId: d.relatedRoleId, relatedRole: d.relatedRoleId ? rn.get(d.relatedRoleId) ?? null : null, relatedProjectId: d.relatedProjectId, relatedProject: d.relatedProjectId ? jn.get(d.relatedProjectId) ?? null : null,
    supersedesId: d.supersedesId, proposedBy: d.createdByAgentId ? `◉ ${an.get(d.createdByAgentId) ?? 'AI'}` : d.createdBy ? 'person' : null, createdAt: d.createdAt, approvedAt: d.approvedAt,
    can: { approve: d.status === 'proposed' && ctx.can('decisions.approve', target(d, rd)) && (d.createdBy !== ctx.user.id || ctx.isOwner), edit: d.status === 'proposed' && (d.createdBy === ctx.user.id || ctx.can('decisions.edit', target(d, rd))), review: d.status === 'approved' && (ctx.can('decisions.edit', target(d, rd)) || d.decisionMakerMembershipId === ctx.membership.id), supersede: d.status === 'approved' && ctx.can('decisions.create', target(d, rd)) },
  }));
}
export async function getDecision(ctx: Ctx, id: string) { await load(ctx, id); return (await listDecisions(ctx)).find((d) => d.id === id)!; }

// ───────────── AI side ─────────────
/** Approved, non-confidential decisions an AI employee must respect: its own roles' and company-wide ones. */
export async function decisionsForAgent(db: Db, companyId: string, roleIds: string[], limit = 15) {
  const rows = await db.select().from(S.decisions).where(and(eq(S.decisions.companyId, companyId), isNull(S.decisions.archivedAt), eq(S.decisions.status, 'approved'), eq(S.decisions.confidential, false))).orderBy(desc(S.decisions.decidedOn));
  return rows.filter((d) => (d.relatedRoleId ? roleIds.includes(d.relatedRoleId) : !d.relatedProjectId)).slice(0, limit);
}
/** AI employees can only PROPOSE. They cannot approve, edit approved decisions, supersede, or delete. */
export async function proposeFromAgent(db: Db, companyId: string, agent: { id: string }, roleIds: string[], a: { title: string; description?: string; reason?: string; expectedOutcome?: string; relatedRoleId?: string }) {
  if (a.relatedRoleId && !roleIds.includes(a.relatedRoleId)) throw new Error('You can only relate a decision to a role you are assigned to');
  const [d] = await db.insert(S.decisions).values({ companyId, title: a.title.slice(0, 200), description: (a.description ?? '').slice(0, 5000), reason: a.reason?.slice(0, 2000) ?? null, expectedOutcome: a.expectedOutcome?.slice(0, 1000) ?? null, relatedRoleId: a.relatedRoleId ?? null, createdByAgentId: agent.id, status: 'proposed' }).returning();
  await audit(db, companyId, null, 'decision.ai_proposed', 'decision', d.id, { agentId: agent.id, name: d.title });
  await notify(db, companyId, await ownerUserIds(db, companyId), { kind: 'decision_review', title: `AI proposed a decision: ${d.title}`, link: `/c/${companyId}/decisions`, dedupeKey: `dec-ai:${d.id}` });
  return d;
}
