import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { badRequest, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { endAssignmentsTx } from './assignments';

const S = schema;
export const defaultOnboarding = (hasManager: boolean) => [
  { id: 'profile', title: 'Complete your profile', done: false },
  { id: 'roles', title: 'Review your role and responsibilities', done: false },
  { id: 'objectives', title: 'Read the company objectives', done: false },
  ...(hasManager ? [{ id: 'manager', title: 'Meet your manager', done: false }] : []),
];

export async function ensureEmployeeTx(tx: Db, companyId: string, membershipId: string, preset: { departmentId?: string | null; managerMembershipId?: string | null } = {}, owner = false) {
  const [e] = await tx.select().from(S.employees).where(and(eq(S.employees.companyId, companyId), eq(S.employees.membershipId, membershipId))).limit(1);
  const vals = { departmentId: preset.departmentId ?? null, managerMembershipId: preset.managerMembershipId ?? null, status: 'active' as const, deactivatedAt: null, onboarding: owner ? [] : defaultOnboarding(!!preset.managerMembershipId) };
  if (e) { await tx.update(S.employees).set({ ...vals, onboarding: e.onboarding.length ? e.onboarding : vals.onboarding, updatedAt: new Date() }).where(eq(S.employees.id, e.id)); return e.id; }
  const [n] = await tx.insert(S.employees).values({ companyId, membershipId, ...vals }).returning();
  return n.id;
}

async function rows(ctx: Ctx) {
  return ctx.db.select({ e: S.employees, m: S.companyMemberships, u: S.users, d: S.departments.name }).from(S.employees)
    .innerJoin(S.companyMemberships, and(eq(S.companyMemberships.companyId, S.employees.companyId), eq(S.companyMemberships.id, S.employees.membershipId)))
    .innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId))
    .leftJoin(S.departments, and(eq(S.departments.companyId, S.employees.companyId), eq(S.departments.id, S.employees.departmentId)))
    .where(and(eq(S.employees.companyId, ctx.companyId), sql`${S.companyMemberships.status} <> 'removed'`)).orderBy(asc(S.users.name));
}
async function rolesOf(ctx: Ctx) {
  return ctx.db.select({ membershipId: S.roleAssignments.membershipId, assignmentId: S.roleAssignments.id, roleId: S.roles.id, roleName: S.roles.name, isOwner: S.roleAssignments.isPrimary })
    .from(S.roleAssignments).innerJoin(S.roles, and(eq(S.roles.companyId, S.roleAssignments.companyId), eq(S.roles.id, S.roleAssignments.roleId)))
    .where(and(eq(S.roleAssignments.companyId, ctx.companyId), isNull(S.roleAssignments.endedAt), isNull(S.roles.archivedAt)));
}
const shape = (r: Awaited<ReturnType<typeof rows>>[number], names: Map<string, string>, roles: Awaited<ReturnType<typeof rolesOf>>) => ({
  membershipId: r.m.id, userId: r.u.id, name: r.u.name, email: r.u.email, accessLevel: r.m.accessLevel, jobTitle: r.m.jobTitle,
  status: r.e.status, departmentId: r.e.departmentId, departmentName: r.d, managerMembershipId: r.e.managerMembershipId, managerName: r.e.managerMembershipId ? names.get(r.e.managerMembershipId) ?? null : null,
  phone: r.e.phone, bio: r.e.bio, startDate: r.e.startDate, deactivatedAt: r.e.deactivatedAt,
  roles: roles.filter((x) => x.membershipId === r.m.id).map((x) => ({ assignmentId: x.assignmentId, roleId: x.roleId, roleName: x.roleName, isOwner: x.isOwner })),
});

export async function listEmployees(ctx: Ctx) {
  ctx.require('members.view');
  const [rs, roles] = await Promise.all([rows(ctx), rolesOf(ctx)]);
  const names = new Map(rs.map((r) => [r.m.id, r.u.name]));
  return rs.map((r) => shape(r, names, roles));
}
export async function getEmployee(ctx: Ctx, membershipId: string) {
  ctx.require('members.view');
  const all = await listEmployees(ctx);
  const e = all.find((x) => x.membershipId === membershipId);
  if (!e) throw notFound('Employee not found');
  const [row] = await ctx.db.select({ onboarding: S.employees.onboarding }).from(S.employees).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, membershipId)));
  const direct = all.filter((x) => x.managerMembershipId === membershipId).map((x) => ({ membershipId: x.membershipId, name: x.name }));
  return { ...e, onboarding: row?.onboarding ?? [], directReports: direct };
}

/** Walks the manager chain upward; true if `target` appears (would create a reporting loop). */
async function managerChainHas(db: Db, companyId: string, start: string | null, target: string) {
  const seen = new Set<string>();
  for (let cur = start; cur && !seen.has(cur); ) { if (cur === target) return true; seen.add(cur); const [e] = await db.select({ m: S.employees.managerMembershipId }).from(S.employees).where(and(eq(S.employees.companyId, companyId), eq(S.employees.membershipId, cur))); cur = e?.m ?? null; }
  return false;
}

export async function updateEmployee(ctx: Ctx, membershipId: string, p: { jobTitle?: string | null; departmentId?: string | null; managerMembershipId?: string | null; phone?: string | null; bio?: string | null; status?: 'active' | 'on_leave' }) {
  ctx.require('members.edit');
  const [e] = await ctx.db.select().from(S.employees).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, membershipId))).limit(1);
  if (!e) throw notFound('Employee not found');
  if (e.status === 'inactive') throw badRequest('Reactivate this employee before editing');
  if (p.departmentId) { const [d] = await ctx.db.select({ id: S.departments.id }).from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, p.departmentId), isNull(S.departments.archivedAt))); if (!d) throw badRequest('Department not found'); }
  if (p.managerMembershipId) {
    if (p.managerMembershipId === membershipId) throw badRequest('Nobody can be their own manager');
    const [m] = await ctx.db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, p.managerMembershipId), eq(S.companyMemberships.status, 'active')));
    if (!m) throw badRequest('Manager must be an active employee');
    if (await managerChainHas(ctx.db, ctx.companyId, p.managerMembershipId, membershipId)) throw badRequest('That would create a reporting loop');
  }
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['departmentId', 'managerMembershipId', 'phone', 'bio', 'status'] as const) if (p[k] !== undefined) set[k] = p[k];
  await ctx.db.transaction(async (tx) => {
    await tx.update(S.employees).set(set).where(eq(S.employees.id, e.id));
    if (p.jobTitle !== undefined) await tx.update(S.companyMemberships).set({ jobTitle: p.jobTitle }).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, membershipId)));
    await audit(tx as unknown as Db, ctx.companyId, ctx.user.id, 'employee.updated', 'employee', e.id, { membershipId, changes: p });
  });
  return getEmployee(ctx, membershipId);
}

/** Deactivation suspends access at once and ends role assignments (roles become vacant / re-owned). Reactivation restores access, not assignments. */
export async function setEmployeeActive(ctx: Ctx, membershipId: string, active: boolean) {
  ctx.require('members.delete');
  const [m] = await ctx.db.select().from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, membershipId))).limit(1);
  if (!m || m.status === 'removed') throw notFound('Employee not found');
  if (m.accessLevel === 'owner') throw forbidden('The owner cannot be deactivated');
  if (m.id === ctx.membership.id) throw badRequest('You cannot deactivate yourself');
  return ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    if (active) {
      if (m.status === 'active') throw badRequest('Already active');
      await tx.update(S.companyMemberships).set({ status: 'active' }).where(eq(S.companyMemberships.id, m.id));
      await tx.update(S.employees).set({ status: 'active', deactivatedAt: null, deactivatedBy: null, updatedAt: new Date() }).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, m.id)));
      await audit(tx, ctx.companyId, ctx.user.id, 'employee.reactivated', 'employee', m.id);
      return { rolesVacated: 0 };
    }
    if (m.status !== 'active') throw badRequest('Already inactive');
    const ended = await endAssignmentsTx(tx, ctx.companyId, { membershipId: m.id });
    await tx.update(S.companyMemberships).set({ status: 'suspended' }).where(eq(S.companyMemberships.id, m.id));
    await tx.update(S.employees).set({ status: 'inactive', deactivatedAt: new Date(), deactivatedBy: ctx.user.id, updatedAt: new Date() }).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, m.id)));
    await audit(tx, ctx.companyId, ctx.user.id, 'employee.deactivated', 'employee', m.id, { rolesVacated: ended.map((e) => e.roleId) });
    return { rolesVacated: ended.length };
  });
}

// ───────────── self-service (no permission needed beyond membership) ─────────────
export async function myProfile(ctx: Ctx) {
  const [e] = await ctx.db.select().from(S.employees).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, ctx.membership.id)));
  return { profile: { name: ctx.user.name, email: ctx.user.email, jobTitle: ctx.membership.jobTitle, phone: e?.phone ?? null, bio: e?.bio ?? null, status: e?.status ?? 'active' }, onboarding: e?.onboarding ?? [] };
}
export async function updateMyProfile(ctx: Ctx, p: { phone?: string | null; bio?: string | null }) {
  await ctx.db.update(S.employees).set({ ...(p.phone !== undefined ? { phone: p.phone } : {}), ...(p.bio !== undefined ? { bio: p.bio } : {}), updatedAt: new Date() }).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, ctx.membership.id)));
  return myProfile(ctx);
}
export async function setMyOnboardingItem(ctx: Ctx, itemId: string, done: boolean) {
  const [e] = await ctx.db.select().from(S.employees).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, ctx.membership.id)));
  if (!e || !e.onboarding.some((i) => i.id === itemId)) throw notFound('Checklist item not found');
  await ctx.db.update(S.employees).set({ onboarding: e.onboarding.map((i) => (i.id === itemId ? { ...i, done } : i)) }).where(eq(S.employees.id, e.id));
  return myProfile(ctx);
}
