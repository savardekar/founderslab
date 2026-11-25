import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { ALL_PERMISSION_KEYS } from '@/lib/constants';
import { badRequest, forbidden } from '@/lib/errors';
import { NODE_STARTERS, ORG_TEMPLATE_BY_KEY, ROLE_TEMPLATE_BY_KEY } from '@/lib/templates';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { createRoleTx } from './roles';
import { ensureEmployeeTx } from './employees';

const S = schema;
type CompanyInput = Omit<typeof S.companies.$inferInsert, 'id' | 'createdBy' | 'createdAt' | 'updatedAt' | 'archivedAt' | 'orgTemplate'>;

async function ensureDepartment(tx: Db, companyId: string, name?: string | null) {
  if (!name) return null;
  const [d] = await tx.select().from(S.departments).where(and(eq(S.departments.companyId, companyId), isNull(S.departments.archivedAt), sql`lower(${S.departments.name}) = lower(${name})`)).limit(1);
  if (d) return d.id;
  const [n] = await tx.insert(S.departments).values({ companyId, name }).returning();
  return n.id;
}

/** Instantiates an organisation template (editable selection of nodes) as real departments + roles. */
export async function applyOrgTemplateTx(tx: Db, companyId: string, actorUserId: string, templateKey: string, includeKeys: string[] | null | undefined, mode: 'ai' | 'human' | 'hybrid', parentForRoots: string | null = null) {
  const tpl = ORG_TEMPLATE_BY_KEY[templateKey];
  if (!tpl) throw badRequest('Unknown organisation template');
  const include = includeKeys ? new Set(includeKeys) : null;
  const nodes = tpl.nodes;
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const kept = (k: string) => !include || include.has(k);
  const nearestKept = (parent: string | null): string | null => { while (parent && !kept(parent)) parent = byKey.get(parent)?.parent ?? null; return parent; };
  const created = new Map<string, string>();
  for (const n of nodes) { // nodes are listed parents-first
    if (!kept(n.key)) continue;
    const t = n.templateKey ? ROLE_TEMPLATE_BY_KEY[n.templateKey] : undefined;
    const name = n.name ?? t!.name;
    const parentKey = nearestKept(n.parent);
    const starters = !t ? NODE_STARTERS[name] : undefined;
    const { role } = await createRoleTx(tx, companyId, actorUserId, {
      name, description: t?.description ?? `${name} role.`, departmentId: await ensureDepartment(tx, companyId, n.department ?? t?.department),
      reportsToRoleId: parentKey ? created.get(parentKey) ?? null : parentForRoots,
      roleType: n.roleType ?? (mode === 'ai' ? 'ai' : mode === 'hybrid' ? 'hybrid' : 'vacant'),
      reportingFrequency: t?.reportingFrequency ?? 'weekly', hasApprovalAuthority: t?.hasApprovalAuthority ?? false, templateKey: n.templateKey ?? null,
      responsibilities: starters?.map((s) => ({ ...s, priority: 'medium', frequency: 'ongoing', requiresApproval: false })),
    }, 'all');
    created.set(n.key, role.id);
  }
  return [...created.values()];
}

export async function createCompany(db: Db, user: { id: string }, input: CompanyInput & { orgTemplate?: string | null; includeNodeKeys?: string[] | null }) {
  const { orgTemplate, includeNodeKeys, ...fields } = input;
  return db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const [c] = await tx.insert(S.companies).values({ ...fields, orgTemplate: orgTemplate ?? null, createdBy: user.id }).returning();
    const [m] = await tx.insert(S.companyMemberships).values({ companyId: c.id, userId: user.id, accessLevel: 'owner', jobTitle: 'Founder' }).returning();
    await ensureEmployeeTx(tx, c.id, m.id, {}, true);
    let roleIds: string[] = [];
    if (orgTemplate) roleIds = await applyOrgTemplateTx(tx, c.id, user.id, orgTemplate, includeNodeKeys, c.workforceMode);
    await audit(tx, c.id, user.id, 'company.created', 'company', c.id, { name: c.name, orgTemplate: orgTemplate ?? null, rolesCreated: roleIds.length });
    return { company: c, membershipId: m.id, rolesCreated: roleIds.length };
  });
}

export async function applyOrgTemplate(ctx: Ctx, templateKey: string, includeKeys?: string[] | null) {
  ctx.require('roles.create'); ctx.require('departments.create');
  const [c] = await ctx.db.select({ m: S.companies.workforceMode }).from(S.companies).where(eq(S.companies.id, ctx.companyId));
  return ctx.db.transaction(async (t) => {
    const tx = t as unknown as Db;
    const ids = await applyOrgTemplateTx(tx, ctx.companyId, ctx.user.id, templateKey, includeKeys, c.m);
    await audit(tx, ctx.companyId, ctx.user.id, 'company.org_template_applied', 'company', ctx.companyId, { templateKey, rolesCreated: ids.length });
    return { rolesCreated: ids.length };
  });
}

export async function listMyCompanies(db: Db, userId: string) {
  const rows = await db.select({ c: S.companies, m: S.companyMemberships }).from(S.companyMemberships)
    .innerJoin(S.companies, eq(S.companies.id, S.companyMemberships.companyId))
    .where(and(eq(S.companyMemberships.userId, userId), eq(S.companyMemberships.status, 'active'), isNull(S.companies.archivedAt))).orderBy(asc(S.companies.name));
  return rows.map(({ c, m }) => ({ id: c.id, name: c.name, logoUrl: c.logoUrl, industry: c.industry, accessLevel: m.accessLevel }));
}

export async function getCompany(ctx: Ctx) {
  ctx.require('company.view');
  const [c] = await ctx.db.select().from(S.companies).where(eq(S.companies.id, ctx.companyId));
  return { company: c, me: { membershipId: ctx.membership.id, accessLevel: ctx.membership.accessLevel, jobTitle: ctx.membership.jobTitle, userId: ctx.user.id }, permissions: ctx.isOwner ? ALL_PERMISSION_KEYS : ctx.allKeysForUi() };
}

export async function updateCompany(ctx: Ctx, patch: Partial<CompanyInput>) {
  ctx.require('company.edit');
  const [c] = await ctx.db.update(S.companies).set({ ...patch, updatedAt: new Date() }).where(eq(S.companies.id, ctx.companyId)).returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'company.updated', 'company', ctx.companyId, { fields: Object.keys(patch) });
  return c;
}

export async function dashboard(ctx: Ctx) {
  ctx.require('company.view');
  const out: Record<string, unknown> = {};
  const [c] = await ctx.db.select({ name: S.companies.name, stage: S.companies.stage, objectives: S.companies.objectives, workforceMode: S.companies.workforceMode }).from(S.companies).where(eq(S.companies.id, ctx.companyId));
  out.company = c;
  const mine = ctx.myRoleIds.size ? await ctx.db.select({ id: S.roles.id, name: S.roles.name, roleType: S.roles.roleType }).from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), inArray(S.roles.id, [...ctx.myRoleIds]))) : [];
  out.myRoles = mine;
  if (ctx.hasAny('roles.view') && ctx.visibility('roles.view') === 'all') {
    const roles = await ctx.db.select().from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), isNull(S.roles.archivedAt)));
    const [resp, kpis, asg] = await Promise.all([
      ctx.db.select({ roleId: S.roleResponsibilities.roleId }).from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), isNull(S.roleResponsibilities.archivedAt))),
      ctx.db.select({ roleId: S.roleKpis.roleId }).from(S.roleKpis).where(and(eq(S.roleKpis.companyId, ctx.companyId), isNull(S.roleKpis.archivedAt))),
      ctx.db.select({ roleId: S.roleAssignments.roleId }).from(S.roleAssignments).where(and(eq(S.roleAssignments.companyId, ctx.companyId), isNull(S.roleAssignments.endedAt))),
    ]);
    const hasResp = new Set(resp.map((r) => r.roleId)), hasKpi = new Set(kpis.map((r) => r.roleId)), staffed = new Set(asg.map((r) => r.roleId));
    out.roles = {
      total: roles.length, ai: roles.filter((r) => r.roleType === 'ai').length, human: roles.filter((r) => r.roleType === 'human').length,
      hybrid: roles.filter((r) => r.roleType === 'hybrid').length, vacant: roles.filter((r) => r.roleType === 'vacant').length,
    };
    out.checklist = {
      rolesWithoutResponsibilities: roles.filter((r) => !hasResp.has(r.id)).map((r) => ({ id: r.id, name: r.name })),
      rolesWithoutKpis: roles.filter((r) => !hasKpi.has(r.id)).map((r) => ({ id: r.id, name: r.name })),
      humanRolesWithoutPerson: roles.filter((r) => (r.roleType === 'human' || r.roleType === 'hybrid') && !staffed.has(r.id)).map((r) => ({ id: r.id, name: r.name })),
      topLevelRoles: roles.filter((r) => !r.reportsToRoleId).length,
    };
    out.responsibilities = resp.length;
  }
  if (ctx.hasAny('departments.view')) { const [d] = await ctx.db.select({ n: sql<number>`count(*)` }).from(S.departments).where(and(eq(S.departments.companyId, ctx.companyId), isNull(S.departments.archivedAt))); out.departments = Number(d.n); }
  if (ctx.hasAny('members.view')) {
    const [m] = await ctx.db.select({ n: sql<number>`count(*)` }).from(S.companyMemberships).where(and(eq(S.companyMemberships.companyId, ctx.companyId), eq(S.companyMemberships.status, 'active')));
    const [i] = await ctx.db.select({ n: sql<number>`count(*)` }).from(S.companyInvites).where(and(eq(S.companyInvites.companyId, ctx.companyId), isNull(S.companyInvites.acceptedAt), isNull(S.companyInvites.revokedAt), sql`${S.companyInvites.expiresAt} > now()`));
    out.members = Number(m.n); out.pendingInvites = Number(i.n);
  }
  if (ctx.hasAny('audit.view')) {
    out.recentActivity = await ctx.db.select({ id: S.auditLogs.id, action: S.auditLogs.action, resourceType: S.auditLogs.resourceType, metadata: S.auditLogs.metadata, createdAt: S.auditLogs.createdAt, actor: S.users.name })
      .from(S.auditLogs).leftJoin(S.users, eq(S.users.id, S.auditLogs.actorUserId)).where(eq(S.auditLogs.companyId, ctx.companyId)).orderBy(sql`${S.auditLogs.createdAt} desc`).limit(10);
  }
  return out;
}

export async function listAudit(ctx: Ctx, limit = 100, before?: string) {
  ctx.require('audit.view');
  const rows = await ctx.db.select({ id: S.auditLogs.id, action: S.auditLogs.action, resourceType: S.auditLogs.resourceType, resourceId: S.auditLogs.resourceId, metadata: S.auditLogs.metadata, createdAt: S.auditLogs.createdAt, actor: S.users.name })
    .from(S.auditLogs).leftJoin(S.users, eq(S.users.id, S.auditLogs.actorUserId))
    .where(before ? and(eq(S.auditLogs.companyId, ctx.companyId), sql`${S.auditLogs.createdAt} < ${new Date(before)}`) : eq(S.auditLogs.companyId, ctx.companyId))
    .orderBy(sql`${S.auditLogs.createdAt} desc`).limit(Math.min(limit, 200));
  return rows;
}
void forbidden;
