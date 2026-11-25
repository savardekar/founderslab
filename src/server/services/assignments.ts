import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { conflict, notFound } from '@/lib/errors';

const S = schema;
const active = (companyId: string) => and(eq(S.roleAssignments.companyId, companyId), isNull(S.roleAssignments.endedAt));

/** Operating mode follows who is assigned: nobody → vacant · people only → human · AI only → ai · both → hybrid. */
export async function recomputeMode(tx: Db, companyId: string, roleId: string) {
  const rows = await tx.select({ m: S.roleAssignments.membershipId, a: S.roleAssignments.agentId }).from(S.roleAssignments).where(and(active(companyId), eq(S.roleAssignments.roleId, roleId)));
  const h = rows.filter((r) => r.m).length, ai = rows.filter((r) => r.a).length;
  const mode = h && ai ? 'hybrid' : h ? 'human' : ai ? 'ai' : 'vacant';
  await tx.update(S.roles).set({ roleType: mode }).where(and(eq(S.roles.companyId, companyId), eq(S.roles.id, roleId)));
  return mode;
}

/** Exactly one active owner per role; promote the longest-serving person (humans first) if the owner left. */
export async function ensureOwner(tx: Db, companyId: string, roleId: string) {
  const rows = await tx.select().from(S.roleAssignments).where(and(active(companyId), eq(S.roleAssignments.roleId, roleId))).orderBy(asc(S.roleAssignments.startedAt));
  if (!rows.length || rows.some((r) => r.isPrimary)) return;
  const next = rows.find((r) => r.membershipId) ?? rows[0];
  await tx.update(S.roleAssignments).set({ isPrimary: true }).where(eq(S.roleAssignments.id, next.id));
}

export async function assignTx(tx: Db, companyId: string, roleId: string, target: { membershipId?: string; agentId?: string }, by: string | null) {
  const [role] = await tx.select().from(S.roles).where(and(eq(S.roles.companyId, companyId), eq(S.roles.id, roleId), isNull(S.roles.archivedAt))).limit(1);
  if (!role) throw notFound('Role not found');
  if (target.membershipId) {
    const [m] = await tx.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, companyId), eq(S.companyMemberships.id, target.membershipId), eq(S.companyMemberships.status, 'active'))).limit(1);
    if (!m) throw notFound('Member not found');
  } else if (target.agentId) {
    const [a] = await tx.select({ id: S.aiAgents.id }).from(S.aiAgents).where(and(eq(S.aiAgents.companyId, companyId), eq(S.aiAgents.id, target.agentId), isNull(S.aiAgents.archivedAt))).limit(1);
    if (!a) throw notFound('AI employee not found');
  } else throw notFound('Nobody to assign');
  const same = target.membershipId ? eq(S.roleAssignments.membershipId, target.membershipId) : eq(S.roleAssignments.agentId, target.agentId!);
  const [dupe] = await tx.select({ id: S.roleAssignments.id }).from(S.roleAssignments).where(and(active(companyId), eq(S.roleAssignments.roleId, roleId), same)).limit(1);
  if (dupe) throw conflict('Already assigned to this role');
  const [owner] = await tx.select({ id: S.roleAssignments.id }).from(S.roleAssignments).where(and(active(companyId), eq(S.roleAssignments.roleId, roleId), eq(S.roleAssignments.isPrimary, true))).limit(1);
  const [a] = await tx.insert(S.roleAssignments).values({ companyId, roleId, membershipId: target.membershipId ?? null, agentId: target.agentId ?? null, assignedBy: by, isPrimary: !owner }).returning();
  if (target.agentId) { // the AI starts with all of the role's responsibilities; admins can narrow this per AI employee
    const rs = await tx.select({ id: S.roleResponsibilities.id }).from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, companyId), eq(S.roleResponsibilities.roleId, roleId), isNull(S.roleResponsibilities.archivedAt)));
    if (rs.length) await tx.insert(S.agentResponsibilities).values(rs.map((r) => ({ companyId, agentId: target.agentId!, responsibilityId: r.id }))).onConflictDoNothing();
  }
  const mode = await recomputeMode(tx, companyId, roleId);
  return { assignment: a, mode, role };
}

/** End every active assignment matching the filter, then repair mode + ownership of the affected roles. */
export async function endAssignmentsTx(tx: Db, companyId: string, f: { membershipId?: string; agentId?: string; roleId?: string; assignmentId?: string }) {
  const conds = [active(companyId)];
  if (f.membershipId) conds.push(eq(S.roleAssignments.membershipId, f.membershipId));
  if (f.agentId) conds.push(eq(S.roleAssignments.agentId, f.agentId));
  if (f.roleId) conds.push(eq(S.roleAssignments.roleId, f.roleId));
  if (f.assignmentId) conds.push(eq(S.roleAssignments.id, f.assignmentId));
  const ended = await tx.update(S.roleAssignments).set({ endedAt: new Date(), isPrimary: false }).where(and(...conds)).returning({ roleId: S.roleAssignments.roleId, m: S.roleAssignments.membershipId, a: S.roleAssignments.agentId });
  for (const e of ended) if (e.a) {
    const rs = await tx.select({ id: S.roleResponsibilities.id }).from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, companyId), eq(S.roleResponsibilities.roleId, e.roleId)));
    for (const r of rs) await tx.delete(S.agentResponsibilities).where(and(eq(S.agentResponsibilities.agentId, e.a), eq(S.agentResponsibilities.responsibilityId, r.id)));
  }
  for (const roleId of new Set(ended.map((e) => e.roleId))) { await ensureOwner(tx, companyId, roleId); await recomputeMode(tx, companyId, roleId); }
  return ended;
}

export async function setOwnerTx(tx: Db, companyId: string, roleId: string, assignmentId: string) {
  const [a] = await tx.select().from(S.roleAssignments).where(and(active(companyId), eq(S.roleAssignments.roleId, roleId), eq(S.roleAssignments.id, assignmentId))).limit(1);
  if (!a) throw notFound('Assignment not found');
  await tx.update(S.roleAssignments).set({ isPrimary: false }).where(and(active(companyId), eq(S.roleAssignments.roleId, roleId)));
  await tx.update(S.roleAssignments).set({ isPrimary: true }).where(eq(S.roleAssignments.id, assignmentId));
  return a;
}
void sql;
