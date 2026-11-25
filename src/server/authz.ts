import { and, eq, isNull } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { BASELINE_MEMBER_PERMISSIONS, isPermissionKey } from '@/lib/constants';
import { forbidden, notFound } from '@/lib/errors';

type Scope = 'company' | 'department' | 'own';
export type Target = { departmentId?: string | null; roleId?: string | null };
export type SessionUser = { id: string; email: string; name: string };

/**
 * Authorisation context for ONE user inside ONE company. Built server-side from the session and the DB;
 * nothing in it is taken from the client except the company id, which is verified against active membership.
 * Hierarchy is deliberately NOT consulted: access comes only from owner status, explicit grants and role permissions.
 */
export class Ctx {
  constructor(
    public db: Db, public user: SessionUser, public companyId: string,
    public membership: { id: string; accessLevel: 'owner' | 'admin' | 'member'; jobTitle: string | null },
    private grants: Map<string, Set<Scope>>, public myDepartmentIds: Set<string>, public myRoleIds: Set<string>,
  ) {}
  get isOwner() { return this.membership.accessLevel === 'owner'; }
  /** True when permission is held with company-wide scope (or via a scoped grant matching `target`). */
  can(key: string, target?: Target): boolean {
    if (this.isOwner) return isPermissionKey(key);
    const s = this.grants.get(key);
    if (!s) return false;
    if (s.has('company')) return true;
    if (!target) return false;
    if (s.has('department') && target.departmentId && this.myDepartmentIds.has(target.departmentId)) return true;
    if (s.has('own') && target.roleId && this.myRoleIds.has(target.roleId)) return true;
    return false;
  }
  /** Which scopes a permission is held in (owner: all). */
  scopesOf(key: string): Set<Scope> { return this.isOwner ? new Set<Scope>(['company']) : new Set(this.grants.get(key) ?? []); }
  /** Held in any scope — used to decide whether to show/list something at all. */
  hasAny(key: string): boolean { return this.isOwner || (this.grants.get(key)?.size ?? 0) > 0; }
  require(key: string, target?: Target) { if (!this.can(key, target)) throw forbidden(); }
  /** For list endpoints: which rows may be returned. */
  visibility(key: string): 'all' | 'scoped' | 'none' {
    if (this.isOwner || this.grants.get(key)?.has('company')) return 'all';
    return this.hasAny(key) ? 'scoped' : 'none';
  }
  /** Permission keys held company-wide, for escalation checks and for the UI. */
  companyWideKeys(): string[] { return this.isOwner ? [] : [...this.grants].filter(([, s]) => s.has('company')).map(([k]) => k); }
  allKeysForUi(): string[] { return [...this.grants.keys()]; }
}

export async function loadCtx(db: Db, user: SessionUser, companyId: string): Promise<Ctx> {
  if (!/^[0-9a-f-]{36}$/i.test(companyId)) throw notFound('Company not found');
  const [m] = await db.select().from(schema.companyMemberships)
    .where(and(eq(schema.companyMemberships.companyId, companyId), eq(schema.companyMemberships.userId, user.id), eq(schema.companyMemberships.status, 'active'))).limit(1);
  // 404 (not 403) so company ids of other tenants cannot be probed
  if (!m) throw notFound('Company not found');

  const grants = new Map<string, Set<Scope>>();
  const add = (k: string, s: Scope) => { if (!grants.has(k)) grants.set(k, new Set()); grants.get(k)!.add(s); };
  BASELINE_MEMBER_PERMISSIONS.forEach((k) => add(k, 'company'));

  const direct = await db.select().from(schema.membershipPermissions)
    .where(and(eq(schema.membershipPermissions.companyId, companyId), eq(schema.membershipPermissions.membershipId, m.id)));
  direct.forEach((g) => add(g.permissionKey, 'company'));

  const mine = await db.select({ roleId: schema.roles.id, departmentId: schema.roles.departmentId })
    .from(schema.roleAssignments)
    .innerJoin(schema.roles, and(eq(schema.roles.companyId, schema.roleAssignments.companyId), eq(schema.roles.id, schema.roleAssignments.roleId)))
    .where(and(eq(schema.roleAssignments.companyId, companyId), eq(schema.roleAssignments.membershipId, m.id), isNull(schema.roleAssignments.endedAt), isNull(schema.roles.archivedAt), eq(schema.roles.status, 'active')));
  const roleIds = new Set(mine.map((r) => r.roleId));
  const deptIds = new Set(mine.map((r) => r.departmentId).filter((x): x is string => !!x));
  for (const rid of roleIds) {
    const rp = await db.select().from(schema.rolePermissions).where(and(eq(schema.rolePermissions.companyId, companyId), eq(schema.rolePermissions.roleId, rid)));
    rp.forEach((g) => add(g.permissionKey, g.scope));
  }
  return new Ctx(db, user, companyId, { id: m.id, accessLevel: m.accessLevel, jobTitle: m.jobTitle }, grants, deptIds, roleIds);
}

/** Escalation guard: you may only grant permissions you hold company-wide yourself (owner holds all). */
export function splitGrantable(ctx: Ctx, keys: string[]) {
  if (ctx.isOwner) return { ok: keys, denied: [] as string[] };
  const mine = new Set(ctx.companyWideKeys());
  return { ok: keys.filter((k) => mine.has(k)), denied: keys.filter((k) => !mine.has(k)) };
}
