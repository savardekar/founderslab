import { and, eq, inArray } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { ACTIONS, RESOURCES, isPermissionKey } from '@/lib/constants';
import { badRequest, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import { splitGrantable, type Ctx } from '../authz';
import { getRole } from './roles';

const S = schema;
export const catalog = () => ({ resources: RESOURCES, actions: ACTIONS });

export async function getRolePermissions(ctx: Ctx, roleId: string) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  ctx.require('permissions.view');
  const rows = await ctx.db.select().from(S.rolePermissions).where(and(eq(S.rolePermissions.companyId, ctx.companyId), eq(S.rolePermissions.roleId, roleId)));
  return { roleId: role.id, grants: rows.map((r) => ({ key: r.permissionKey, scope: r.scope })) };
}

/** Replace the full permission set of a role. Permissions are independent of hierarchy. */
export async function setRolePermissions(ctx: Ctx, roleId: string, grants: { key: string; scope: 'company' | 'department' | 'own' }[]) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  ctx.require('permissions.configure');
  const bad = grants.filter((g) => !isPermissionKey(g.key));
  if (bad.length) throw badRequest(`Unknown permission: ${bad[0].key}`);
  const unique = [...new Map(grants.map((g) => [g.key, g])).values()];
  const current = await ctx.db.select().from(S.rolePermissions).where(and(eq(S.rolePermissions.companyId, ctx.companyId), eq(S.rolePermissions.roleId, roleId)));
  const had = new Map(current.map((c) => [c.permissionKey, c.scope]));
  // Escalation guard applies to anything newly granted or widened; existing grants may stay.
  const added = unique.filter((g) => had.get(g.key) !== g.scope).map((g) => g.key);
  const { denied } = splitGrantable(ctx, added);
  if (denied.length) throw forbidden(`You cannot grant permissions you do not hold: ${denied.slice(0, 5).join(', ')}`);
  await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    await tx.delete(S.rolePermissions).where(and(eq(S.rolePermissions.companyId, ctx.companyId), eq(S.rolePermissions.roleId, roleId)));
    if (unique.length) await tx.insert(S.rolePermissions).values(unique.map((g) => ({ companyId: ctx.companyId, roleId, permissionKey: g.key, scope: g.scope })));
    const now = new Set(unique.map((g) => g.key));
    await audit(tx, ctx.companyId, ctx.user.id, 'role.permissions_changed', 'role', roleId, { name: role.name, granted: unique.filter((g) => had.get(g.key) !== g.scope).map((g) => `${g.key}:${g.scope}`), revoked: [...had.keys()].filter((k) => !now.has(k)) });
  });
  return { roleId, grants: unique };
}

async function targetMembership(ctx: Ctx, membershipId: string) {
  const [m] = await ctx.db.select().from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.id, membershipId), eq(S.companyMemberships.status, 'active'))).limit(1);
  if (!m) throw notFound('Member not found');
  return m;
}
export async function getMemberPermissions(ctx: Ctx, membershipId: string) {
  ctx.require('permissions.view');
  const m = await targetMembership(ctx, membershipId);
  const rows = await ctx.db.select().from(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, ctx.companyId), eq(S.membershipPermissions.membershipId, m.id)));
  return { membershipId: m.id, accessLevel: m.accessLevel, keys: rows.map((r) => r.permissionKey) };
}
/** Configurable direct grants (used for admins). The owner implicitly holds everything and cannot be edited. */
export async function setMemberPermissions(ctx: Ctx, membershipId: string, keys: string[]) {
  ctx.require('permissions.configure');
  const m = await targetMembership(ctx, membershipId);
  if (m.accessLevel === 'owner') throw badRequest('The owner always has full access');
  if (m.id === ctx.membership.id) throw forbidden('You cannot change your own permissions');
  if (keys.some((k) => !isPermissionKey(k))) throw badRequest('Unknown permission in list');
  const unique = [...new Set(keys)];
  const cur = await ctx.db.select().from(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, ctx.companyId), eq(S.membershipPermissions.membershipId, m.id)));
  const had = new Set(cur.map((c) => c.permissionKey));
  const { denied } = splitGrantable(ctx, unique.filter((k) => !had.has(k)));
  if (denied.length) throw forbidden(`You cannot grant permissions you do not hold: ${denied.slice(0, 5).join(', ')}`);
  await ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    await tx.delete(S.membershipPermissions).where(and(eq(S.membershipPermissions.companyId, ctx.companyId), eq(S.membershipPermissions.membershipId, m.id)));
    if (unique.length) await tx.insert(S.membershipPermissions).values(unique.map((k) => ({ companyId: ctx.companyId, membershipId: m.id, permissionKey: k, grantedBy: ctx.user.id })));
    await audit(tx, ctx.companyId, ctx.user.id, 'member.permissions_changed', 'membership', m.id, { granted: unique.filter((k) => !had.has(k)), revoked: [...had].filter((k) => !unique.includes(k)) });
  });
  return { membershipId: m.id, keys: unique };
}
