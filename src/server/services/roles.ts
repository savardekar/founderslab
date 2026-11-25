import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { isPermissionKey, type PermissionKey } from '@/lib/constants';
import { badRequest, conflict, forbidden, notFound } from '@/lib/errors';
import { GENERIC_ROLE_PERMISSIONS, ROLE_TEMPLATE_BY_KEY, parsePermission } from '@/lib/templates';
import { audit } from '../audit';
import { splitGrantable, type Ctx } from '../authz';

const S = schema;
type RoleRow = typeof S.roles.$inferSelect;
type Grant = { key: string; scope: 'company' | 'department' | 'own' };
export type RoleInput = {
  name: string; description?: string | null; departmentId?: string | null; reportsToRoleId?: string | null;
  roleType: RoleRow['roleType']; status?: RoleRow['status']; reportingFrequency: RoleRow['reportingFrequency'];
  hasApprovalAuthority: boolean; approvalLimit?: number | null; templateKey?: string | null; position?: number;
  responsibilities?: { title: string; description?: string | null; expectedOutcome?: string | null; priority: any; frequency: any; requiresApproval: boolean; ownerRoleId?: string | null }[];
  rules?: { kind: any; text: string }[];
  kpis?: { name: string; description?: string | null; target?: string | null; unit?: string | null; period: any; targetValue?: number | null; direction?: string; dataSource?: string; sensitivity?: string }[];
  permissions?: Grant[];
};

export const activeRoles = (companyId: string) => and(eq(S.roles.companyId, companyId), isNull(S.roles.archivedAt));

export async function getRole(db: Db, companyId: string, roleId: string): Promise<RoleRow> {
  const [r] = await db.select().from(S.roles).where(and(eq(S.roles.companyId, companyId), eq(S.roles.id, roleId), isNull(S.roles.archivedAt))).limit(1);
  if (!r) throw notFound('Role not found');
  return r;
}

async function assertDepartment(db: Db, companyId: string, departmentId: string | null | undefined) {
  if (!departmentId) return;
  const [d] = await db.select({ id: S.departments.id }).from(S.departments).where(and(eq(S.departments.companyId, companyId), eq(S.departments.id, departmentId), isNull(S.departments.archivedAt))).limit(1);
  if (!d) throw badRequest('Department not found');
}

/** All role ids in the subtree below `roleId` (used for cycle prevention). */
export async function descendantIds(db: Db, companyId: string, roleId: string): Promise<Set<string>> {
  const all = await db.select({ id: S.roles.id, p: S.roles.reportsToRoleId }).from(S.roles).where(activeRoles(companyId));
  const kids = new Map<string, string[]>();
  all.forEach((r) => r.p && kids.set(r.p, [...(kids.get(r.p) ?? []), r.id]));
  const out = new Set<string>(); const stack = [roleId];
  while (stack.length) for (const k of kids.get(stack.pop()!) ?? []) if (!out.has(k)) { out.add(k); stack.push(k); }
  return out;
}

async function nextPosition(db: Db, companyId: string, parentId: string | null) {
  const [r] = await db.select({ m: sql<number>`coalesce(max(${S.roles.position}), -1)` }).from(S.roles)
    .where(and(activeRoles(companyId), parentId ? eq(S.roles.reportsToRoleId, parentId) : isNull(S.roles.reportsToRoleId)));
  return Number(r.m) + 1;
}

/**
 * Creates a role with its responsibilities, rules, KPIs and permissions inside the caller's transaction.
 * `grantable` = the permission keys the actor may hand out ('all' for the owner / system). Defaults from a
 * template are silently clipped to it; explicitly requested grants beyond it are rejected by the caller.
 */
export async function createRoleTx(tx: Db, companyId: string, actorUserId: string | null, input: RoleInput, grantable: 'all' | Set<string>) {
  await assertDepartment(tx, companyId, input.departmentId);
  if (input.reportsToRoleId) await getRole(tx, companyId, input.reportsToRoleId);
  const tpl = input.templateKey ? ROLE_TEMPLATE_BY_KEY[input.templateKey] : undefined;
  if (input.templateKey && !tpl) throw badRequest('Unknown role template');
  const [role] = await tx.insert(S.roles).values({
    companyId, name: input.name, description: input.description ?? null, departmentId: input.departmentId ?? null,
    reportsToRoleId: input.reportsToRoleId ?? null, roleType: input.roleType, status: input.status ?? 'active',
    reportingFrequency: input.reportingFrequency, hasApprovalAuthority: input.hasApprovalAuthority,
    approvalLimit: input.approvalLimit == null ? null : String(input.approvalLimit),
    position: input.position ?? (await nextPosition(tx, companyId, input.reportsToRoleId ?? null)),
    templateKey: input.templateKey ?? null, createdBy: actorUserId,
  }).returning();

  const resp = input.responsibilities ?? tpl?.responsibilities.map((r) => ({ priority: 'medium', frequency: 'ongoing', requiresApproval: false, ...r })) ?? [];
  if (resp.length) await tx.insert(S.roleResponsibilities).values(resp.map((r, i) => ({
    companyId, roleId: role.id, title: r.title, description: r.description ?? null, expectedOutcome: r.expectedOutcome ?? null,
    priority: r.priority, frequency: r.frequency, requiresApproval: !!r.requiresApproval, ownerRoleId: null, position: i })));
  const rules = input.rules ?? tpl?.rules ?? [];
  if (rules.length) await tx.insert(S.roleRules).values(rules.map((r, i) => ({ companyId, roleId: role.id, kind: r.kind, text: r.text, position: i })));
  const kpis = input.kpis ?? tpl?.kpis.map((k) => ({ period: 'monthly', ...k })) ?? [];
  if (kpis.length) await tx.insert(S.roleKpis).values(kpis.map((k, i) => { const tv = (k as { targetValue?: number | null }).targetValue ?? (k.target && /^-?\d+(\.\d+)?$/.test(k.target) ? Number(k.target) : null); return { companyId, roleId: role.id, name: k.name, description: k.description ?? null, target: k.target ?? (tv == null ? null : String(tv)), targetValue: tv == null ? null : String(tv), unit: k.unit ?? null, period: k.period, reportingFrequency: k.period === 'none' ? 'monthly' : k.period, direction: k.direction ?? 'higher', dataSource: k.dataSource ?? 'manual', sensitivity: k.sensitivity ?? 'standard', position: i }; }));

  const wanted: Grant[] = input.permissions ?? (tpl?.permissions ?? GENERIC_ROLE_PERMISSIONS).map((k) => parsePermission(k));
  const valid = wanted.filter((g) => isPermissionKey(g.key));
  const keep = grantable === 'all' ? valid : valid.filter((g) => grantable.has(g.key));
  if (keep.length) await tx.insert(S.rolePermissions).values(keep.map((g) => ({ companyId, roleId: role.id, permissionKey: g.key, scope: g.scope })));
  return { role, clipped: valid.length - keep.length };
}

export async function createRole(ctx: Ctx, input: RoleInput) {
  ctx.require('roles.create');
  if (input.permissions?.length) {
    const unknown = input.permissions.find((g) => !isPermissionKey(g.key));
    if (unknown) throw badRequest(`Unknown permission: ${unknown.key}`);
    ctx.require('permissions.configure');
    const { denied } = splitGrantable(ctx, input.permissions.map((g) => g.key));
    if (denied.length) throw forbidden(`You cannot grant permissions you do not hold: ${denied.slice(0, 5).join(', ')}`);
  }
  return ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const grantable = ctx.isOwner ? 'all' : new Set(ctx.companyWideKeys());
    const { role, clipped } = await createRoleTx(tx, ctx.companyId, ctx.user.id, input, grantable);
    await audit(tx, ctx.companyId, ctx.user.id, 'role.created', 'role', role.id, { name: role.name, roleType: role.roleType, reportsTo: role.reportsToRoleId, template: role.templateKey, clippedPermissions: clipped });
    return role;
  });
}

export async function updateRole(ctx: Ctx, roleId: string, patch: Partial<Omit<RoleInput, 'responsibilities' | 'rules' | 'kpis' | 'permissions'>>) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  ctx.require('roles.edit', { departmentId: role.departmentId, roleId });
  if (patch.departmentId !== undefined) await assertDepartment(ctx.db, ctx.companyId, patch.departmentId);
  if (patch.reportsToRoleId !== undefined && patch.reportsToRoleId !== role.reportsToRoleId) return moveRole(ctx, roleId, { reportsToRoleId: patch.reportsToRoleId });
  const set: Partial<RoleRow> = { updatedAt: new Date() };
  for (const k of ['name', 'description', 'departmentId', 'roleType', 'status', 'reportingFrequency', 'hasApprovalAuthority'] as const)
    if (patch[k] !== undefined) (set as any)[k] = patch[k];
  if (patch.approvalLimit !== undefined) set.approvalLimit = patch.approvalLimit == null ? null : String(patch.approvalLimit);
  if (patch.roleType && patch.roleType !== role.roleType) {
    const a = (await assigneesByRole(ctx.db, ctx.companyId)).get(roleId) ?? [];
    const h = a.filter((x) => x.kind === 'human').length, ai = a.filter((x) => x.kind === 'ai').length;
    if ((patch.roleType === 'ai' && h) || (patch.roleType === 'human' && ai) || (patch.roleType === 'vacant' && (h || ai)))
      throw conflict('This role has people or AI employees assigned that do not fit that type. Unassign them first, or choose Hybrid.');
  }
  const [u] = await ctx.db.update(S.roles).set(set).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, roleId))).returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'role.updated', 'role', roleId, { changes: patch });
  return u;
}

/** Re-parent a role (and optionally position it among its siblings). History is preserved via the audit log. */
export async function moveRole(ctx: Ctx, roleId: string, input: { reportsToRoleId: string | null; position?: number }) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  ctx.require('roles.edit', { departmentId: role.departmentId, roleId });
  const newParent = input.reportsToRoleId;
  if (newParent) {
    if (newParent === roleId) throw badRequest('A role cannot report to itself');
    await getRole(ctx.db, ctx.companyId, newParent);
    if ((await descendantIds(ctx.db, ctx.companyId, roleId)).has(newParent)) throw badRequest('That would create a reporting loop: a role cannot report to one of its own reports');
  }
  return ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const siblings = await tx.select().from(S.roles)
      .where(and(activeRoles(ctx.companyId), newParent ? eq(S.roles.reportsToRoleId, newParent) : isNull(S.roles.reportsToRoleId)))
      .orderBy(asc(S.roles.position), asc(S.roles.name));
    const ordered = siblings.filter((s) => s.id !== roleId).map((s) => s.id);
    ordered.splice(Math.min(input.position ?? ordered.length, ordered.length), 0, roleId);
    await tx.update(S.roles).set({ reportsToRoleId: newParent, updatedAt: new Date() }).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, roleId)));
    for (let i = 0; i < ordered.length; i++) await tx.update(S.roles).set({ position: i }).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, ordered[i])));
    if (newParent !== role.reportsToRoleId)
      await audit(tx, ctx.companyId, ctx.user.id, 'role.manager_changed', 'role', roleId, { name: role.name, from: role.reportsToRoleId, to: newParent });
    return getRole(tx, ctx.companyId, roleId);
  });
}

/**
 * "Delete" archives the role: it disappears from the organisation but its history, responsibilities and
 * audit trail are kept. Direct reports move to `childrenTo` (default: the deleted role's own manager).
 */
export async function deleteRole(ctx: Ctx, roleId: string, childrenTo?: string | null) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  ctx.require('roles.delete', { departmentId: role.departmentId, roleId });
  const target = childrenTo === undefined ? role.reportsToRoleId : childrenTo;
  if (target) {
    if (target === roleId || (await descendantIds(ctx.db, ctx.companyId, roleId)).has(target)) throw badRequest('Choose a manager outside this role\'s own branch');
    await getRole(ctx.db, ctx.companyId, target);
  }
  return ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const kids = await tx.select({ id: S.roles.id }).from(S.roles).where(and(activeRoles(ctx.companyId), eq(S.roles.reportsToRoleId, roleId)));
    if (kids.length) await tx.update(S.roles).set({ reportsToRoleId: target ?? null, updatedAt: new Date() }).where(and(eq(S.roles.companyId, ctx.companyId), inArray(S.roles.id, kids.map((k) => k.id))));
    const released = await tx.update(S.roleResponsibilities).set({ ownerRoleId: null }).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), eq(S.roleResponsibilities.ownerRoleId, roleId))).returning({ id: S.roleResponsibilities.id });
    await tx.update(S.roleAssignments).set({ endedAt: new Date() }).where(and(eq(S.roleAssignments.companyId, ctx.companyId), eq(S.roleAssignments.roleId, roleId), isNull(S.roleAssignments.endedAt)));
    await tx.update(S.roles).set({ archivedAt: new Date(), status: 'inactive' }).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, roleId)));
    await audit(tx, ctx.companyId, ctx.user.id, 'role.deleted', 'role', roleId, { name: role.name, reportsMovedTo: target ?? null, movedReports: kids.map((k) => k.id), responsibilitiesReturnedFromThisRole: released.map((r) => r.id) });
    return { movedReports: kids.length, releasedResponsibilities: released.length };
  });
}

export async function duplicateRole(ctx: Ctx, roleId: string, name?: string) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  ctx.require('roles.create', { departmentId: role.departmentId });
  const [resp, rules, kpis, perms] = await Promise.all([
    ctx.db.select().from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), eq(S.roleResponsibilities.roleId, roleId), isNull(S.roleResponsibilities.archivedAt))).orderBy(asc(S.roleResponsibilities.position)),
    ctx.db.select().from(S.roleRules).where(and(eq(S.roleRules.companyId, ctx.companyId), eq(S.roleRules.roleId, roleId), isNull(S.roleRules.archivedAt))).orderBy(asc(S.roleRules.position)),
    ctx.db.select().from(S.roleKpis).where(and(eq(S.roleKpis.companyId, ctx.companyId), eq(S.roleKpis.roleId, roleId), isNull(S.roleKpis.archivedAt))).orderBy(asc(S.roleKpis.position)),
    ctx.db.select().from(S.rolePermissions).where(and(eq(S.rolePermissions.companyId, ctx.companyId), eq(S.rolePermissions.roleId, roleId))),
  ]);
  return ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const grantable = ctx.isOwner ? 'all' : new Set(ctx.companyWideKeys());
    const { role: copy, clipped } = await createRoleTx(tx, ctx.companyId, ctx.user.id, {
      name: name ?? `${role.name} (copy)`, description: role.description, departmentId: role.departmentId, reportsToRoleId: role.reportsToRoleId,
      roleType: 'vacant', status: role.status, reportingFrequency: role.reportingFrequency, hasApprovalAuthority: role.hasApprovalAuthority,
      approvalLimit: role.approvalLimit == null ? null : Number(role.approvalLimit), templateKey: role.templateKey, position: role.position + 1,
      responsibilities: resp.map((r) => ({ title: r.title, description: r.description, expectedOutcome: r.expectedOutcome, priority: r.priority, frequency: r.frequency, requiresApproval: r.requiresApproval })),
      rules: rules.map((r) => ({ kind: r.kind, text: r.text })),
      kpis: kpis.map((k) => ({ name: k.name, description: k.description, target: k.target, unit: k.unit, period: k.period })),
      permissions: perms.map((p) => ({ key: p.permissionKey, scope: p.scope })),
    }, grantable);
    await audit(tx, ctx.companyId, ctx.user.id, 'role.duplicated', 'role', copy.id, { from: roleId, clippedPermissions: clipped });
    return copy;
  });
}

// ───────────── reads ─────────────
export type Assignee = { assignmentId: string; kind: 'human' | 'ai'; membershipId: string | null; agentId: string | null; name: string; isOwner: boolean; status: string };
export async function assigneesByRole(db: Db, companyId: string) {
  const humans = await db.select({ roleId: S.roleAssignments.roleId, assignmentId: S.roleAssignments.id, membershipId: S.roleAssignments.membershipId, name: S.users.name, isOwner: S.roleAssignments.isPrimary, status: S.companyMemberships.status })
    .from(S.roleAssignments)
    .innerJoin(S.companyMemberships, and(eq(S.companyMemberships.companyId, S.roleAssignments.companyId), eq(S.companyMemberships.id, S.roleAssignments.membershipId)))
    .innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId))
    .where(and(eq(S.roleAssignments.companyId, companyId), isNull(S.roleAssignments.endedAt)));
  const ais = await db.select({ roleId: S.roleAssignments.roleId, assignmentId: S.roleAssignments.id, agentId: S.roleAssignments.agentId, name: S.aiAgents.name, isOwner: S.roleAssignments.isPrimary, status: S.aiAgents.status })
    .from(S.roleAssignments)
    .innerJoin(S.aiAgents, and(eq(S.aiAgents.companyId, S.roleAssignments.companyId), eq(S.aiAgents.id, S.roleAssignments.agentId)))
    .where(and(eq(S.roleAssignments.companyId, companyId), isNull(S.roleAssignments.endedAt)));
  const m = new Map<string, Assignee[]>();
  const add = (roleId: string, a: Assignee) => m.set(roleId, [...(m.get(roleId) ?? []), a]);
  humans.forEach((h) => add(h.roleId, { assignmentId: h.assignmentId, kind: 'human', membershipId: h.membershipId, agentId: null, name: h.name, isOwner: h.isOwner, status: h.status }));
  ais.forEach((a) => add(a.roleId, { assignmentId: a.assignmentId, kind: 'ai', membershipId: null, agentId: a.agentId, name: a.name, isOwner: a.isOwner, status: a.status }));
  return m;
}

/** Roles the caller may see, honouring department/own-scoped grants. */
export async function listRoles(ctx: Ctx) {
  const vis = ctx.visibility('roles.view');
  if (vis === 'none') throw forbidden();
  const [roles, depts, assignees, counts] = await Promise.all([
    ctx.db.select().from(S.roles).where(activeRoles(ctx.companyId)).orderBy(asc(S.roles.position), asc(S.roles.name)),
    ctx.db.select().from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), isNull(S.departments.archivedAt))),
    assigneesByRole(ctx.db, ctx.companyId),
    ctx.db.execute(sql`select role_id,
        (select count(*) from role_responsibilities r where r.company_id = ${ctx.companyId} and r.role_id = x.role_id and r.archived_at is null) as responsibilities,
        (select count(*) from role_kpis k where k.company_id = ${ctx.companyId} and k.role_id = x.role_id and k.archived_at is null) as kpis
      from (select distinct id as role_id from roles where company_id = ${ctx.companyId} and archived_at is null) x`),
  ]);
  const cnt = new Map<string, { responsibilities: number; kpis: number }>();
  for (const r of (counts as any).rows ?? counts) cnt.set(r.role_id, { responsibilities: Number(r.responsibilities), kpis: Number(r.kpis) });
  const dn = new Map(depts.map((d) => [d.id, d.name]));
  const nm = new Map(roles.map((r) => [r.id, r.name]));
  return roles
    .filter((r) => vis === 'all' || ctx.can('roles.view', { departmentId: r.departmentId, roleId: r.id }))
    .map((r) => ({
      id: r.id, name: r.name, description: r.description, departmentId: r.departmentId, departmentName: r.departmentId ? dn.get(r.departmentId) ?? null : null,
      reportsToRoleId: r.reportsToRoleId, reportsToName: r.reportsToRoleId ? nm.get(r.reportsToRoleId) ?? null : null,
      roleType: r.roleType, status: r.status, reportingFrequency: r.reportingFrequency, hasApprovalAuthority: r.hasApprovalAuthority, position: r.position,
      assignees: assignees.get(r.id) ?? [], responsibilityCount: cnt.get(r.id)?.responsibilities ?? 0, kpiCount: cnt.get(r.id)?.kpis ?? 0,
    }));
}

export async function orgTree(ctx: Ctx) {
  const list = await listRoles(ctx);
  const byId = new Map(list.map((r) => [r.id, { ...r, children: [] as any[] }]));
  const roots: any[] = [];
  for (const r of byId.values()) (r.reportsToRoleId && byId.get(r.reportsToRoleId) ? byId.get(r.reportsToRoleId)!.children : roots).push(r);
  return { roots };
}

export async function roleDetail(ctx: Ctx, roleId: string) {
  const role = await getRole(ctx.db, ctx.companyId, roleId);
  ctx.require('roles.view', { departmentId: role.departmentId, roleId });
  const list = await ctx.db.select().from(S.roles).where(activeRoles(ctx.companyId));
  const byId = new Map(list.map((r) => [r.id, r]));
  const ancestors: { id: string; name: string }[] = [];
  for (let p = role.reportsToRoleId; p && byId.has(p) && ancestors.length < 50; p = byId.get(p)!.reportsToRoleId) ancestors.unshift({ id: p, name: byId.get(p)!.name });
  const own = (cond: any) => and(eq(cond.companyId, ctx.companyId), eq(cond.roleId, roleId));
  const [resp, rules, kpis, perms, dept, assignees] = await Promise.all([
    ctx.db.select().from(S.roleResponsibilities).where(and(own(S.roleResponsibilities), isNull(S.roleResponsibilities.archivedAt))).orderBy(asc(S.roleResponsibilities.position)),
    ctx.db.select().from(S.roleRules).where(and(own(S.roleRules), isNull(S.roleRules.archivedAt))).orderBy(asc(S.roleRules.position)),
    ctx.db.select().from(S.roleKpis).where(and(own(S.roleKpis), isNull(S.roleKpis.archivedAt))).orderBy(asc(S.roleKpis.position)),
    ctx.can('permissions.view') || ctx.can('roles.view', { roleId, departmentId: role.departmentId }) ? ctx.db.select().from(S.rolePermissions).where(own(S.rolePermissions)) : Promise.resolve([]),
    role.departmentId ? ctx.db.select().from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), eq(S.departments.id, role.departmentId))).limit(1) : Promise.resolve([]),
    assigneesByRole(ctx.db, ctx.companyId),
  ]);
  const heldFromOthers = await ctx.db.select().from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), eq(S.roleResponsibilities.ownerRoleId, roleId), isNull(S.roleResponsibilities.archivedAt)));
  return {
    role: { ...role, approvalLimit: role.approvalLimit == null ? null : Number(role.approvalLimit) },
    department: dept[0] ? { id: dept[0].id, name: dept[0].name } : null,
    reportsTo: role.reportsToRoleId ? { id: role.reportsToRoleId, name: byId.get(role.reportsToRoleId)?.name ?? '' } : null,
    ancestors, directReports: list.filter((r) => r.reportsToRoleId === roleId).map((r) => ({ id: r.id, name: r.name })),
    responsibilities: resp.map((r) => ({ ...r, ownerRoleName: r.ownerRoleId ? byId.get(r.ownerRoleId)?.name ?? null : null })),
    responsibilitiesOwnedFromOtherRoles: heldFromOthers.map((r) => ({ id: r.id, title: r.title, fromRoleId: r.roleId, fromRoleName: byId.get(r.roleId)?.name ?? '' })),
    rules, kpis, permissions: perms, assignees: assignees.get(roleId) ?? [],
  };
}
