import { and, desc, eq, isNull } from 'drizzle-orm';
import { schema } from '@/db/client';
import { KPI_SOURCES } from '@/lib/constants';
import { badRequest, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { calcKpi, kpiAttainment, resolveWindow, taskMetrics, today, type Window } from './metrics';
import { kpiAllowed, lite, loadOps, makePredicates, reportScope, type Ops, type Scope } from './scope';

const S = schema;
export type KpiRow = Ops['kpis'][number];

/** Actual value of one KPI for a window: calculated from real task data, or the latest manual entry overlapping the window. */
export function computeKpi(ops: Ops, k: KpiRow, w: Window, now = new Date()) {
  const target = k.targetValue == null ? null : Number(k.targetValue);
  let actual: number | null = null; let source: 'calculated' | 'manual' = 'manual'; let recordedAt: Date | null = null;
  if (k.dataSource !== 'manual') {
    source = 'calculated';
    actual = calcKpi(k.dataSource, ops.tasks.filter((t) => t.roleId === k.roleId).map(lite), w, now);
  } else {
    const v = ops.values.filter((x) => x.kpiId === k.id && x.periodEnd >= w.from && x.periodStart <= w.to).sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1) || b.createdAt.getTime() - a.createdAt.getTime())[0];
    if (v) { actual = Number(v.value); recordedAt = v.createdAt; }
  }
  return { actual, source, recordedAt, target, ...kpiAttainment(actual, target, k.direction) };
}

export const kpiDto = (ops: Ops, k: KpiRow, w: Window, now = new Date()) => {
  const role = ops.roles.find((r) => r.id === k.roleId);
  const c = computeKpi(ops, k, w, now);
  return { id: k.id, name: k.name, description: k.description, roleId: k.roleId, roleName: role?.name ?? '', departmentId: role?.departmentId ?? null, departmentName: ops.depts.find((d) => d.id === role?.departmentId)?.name ?? null,
    unit: k.unit, direction: k.direction, dataSource: k.dataSource, dataSourceLabel: KPI_SOURCES[k.dataSource as keyof typeof KPI_SOURCES] ?? k.dataSource, sensitivity: k.sensitivity, period: k.period, reportingFrequency: k.reportingFrequency,
    window: w, ...c, recent: ops.values.filter((v) => v.kpiId === k.id).sort((a, b) => (a.periodEnd < b.periodEnd ? 1 : -1)).slice(0, 6).map((v) => ({ id: v.id, periodStart: v.periodStart, periodEnd: v.periodEnd, value: Number(v.value), note: v.note })) };
};

export function kpiVisible(ctx: Ctx, sc: Scope, pr: ReturnType<typeof makePredicates>, k: KpiRow) {
  const role = pr.roleById.get(k.roleId); if (!role) return false;
  const base = ctx.myRoleIds.has(k.roleId) || pr.roleIn(k.roleId) || ctx.can('kpis.view', { roleId: k.roleId, departmentId: role.departmentId });
  return base && kpiAllowed(sc, k);
}

export async function listKpis(ctx: Ctx, f: { roleId?: string; departmentId?: string; anchor?: string } = {}) {
  const ops = await loadOps(ctx.db, ctx.companyId); const sc = await reportScope(ctx, ops); const pr = makePredicates(sc, ops); const now = new Date();
  const out = [] as ReturnType<typeof kpiDto>[]; let restricted = 0;
  for (const k of ops.kpis) {
    const role = pr.roleById.get(k.roleId); if (!role) continue;
    if (f.roleId && k.roleId !== f.roleId) continue; if (f.departmentId && role.departmentId !== f.departmentId) continue;
    const seen = ctx.myRoleIds.has(k.roleId) || pr.roleIn(k.roleId) || ctx.can('kpis.view', { roleId: k.roleId, departmentId: role.departmentId });
    if (!seen) continue;
    if (!kpiAllowed(sc, k)) { restricted++; continue; }
    out.push(kpiDto(ops, k, resolveWindow(k.period === 'none' ? 'monthly' : k.period, f.anchor, null, null, now), now));
  }
  return { kpis: out, restrictedCount: restricted };
}

async function loadKpi(ctx: Ctx, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('KPI not found');
  const [k] = await ctx.db.select().from(S.roleKpis).where(and(eq(S.roleKpis.companyId, ctx.companyId), eq(S.roleKpis.id, id), isNull(S.roleKpis.archivedAt)));
  if (!k) throw notFound('KPI not found');
  const [role] = await ctx.db.select().from(S.roles).where(and(eq(S.roles.companyId, ctx.companyId), eq(S.roles.id, k.roleId)));
  if (!role) throw notFound('KPI not found');
  const sc = await reportScope(ctx, await loadOps(ctx.db, ctx.companyId));
  if (!kpiAllowed(sc, k)) throw notFound('KPI not found'); // sensitive KPIs are invisible without their own permission
  return { k, role };
}

/** People holding the responsible role may record its manual values; others need kpis.edit. */
export async function recordKpiValue(ctx: Ctx, id: string, v: { periodStart: string; periodEnd: string; value: number; note?: string | null }) {
  const { k, role } = await loadKpi(ctx, id);
  if (!(ctx.myRoleIds.has(k.roleId) || ctx.can('kpis.edit', { roleId: k.roleId, departmentId: role.departmentId }))) throw forbidden();
  if (k.dataSource !== 'manual') throw badRequest(`This KPI is calculated automatically from ${KPI_SOURCES[k.dataSource as keyof typeof KPI_SOURCES] ?? k.dataSource}; it cannot be entered by hand.`);
  if (v.periodEnd < v.periodStart) throw badRequest('The period end cannot be before its start');
  const [row] = await ctx.db.insert(S.kpiValues).values({ companyId: ctx.companyId, kpiId: id, periodStart: v.periodStart, periodEnd: v.periodEnd, value: String(v.value), note: v.note ?? null, recordedBy: ctx.user.id })
    .onConflictDoUpdate({ target: [S.kpiValues.kpiId, S.kpiValues.periodStart, S.kpiValues.periodEnd], set: { value: String(v.value), note: v.note ?? null, recordedBy: ctx.user.id, createdAt: new Date() } }).returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'kpi.value_recorded', 'kpi', id, { name: k.name, periodStart: v.periodStart, periodEnd: v.periodEnd });
  return row;
}
export async function listKpiValues(ctx: Ctx, id: string) {
  const { k, role } = await loadKpi(ctx, id);
  if (!(ctx.myRoleIds.has(k.roleId) || ctx.can('kpis.view', { roleId: k.roleId, departmentId: role.departmentId }) || ctx.hasAny('reports.view'))) throw forbidden();
  return ctx.db.select().from(S.kpiValues).where(and(eq(S.kpiValues.companyId, ctx.companyId), eq(S.kpiValues.kpiId, id))).orderBy(desc(S.kpiValues.periodEnd)).limit(100);
}
export async function deleteKpiValue(ctx: Ctx, id: string, valueId: string) {
  const { k, role } = await loadKpi(ctx, id);
  ctx.require('kpis.edit', { roleId: k.roleId, departmentId: role.departmentId });
  const r = await ctx.db.delete(S.kpiValues).where(and(eq(S.kpiValues.companyId, ctx.companyId), eq(S.kpiValues.kpiId, id), eq(S.kpiValues.id, valueId))).returning({ id: S.kpiValues.id });
  if (!r.length) throw notFound('Value not found');
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'kpi.value_deleted', 'kpi', id, { name: k.name });
}

// ───────────── responsibility tracking ─────────────
/** Responsibility progress for already-authorised roles. Performance = on-time rate of its tasks; status flags overdue work. */
export function respRows(ops: Ops, roleIds: Set<string>, w: Window, now = new Date()) {
  const nm = (id: string | null) => ops.roles.find((r) => r.id === id)?.name ?? null;
  const rows = [];
  for (const r of ops.resp) {
    if (!roleIds.has(r.roleId)) continue;
    const role = ops.roles.find((x) => x.id === r.roleId); if (!role) continue;
    const ownerRoleId = r.ownerRoleId ?? r.roleId;
    const h = ops.assigns.filter((a) => a.roleId === ownerRoleId).sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))[0];
    const holder = h ? (h.membershipId ? ops.members.find((m) => m.id === h.membershipId)?.name : `◉ ${ops.agents.find((a) => a.id === h.agentId)?.name}`) ?? null : null;
    const ts = ops.tasks.filter((t) => t.responsibilityId === r.id && t.status !== 'cancelled');
    const m = taskMetrics(ts.map(lite), w, now); const openTs = ts.filter((t) => t.status !== 'completed'); const done = ts.length - openTs.length;
    const status = !ts.length ? 'no_activity' : m.overdue > 0 ? (m.overdue / Math.max(1, openTs.length) >= 0.5 || r.priority === 'critical' ? 'at_risk' : 'attention') : 'on_track';
    rows.push({ id: r.id, title: r.title, expectedOutcome: r.expectedOutcome, priority: r.priority, frequency: r.frequency, roleId: r.roleId, roleName: role.name, departmentName: ops.depts.find((d) => d.id === role.departmentId)?.name ?? null,
      ownerRoleName: nm(ownerRoleId), ownerName: holder, tasks: { total: ts.length, open: openTs.length, completed: done, overdue: m.overdue, blocked: m.blocked }, completionPct: ts.length ? Math.round((done / ts.length) * 100) : null,
      nextDeadline: openTs.map((t) => t.dueDate).filter((d): d is string => !!d).sort()[0] ?? null, onTimeRate: m.onTimeRate, status });
  }
  return rows;
}
export async function trackResponsibilities(ctx: Ctx, f: { roleId?: string; departmentId?: string; period?: string; anchor?: string } = {}) {
  const ops = await loadOps(ctx.db, ctx.companyId); const sc = await reportScope(ctx, ops); const pr = makePredicates(sc, ops); const now = new Date();
  const w = resolveWindow(f.period ?? 'monthly', f.anchor, null, null, now);
  const ok = new Set(ops.roles.filter((role) => (!f.roleId || role.id === f.roleId) && (!f.departmentId || role.departmentId === f.departmentId) && (ctx.myRoleIds.has(role.id) || pr.roleIn(role.id) || ctx.can('roles.view', { roleId: role.id, departmentId: role.departmentId }))).map((r) => r.id));
  return respRows(ops, ok, w, now).map((r) => ({ ...r, window: w }));
}
void today;
