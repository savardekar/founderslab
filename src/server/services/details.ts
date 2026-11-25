import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { schema, type Db } from '@/db/client';
import { badRequest, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { getRole } from './roles';

const S = schema;
const roleScope = async (ctx: Ctx, roleId: string) => { const r = await getRole(ctx.db, ctx.companyId, roleId); return { role: r, target: { departmentId: r.departmentId, roleId } }; };
const nextPos = async (db: Db, table: any, companyId: string, roleId: string) => {
  const [r] = await db.select({ m: sql<number>`coalesce(max(${table.position}), -1)` }).from(table).where(and(eq(table.companyId, companyId), eq(table.roleId, roleId), isNull(table.archivedAt)));
  return Number(r.m) + 1;
};

// ───────────── responsibilities ─────────────
type RespInput = { title: string; description?: string | null; expectedOutcome?: string | null; priority: any; frequency: any; requiresApproval: boolean; ownerRoleId?: string | null };

async function checkOwnerRole(ctx: Ctx, ownerRoleId: string | null | undefined) {
  if (!ownerRoleId) return;
  ctx.require('responsibilities.assign');
  await getRole(ctx.db, ctx.companyId, ownerRoleId);
}

export async function addResponsibility(ctx: Ctx, roleId: string, input: RespInput) {
  const { target } = await roleScope(ctx, roleId);
  ctx.require('responsibilities.create', target);
  await checkOwnerRole(ctx, input.ownerRoleId);
  const [r] = await ctx.db.insert(S.roleResponsibilities).values({ companyId: ctx.companyId, roleId, title: input.title, description: input.description ?? null, expectedOutcome: input.expectedOutcome ?? null, priority: input.priority, frequency: input.frequency, requiresApproval: input.requiresApproval, ownerRoleId: input.ownerRoleId ?? null, position: await nextPos(ctx.db, S.roleResponsibilities, ctx.companyId, roleId) }).returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'responsibility.created', 'responsibility', r.id, { roleId, title: r.title });
  return r;
}

async function getResp(ctx: Ctx, id: string) {
  const [r] = await ctx.db.select().from(S.roleResponsibilities).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), eq(S.roleResponsibilities.id, id), isNull(S.roleResponsibilities.archivedAt))).limit(1);
  if (!r) throw notFound('Responsibility not found');
  return { r, ...(await roleScope(ctx, r.roleId)) };
}

export async function updateResponsibility(ctx: Ctx, id: string, patch: Partial<RespInput> & { status?: 'active' | 'inactive' }) {
  const { r, target } = await getResp(ctx, id);
  ctx.require('responsibilities.edit', target);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const k of ['title', 'description', 'expectedOutcome', 'priority', 'frequency', 'requiresApproval', 'status'] as const) if ((patch as any)[k] !== undefined) set[k] = (patch as any)[k];
  if (patch.ownerRoleId !== undefined && patch.ownerRoleId !== r.ownerRoleId) {
    await checkOwnerRole(ctx, patch.ownerRoleId);
    if (patch.ownerRoleId === r.roleId) throw badRequest('Already part of this role; clear the owner instead');
    set.ownerRoleId = patch.ownerRoleId;
  }
  const [u] = await ctx.db.update(S.roleResponsibilities).set(set).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), eq(S.roleResponsibilities.id, id))).returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, patch.ownerRoleId !== undefined && patch.ownerRoleId !== r.ownerRoleId ? 'responsibility.owner_changed' : 'responsibility.updated', 'responsibility', id, { roleId: r.roleId, changes: patch, previousOwnerRoleId: r.ownerRoleId });
  return u;
}

export async function deleteResponsibility(ctx: Ctx, id: string) {
  const { r, target } = await getResp(ctx, id);
  ctx.require('responsibilities.delete', target);
  await ctx.db.update(S.roleResponsibilities).set({ archivedAt: new Date() }).where(and(eq(S.roleResponsibilities.companyId, ctx.companyId), eq(S.roleResponsibilities.id, id)));
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'responsibility.deleted', 'responsibility', id, { roleId: r.roleId, title: r.title });
}

export async function reorder(ctx: Ctx, kind: 'responsibilities' | 'rules' | 'kpis', roleId: string, ids: string[]) {
  const { target } = await roleScope(ctx, roleId);
  ctx.require(kind === 'responsibilities' ? 'responsibilities.edit' : 'roles.edit', target);
  const table: any = kind === 'responsibilities' ? S.roleResponsibilities : kind === 'rules' ? S.roleRules : S.roleKpis;
  const existing = await ctx.db.select({ id: table.id }).from(table).where(and(eq(table.companyId, ctx.companyId), eq(table.roleId, roleId), isNull(table.archivedAt)));
  const set = new Set(existing.map((e: any) => e.id));
  if (ids.length !== set.size || ids.some((i) => !set.has(i))) throw badRequest('Order must list every item of this role exactly once');
  await ctx.db.transaction(async (tx) => { for (let i = 0; i < ids.length; i++) await tx.update(table).set({ position: i }).where(and(eq(table.companyId, ctx.companyId), eq(table.id, ids[i]))); });
  await audit(ctx.db, ctx.companyId, ctx.user.id, `${kind}.reordered`, 'role', roleId, {});
}

// ───────────── rules & KPIs (role configuration) ─────────────
export async function addRule(ctx: Ctx, roleId: string, input: { kind: any; text: string }) {
  const { target } = await roleScope(ctx, roleId); ctx.require('roles.edit', target);
  const [r] = await ctx.db.insert(S.roleRules).values({ companyId: ctx.companyId, roleId, kind: input.kind, text: input.text, position: await nextPos(ctx.db, S.roleRules, ctx.companyId, roleId) }).returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'role_rule.created', 'role', roleId, { rule: input });
  return r;
}
export async function updateRule(ctx: Ctx, roleId: string, id: string, input: { kind?: any; text?: string }) {
  const { target } = await roleScope(ctx, roleId); ctx.require('roles.edit', target);
  const [r] = await ctx.db.update(S.roleRules).set(input).where(and(eq(S.roleRules.companyId, ctx.companyId), eq(S.roleRules.roleId, roleId), eq(S.roleRules.id, id), isNull(S.roleRules.archivedAt))).returning();
  if (!r) throw notFound('Rule not found');
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'role_rule.updated', 'role', roleId, { ruleId: id, changes: input });
  return r;
}
export async function deleteRule(ctx: Ctx, roleId: string, id: string) {
  const { target } = await roleScope(ctx, roleId); ctx.require('roles.edit', target);
  const r = await ctx.db.update(S.roleRules).set({ archivedAt: new Date() }).where(and(eq(S.roleRules.companyId, ctx.companyId), eq(S.roleRules.roleId, roleId), eq(S.roleRules.id, id), isNull(S.roleRules.archivedAt))).returning({ id: S.roleRules.id });
  if (!r.length) throw notFound('Rule not found');
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'role_rule.deleted', 'role', roleId, { ruleId: id });
}
export async function addKpi(ctx: Ctx, roleId: string, input: { name: string; description?: string | null; target?: string | null; unit?: string | null; period: any; targetValue?: number | null; direction?: string; dataSource?: string; sensitivity?: string; reportingFrequency?: any }) {
  const { target } = await roleScope(ctx, roleId); ctx.require('roles.edit', target);
  const [k] = await ctx.db.insert(S.roleKpis).values({ companyId: ctx.companyId, roleId, ...input, targetValue: input.targetValue == null ? null : String(input.targetValue), target: input.target ?? (input.targetValue == null ? null : String(input.targetValue)), position: await nextPos(ctx.db, S.roleKpis, ctx.companyId, roleId) }).returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'role_kpi.created', 'role', roleId, { kpi: input.name });
  return k;
}
export async function updateKpi(ctx: Ctx, roleId: string, id: string, input: Record<string, unknown>) {
  if ('targetValue' in input) input = { ...input, targetValue: input.targetValue == null ? null : String(input.targetValue) };
  const { target } = await roleScope(ctx, roleId); ctx.require('roles.edit', target);
  const [k] = await ctx.db.update(S.roleKpis).set(input).where(and(eq(S.roleKpis.companyId, ctx.companyId), eq(S.roleKpis.roleId, roleId), eq(S.roleKpis.id, id), isNull(S.roleKpis.archivedAt))).returning();
  if (!k) throw notFound('KPI not found');
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'role_kpi.updated', 'role', roleId, { kpiId: id, changes: input });
  return k;
}
export async function deleteKpi(ctx: Ctx, roleId: string, id: string) {
  const { target } = await roleScope(ctx, roleId); ctx.require('roles.edit', target);
  const r = await ctx.db.update(S.roleKpis).set({ archivedAt: new Date() }).where(and(eq(S.roleKpis.companyId, ctx.companyId), eq(S.roleKpis.roleId, roleId), eq(S.roleKpis.id, id), isNull(S.roleKpis.archivedAt))).returning({ id: S.roleKpis.id });
  if (!r.length) throw notFound('KPI not found');
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'role_kpi.deleted', 'role', roleId, { kpiId: id });
}
