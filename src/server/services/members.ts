import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { DEFAULT_ADMIN_PERMISSIONS } from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx, SessionUser } from '../authz';
import { appUrl, exposeDevLinks, sendMail } from '../mailer';
import { newToken, rateLimit, sha256 } from '../security';
import { getRole } from './roles';
import { assignTx, endAssignmentsTx, setOwnerTx } from './assignments';
import { ensureEmployeeTx } from './employees';
import { generateOnboardingChecklist } from './onboarding';

const S = schema;

export async function listMembers(ctx: Ctx) {
  ctx.require('members.view');
  const rows = await ctx.db.select({ m: S.companyMemberships, u: S.users }).from(S.companyMemberships)
    .innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId))
    .where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.status, 'active'))).orderBy(asc(S.users.name));
  const asg = await ctx.db.select({ id: S.roleAssignments.id, membershipId: S.roleAssignments.membershipId, roleId: S.roles.id, roleName: S.roles.name })
    .from(S.roleAssignments).innerJoin(S.roles, and(eq(S.roles.companyId, S.roleAssignments.companyId), eq(S.roles.id, S.roleAssignments.roleId)))
    .where(and(eq(S.roleAssignments.companyId, ctx.companyId), isNull(S.roleAssignments.endedAt), isNull(S.roles.archivedAt)));
  return rows.map(({ m, u }) => ({
    membershipId: m.id, userId: u.id, name: u.name, email: u.email, accessLevel: m.accessLevel, jobTitle: m.jobTitle, joinedAt: m.createdAt,
    roles: asg.filter((a) => a.membershipId === m.id).map((a) => ({ assignmentId: a.id, roleId: a.roleId, roleName: a.roleName })),
  }));
}

export async function listInvites(ctx: Ctx) {
  ctx.require('members.view');
  return ctx.db.select({ id: S.companyInvites.id, email: S.companyInvites.email, accessLevel: S.companyInvites.accessLevel, roleId: S.companyInvites.roleId, expiresAt: S.companyInvites.expiresAt, createdAt: S.companyInvites.createdAt })
    .from(S.companyInvites).where(and(eq(S.companyInvites.companyId, ctx.companyId), isNull(S.companyInvites.acceptedAt), isNull(S.companyInvites.revokedAt), gt(S.companyInvites.expiresAt, new Date()))).orderBy(sql`${S.companyInvites.createdAt} desc`);
}

export async function createInvite(ctx: Ctx, input: { email: string; accessLevel: 'admin' | 'member'; roleId?: string | null; roleIds?: string[]; departmentId?: string | null; managerMembershipId?: string | null; jobTitle?: string | null }) {
  ctx.require('members.create');
  rateLimit(`invite:${ctx.companyId}`, 30, 60 * 60_000);
  if (input.accessLevel === 'admin' && !ctx.isOwner) throw forbidden('Only the owner can invite admins');
  const roleIds = [...new Set([...(input.roleIds ?? []), ...(input.roleId ? [input.roleId] : [])])];
  for (const id of roleIds) { const r = await getRole(ctx.db, ctx.companyId, id); ctx.require('roles.assign', { departmentId: r.departmentId, roleId: r.id }); }
  if (input.departmentId) { const [d] = await ctx.db.select({ id: S.departments.id }).from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, input.departmentId), isNull(S.departments.archivedAt))); if (!d) throw badRequest('Department not found'); }
  if (input.managerMembershipId) { const [m] = await ctx.db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, input.managerMembershipId), eq(S.companyMemberships.status, 'active'))); if (!m) throw badRequest('Manager must be an active employee'); }
  const [existing] = await ctx.db.select({ id: S.companyMemberships.id }).from(S.companyMemberships).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId))
    .where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.status, 'active'), eq(S.users.email, input.email))).limit(1);
  if (existing) throw conflict('This person is already a member of the company');
  await ctx.db.update(S.companyInvites).set({ revokedAt: new Date() }).where(and(eq(S.companyInvites.companyId, ctx.companyId), eq(S.companyInvites.email, input.email), isNull(S.companyInvites.acceptedAt), isNull(S.companyInvites.revokedAt)));
  const token = newToken();
  const profile = { departmentId: input.departmentId ?? null, managerMembershipId: input.managerMembershipId ?? null, jobTitle: input.jobTitle ?? null, roleIds };
  const [inv] = await ctx.db.insert(S.companyInvites).values({ companyId: ctx.companyId, email: input.email, accessLevel: input.accessLevel, roleId: roleIds[0] ?? null, profile, tokenHash: sha256(token), invitedBy: ctx.user.id, expiresAt: new Date(Date.now() + 7 * 864e5) }).returning();
  const [co] = await ctx.db.select({ name: S.companies.name }).from(S.companies).where(eq(S.companies.id, ctx.companyId));
  const link = `${appUrl()}/accept-invite?token=${token}`;
  const mail = await sendMail({ to: input.email, subject: `${ctx.user.name} invited you to ${co.name} on FoundersLab`, text: `Join ${co.name}: ${link}\nThis link expires in 7 days.` });
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'member.invited', 'invite', inv.id, { email: input.email, accessLevel: input.accessLevel, ...profile });
  return { id: inv.id, email: inv.email, emailDelivered: mail.delivered, ...(exposeDevLinks() ? { devLink: link } : {}) };
}

export async function revokeInvite(ctx: Ctx, id: string) {
  ctx.require('members.delete');
  const r = await ctx.db.update(S.companyInvites).set({ revokedAt: new Date() }).where(and(eq(S.companyInvites.companyId, ctx.companyId), eq(S.companyInvites.id, id), isNull(S.companyInvites.acceptedAt), isNull(S.companyInvites.revokedAt))).returning({ id: S.companyInvites.id });
  if (!r.length) throw notFound('Invite not found');
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'member.invite_revoked', 'invite', id);
}

/** Accept by token while signed in; the signed-in email must match the invited email. */
export async function acceptInvite(db: Db, user: SessionUser, token: string) {
  rateLimit(`accept:${user.id}`, 10, 15 * 60_000);
  const [inv] = await db.select().from(S.companyInvites).where(and(eq(S.companyInvites.tokenHash, sha256(token)), isNull(S.companyInvites.acceptedAt), isNull(S.companyInvites.revokedAt), gt(S.companyInvites.expiresAt, new Date()))).limit(1);
  if (!inv) throw badRequest('This invitation is invalid or has expired');
  if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw forbidden(`This invitation was sent to ${inv.email}. Sign in with that address.`);
  const result = await db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const [prev] = await tx.select().from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, inv.companyId), eq(S.companyMemberships.userId, user.id))).limit(1);
    if (prev?.status === 'active') throw conflict('You are already a member of this company');
    let membershipId: string;
    if (prev) { await tx.update(S.companyMemberships).set({ status: 'active', accessLevel: inv.accessLevel, removedAt: null }).where(eq(S.companyMemberships.id, prev.id)); membershipId = prev.id; }
    else { const [m] = await tx.insert(S.companyMemberships).values({ companyId: inv.companyId, userId: user.id, accessLevel: inv.accessLevel }).returning(); membershipId = m.id; }
    await tx.delete(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, inv.companyId), eq(S.membershipPermissions.membershipId, membershipId)));
    if (inv.accessLevel === 'admin') await tx.insert(S.membershipPermissions).values(DEFAULT_ADMIN_PERMISSIONS.map((k) => ({ companyId: inv.companyId, membershipId, permissionKey: k, grantedBy: inv.invitedBy })));
    const pf = inv.profile ?? {};
    await ensureEmployeeTx(tx, inv.companyId, membershipId, pf);
    if (pf.jobTitle) await tx.update(S.companyMemberships).set({ jobTitle: pf.jobTitle }).where(eq(S.companyMemberships.id, membershipId));
    for (const rid of pf.roleIds ?? (inv.roleId ? [inv.roleId] : [])) { try { await assignTx(tx, inv.companyId, rid, { membershipId }, inv.invitedBy); } catch { /* role archived since the invite was sent */ } }
    await tx.update(S.companyInvites).set({ acceptedAt: new Date() }).where(eq(S.companyInvites.id, inv.id));
    await audit(tx, inv.companyId, user.id, 'member.joined', 'membership', membershipId, { accessLevel: inv.accessLevel, roleIds: inv.profile?.roleIds ?? [] });
    return { companyId: inv.companyId, membershipId };
  });
  try { await generateOnboardingChecklist(db, inv.companyId, result.membershipId); } catch { /* the checklist is a convenience; joining must not fail because of it */ }
  return { companyId: result.companyId };
}

export async function updateMember(ctx: Ctx, membershipId: string, patch: { accessLevel?: 'admin' | 'member'; jobTitle?: string | null }) {
  ctx.require('members.edit');
  const [m] = await ctx.db.select().from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, membershipId), eq(S.companyMemberships.status, 'active'))).limit(1);
  if (!m) throw notFound('Member not found');
  if (m.accessLevel === 'owner') throw forbidden('The owner cannot be modified');
  if (patch.accessLevel && patch.accessLevel !== m.accessLevel) {
    if (!ctx.isOwner) throw forbidden('Only the owner can change access levels');
    return ctx.db.transaction(async (t) => {
      const tx = t as unknown as Db;
      await tx.delete(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, ctx.companyId), eq(S.membershipPermissions.membershipId, m.id)));
      if (patch.accessLevel === 'admin') await tx.insert(S.membershipPermissions).values(DEFAULT_ADMIN_PERMISSIONS.map((k) => ({ companyId: ctx.companyId, membershipId: m.id, permissionKey: k, grantedBy: ctx.user.id })));
      await tx.update(S.companyMemberships).set({ accessLevel: patch.accessLevel!, ...(patch.jobTitle !== undefined ? { jobTitle: patch.jobTitle } : {}) }).where(eq(S.companyMemberships.id, m.id));
      await audit(tx, ctx.companyId, ctx.user.id, 'member.access_level_changed', 'membership', m.id, { from: m.accessLevel, to: patch.accessLevel });
      return { ok: true };
    });
  }
  if (patch.jobTitle !== undefined) await ctx.db.update(S.companyMemberships).set({ jobTitle: patch.jobTitle }).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, m.id)));
  return { ok: true };
}

/** Revokes access immediately. Work records stay; role assignments are ended, not deleted. (Handover tooling arrives in Phase 4.) */
export async function removeMember(ctx: Ctx, membershipId: string) {
  ctx.require('members.delete');
  const [m] = await ctx.db.select().from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, membershipId), sql`${S.companyMemberships.status} <> 'removed'`)).limit(1);
  if (!m) throw notFound('Member not found');
  if (m.accessLevel === 'owner') throw forbidden('The owner cannot be removed');
  if (m.id === ctx.membership.id) throw badRequest('You cannot remove yourself');
  return ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const ended = await endAssignmentsTx(tx, ctx.companyId, { membershipId: m.id });
    await tx.delete(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, ctx.companyId), eq(S.membershipPermissions.membershipId, m.id)));
    await tx.update(S.companyMemberships).set({ status: 'removed', removedAt: new Date() }).where(eq(S.companyMemberships.id, m.id));
    await tx.update(S.employees).set({ status: 'inactive', deactivatedAt: new Date(), deactivatedBy: ctx.user.id }).where(and(eq(S.employees.companyId, ctx.companyId), eq(S.employees.membershipId, m.id)));
    await audit(tx, ctx.companyId, ctx.user.id, 'member.removed', 'membership', m.id, { rolesVacated: ended.map((e) => e.roleId) });
    return { rolesVacated: ended.length };
  });
}

/** Assign a person (roles.assign) or an AI employee (agents.assign) to a role. Mode (human/ai/hybrid/vacant) follows automatically. */
export async function assignToRole(ctx: Ctx, roleId: string, target: { membershipId?: string; agentId?: string }) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  const t = { departmentId: role.departmentId, roleId };
  ctx.require(target.agentId ? 'agents.assign' : 'roles.assign', t);
  return ctx.db.transaction(async (tx) => {
    const r = await assignTx(tx as unknown as Db, ctx.companyId, roleId, target, ctx.user.id);
    await audit(tx as unknown as Db, ctx.companyId, ctx.user.id, target.agentId ? 'role.ai_assigned' : 'role.person_assigned', 'role', roleId, { ...target, role: role.name, mode: r.mode });
    return { assignment: r.assignment, mode: r.mode };
  }).then(async (res) => { if (target.membershipId) { try { await generateOnboardingChecklist(ctx.db, ctx.companyId, target.membershipId); } catch { /* non-critical */ } } return res; });
}
export async function unassignFromRole(ctx: Ctx, roleId: string, assignmentId: string) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  const [a] = await ctx.db.select().from(S.roleAssignments).where(and(eq(S.roleAssignments.companyId, ctx.companyId), eq(S.roleAssignments.roleId, roleId), eq(S.roleAssignments.id, assignmentId), isNull(S.roleAssignments.endedAt))).limit(1);
  if (!a) throw notFound('Assignment not found');
  ctx.require(a.agentId ? 'agents.assign' : 'roles.assign', { departmentId: role.departmentId, roleId });
  await ctx.db.transaction(async (tx) => {
    await endAssignmentsTx(tx as unknown as Db, ctx.companyId, { assignmentId });
    await audit(tx as unknown as Db, ctx.companyId, ctx.user.id, a.agentId ? 'role.ai_unassigned' : 'role.person_unassigned', 'role', roleId, { membershipId: a.membershipId, agentId: a.agentId, role: role.name });
  });
}
export async function setRoleOwner(ctx: Ctx, roleId: string, assignmentId: string) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  ctx.require('roles.assign', { departmentId: role.departmentId, roleId });
  await ctx.db.transaction(async (tx) => { await setOwnerTx(tx as unknown as Db, ctx.companyId, roleId, assignmentId); await audit(tx as unknown as Db, ctx.companyId, ctx.user.id, 'role.owner_changed', 'role', roleId, { assignmentId, role: role.name }); });
}

/** What the signed-in member may always see: their own roles and responsibilities (no permission needed). */
export async function myRoles(ctx: Ctx) {
  const ids = [...ctx.myRoleIds];
  const out = [];
  for (const id of ids) {
    const [r] = await ctx.db.select().from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, id))).limit(1);
    const resp = await ctx.db.select({ id: S.roleResponsibilities.id, title: S.roleResponsibilities.title, expectedOutcome: S.roleResponsibilities.expectedOutcome, priority: S.roleResponsibilities.priority, frequency: S.roleResponsibilities.frequency })
      .from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), eq(S.roleResponsibilities.roleId, id), isNull(S.roleResponsibilities.archivedAt))).orderBy(asc(S.roleResponsibilities.position));
    out.push({ id: r.id, name: r.name, description: r.description, roleType: r.roleType, responsibilities: resp });
  }
  return out;
}
