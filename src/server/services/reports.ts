import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { schema } from '@/db/client';
import { OPEN_STATUSES, TASK_STATUS_LABEL, TASK_STATUSES, type ReportType } from '@/lib/constants';
import { badRequest, forbidden, notFound } from '@/lib/errors';
import { audit } from '../audit';
import type { Ctx } from '../authz';
import { computeKpi, kpiDto, kpiVisible, respRows } from './kpis';
import { addDays, daysBetween, healthScore, isoDay, resolveWindow, taskMetrics, today, type Window } from './metrics';
import { projectHealth } from './projects';
import { kpiAllowed, lite, loadOps, makePredicates, reportScope, type Ops, type Scope } from './scope';

const S = schema;
type Cell = string | number | null;
export type Report = {
  type: ReportType; title: string; subtitle: string; period: string; from: string; to: string; generatedAt: string; generatedBy: string; scopeNote: string;
  definitions: string[]; summary: { label: string; value: Cell; hint?: string }[]; tables: { title: string; columns: string[]; rows: Cell[][] }[]; restricted: string[];
  exportTargets: { departmentId?: string | null; roleId?: string | null }[]; selfOnly: boolean;
};
export type ReportParams = { type: ReportType; period: string; anchor?: string | null; from?: string | null; to?: string | null; departmentId?: string | null; roleId?: string | null; membershipId?: string | null; agentId?: string | null; projectId?: string | null };

const DEFS = [
  'Completion rate = of non-cancelled tasks due in the period, the % that are completed.',
  'On-time rate = of tasks completed in the period that have a due date, the % finished on or before it.',
  'Overdue = open tasks whose due date is before today. Dates are UTC.',
];
const pct = (v: number | null) => (v == null ? '—' : `${v}%`);
const sevRank = { high: 0, medium: 1, low: 2 } as const;
export type Risk = { severity: 'high' | 'medium' | 'low'; category: string; subject: string; detail: string; owner: string | null; since: string | null };
const METRIC_COLS = ['Name', 'Due in period', 'Completion rate', 'On-time rate', 'Overdue now', 'Open', 'Blocked', 'Completed in period'];

function names(ops: Ops) {
  const mn = new Map(ops.members.map((m) => [m.id, m.name])), an = new Map(ops.agents.map((a) => [a.id, a.name])), rn = new Map(ops.roles.map((r) => [r.id, r.name])), dn = new Map(ops.depts.map((d) => [d.id, d.name])), pn = new Map(ops.projects.map((p) => [p.id, p.name]));
  const owner = (t: { ownerMembershipId: string | null; ownerAgentId: string | null }) => (t.ownerAgentId ? `◉ ${an.get(t.ownerAgentId) ?? ''}` : mn.get(t.ownerMembershipId!) ?? '');
  return { mn, an, rn, dn, pn, owner };
}
function metricRow(name: string, ts: Ops['tasks'], w: Window, now: Date): Cell[] {
  const m = taskMetrics(ts.map(lite), w, now);
  return [name, m.dueInWindow, pct(m.completionRate), pct(m.onTimeRate), m.overdue, m.open, m.blocked, m.completedInWindow];
}
const metricSummary = (ts: Ops['tasks'], w: Window, now: Date) => {
  const m = taskMetrics(ts.map(lite), w, now);
  return [{ label: 'Tasks (all / open)', value: `${m.total} / ${m.open}` }, { label: 'Completion rate', value: pct(m.completionRate), hint: `${m.dueCompleted} of ${m.dueInWindow} due in period` }, { label: 'On-time rate', value: pct(m.onTimeRate) },
    { label: 'Completed in period', value: m.completedInWindow }, { label: 'Overdue now', value: m.overdue }, { label: 'Blocked', value: m.blocked }, { label: 'Awaiting approval', value: m.awaitingApproval }, { label: 'Avg. cycle time (days)', value: m.avgCycleDays ?? '—' }];
};
const taskTable = (title: string, ts: Ops['tasks'], N: ReturnType<typeof names>, limit = 100) => ({ title, columns: ['Task', 'Status', 'Priority', 'Owner', 'Role', 'Due', 'Completed'], rows: ts.slice(0, limit).map((t) => [t.title, TASK_STATUS_LABEL[t.status], t.priority, N.owner(t), t.roleId ? N.rn.get(t.roleId) ?? '' : '', t.dueDate, t.completedAt ? isoDay(t.completedAt) : null]) });

/** Auto-detected problems. Everything here is computed from persisted records; nothing is estimated. */
export function computeRisks(ops: Ops, sc: Scope, pr: ReturnType<typeof makePredicates>, aiPending: { title: string; agentId: string; createdAt: Date }[], now = new Date()): Risk[] {
  const N = names(ops); const t0 = today(now); const out: Risk[] = [];
  for (const t of ops.tasks) {
    if (!pr.taskIn(t)) continue;
    const isOpen = (OPEN_STATUSES as string[]).includes(t.status);
    if (isOpen && t.dueDate && t.dueDate < t0) { const d = daysBetween(t.dueDate, t0); out.push({ severity: ['critical', 'high'].includes(t.priority) || d > 7 ? 'high' : 'medium', category: 'Overdue task', subject: t.title, detail: `${d} day(s) overdue · ${t.priority} priority · ${TASK_STATUS_LABEL[t.status]}`, owner: N.owner(t), since: t.dueDate }); }
    const age = (now.getTime() - t.statusChangedAt.getTime()) / 864e5;
    if (t.status === 'blocked' && age >= 3) out.push({ severity: age >= 7 ? 'high' : 'medium', category: 'Blocked task', subject: t.title, detail: `Blocked for ${Math.floor(age)} day(s)${t.blockedReason ? `: ${t.blockedReason}` : ''}`, owner: N.owner(t), since: isoDay(t.statusChangedAt) });
    if (t.status === 'awaiting_approval' && age >= 3) out.push({ severity: 'medium', category: 'Stalled approval', subject: t.title, detail: `Waiting for approval for ${Math.floor(age)} day(s)`, owner: N.owner(t), since: isoDay(t.statusChangedAt) });
  }
  for (const p of ops.projects) {
    if (!pr.projectIn(p.id) || ['completed', 'cancelled'].includes(p.status)) continue;
    const ts = ops.tasks.filter((t) => t.projectId === p.id && t.status !== 'cancelled'); const s = { total: ts.length, done: ts.filter((t) => t.status === 'completed').length, open: ts.filter((t) => t.status !== 'completed').length, overdue: ts.filter((t) => t.status !== 'completed' && t.dueDate && t.dueDate < t0).length };
    const h = projectHealth(p, s, now);
    if (h.health === 'late') out.push({ severity: 'high', category: 'Project late', subject: p.name, detail: `Deadline ${p.deadline} has passed; ${s.done}/${s.total} tasks done`, owner: N.mn.get(p.ownerMembershipId) ?? null, since: p.deadline });
    else if (h.health === 'at_risk') out.push({ severity: 'medium', category: 'Project at risk', subject: p.name, detail: `Progress ${Math.round((h.progress ?? 0) * 100)}% is behind schedule or has many overdue tasks`, owner: N.mn.get(p.ownerMembershipId) ?? null, since: p.deadline });
  }
  for (const k of ops.kpis) {
    if (!kpiVisibleForRisk(sc, pr, k)) continue;
    const c = computeKpi(ops, k, resolveWindow(k.period === 'none' ? 'monthly' : k.period, null, null, null, now), now);
    if (c.status === 'off_track') out.push({ severity: (c.attainment ?? 0) < 0.5 ? 'high' : 'medium', category: 'KPI off track', subject: `${k.name} (${N.rn.get(k.roleId)})`, detail: `Actual ${c.actual} vs target ${c.target} (${Math.round((c.attainment ?? 0) * 100)}% attained)`, owner: N.rn.get(k.roleId) ?? null, since: null });
  }
  for (const r of ops.roles) {
    if (!pr.roleIn(r.id) || r.roleType !== 'vacant' || r.status !== 'active') continue;
    if (ops.resp.some((x) => x.roleId === r.id)) out.push({ severity: 'low', category: 'Vacant role', subject: r.name, detail: 'Nobody (person or AI) holds this role but it has responsibilities', owner: null, since: null });
  }
  for (const w of aiPending) { const age = (now.getTime() - w.createdAt.getTime()) / 864e5; if (age >= 3 && pr.agentIn(w.agentId)) out.push({ severity: 'medium', category: 'AI work awaiting review', subject: w.title, detail: `Waiting ${Math.floor(age)} day(s) for a human decision`, owner: N.an.get(w.agentId) ? `◉ ${N.an.get(w.agentId)}` : null, since: isoDay(w.createdAt) }); }
  return out.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || (a.since ?? '').localeCompare(b.since ?? ''));
}
const kpiVisibleForRisk = (sc: Scope, pr: ReturnType<typeof makePredicates>, k: Ops['kpis'][number]) => pr.roleIn(k.roleId) && kpiAllowed(sc, k);

async function aiPendingItems(ctx: Ctx) {
  return ctx.db.select({ title: S.aiWorkItems.title, agentId: S.aiWorkItems.agentId, createdAt: S.aiWorkItems.createdAt }).from(S.aiWorkItems).where(and(eq(S.aiWorkItems.companyId, ctx.companyId), eq(S.aiWorkItems.status, 'pending_review')));
}

function exportOk(ctx: Ctx, sc: Scope, targets: { departmentId?: string | null; roleId?: string | null }[], selfOnly: boolean) {
  if (ctx.isOwner || selfOnly) return true;
  if (!targets.length) return ctx.can('reports.export');
  const ownScope = ctx.scopesOf('reports.export').has('own');
  return targets.some((t) => ctx.can('reports.export', t) || (ownScope && !!t.roleId && sc.roleIds.has(t.roleId)));
}

export async function buildReport(ctx: Ctx, p: ReportParams, opts: { forExport?: boolean } = {}): Promise<Report> {
  const now = new Date();
  let w: Window; try { w = resolveWindow(p.period, p.anchor, p.from, p.to, now); } catch (e) { throw badRequest((e as Error).message); }
  const ops = await loadOps(ctx.db, ctx.companyId); const sc = await reportScope(ctx, ops); const pr = makePredicates(sc, ops); const N = names(ops);
  const hasAny = sc.all || sc.departmentIds.size > 0 || sc.roleIds.size > 0 || sc.projectIds.size > 0 || sc.employeeIds.size > 1;
  const selfReport = p.type === 'employee' && (!p.membershipId || p.membershipId === sc.me);
  if (!hasAny && !selfReport) throw forbidden('You do not have access to reports');
  const restricted: string[] = []; let targets: { departmentId?: string | null; roleId?: string | null }[] = []; let selfOnly = false;
  const base = { type: p.type, period: w.period, from: w.from, to: w.to, generatedAt: now.toISOString(), generatedBy: ctx.user.name, definitions: DEFS, restricted, exportTargets: targets };
  const finish = async (r: Omit<Report, keyof typeof base | 'exportTargets' | 'selfOnly'> & { definitions?: string[] }): Promise<Report> => {
    if (opts.forExport && !exportOk(ctx, sc, targets, selfOnly)) throw forbidden('You can view this report but you do not have permission to export it');
    await audit(ctx.db, ctx.companyId, ctx.user.id, opts.forExport ? 'report.export_generated' : 'report.accessed', 'report', null, { type: p.type, period: w.period, from: w.from, to: w.to, departmentId: p.departmentId, roleId: p.roleId, membershipId: p.membershipId, agentId: p.agentId, projectId: p.projectId });
    return { ...base, ...r, exportTargets: targets, selfOnly };
  };
  const kpiTable = (ks: Ops['kpis']) => { const rows: Cell[][] = []; for (const k of ks) { if (!kpiAllowed(sc, k)) { restricted.push(`KPI "${k.name}" is ${k.sensitivity} data and needs ${k.sensitivity === 'financial' ? 'finance' : 'HR'} access`); continue; } const d = kpiDto(ops, k, w, now); rows.push([d.name, d.roleName, d.target == null ? '—' : `${d.target}${d.unit ? ' ' + d.unit : ''}`, d.actual == null ? '—' : `${d.actual}${d.unit ? ' ' + d.unit : ''}`, d.attainment == null ? '—' : `${Math.round(d.attainment * 100)}%`, d.status.replace('_', ' '), d.source, d.dataSourceLabel.split(':')[0]]); } return { title: 'KPIs', columns: ['KPI', 'Role', 'Target', 'Actual', 'Attainment', 'Status', 'Source', 'Data source'], rows }; };
  const mode = (r: Ops['roles'][number]) => r.roleType;
  const ownerOf = (roleId: string) => { const a = ops.assigns.filter((x) => x.roleId === roleId).sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary))[0]; return a ? (a.membershipId ? N.mn.get(a.membershipId) : `◉ ${N.an.get(a.agentId!)}`) ?? '' : '—'; };

  switch (p.type) {
    case 'company': {
      if (!sc.all) throw forbidden('Company-wide reports need company-wide report access');
      const ts = ops.tasks; const risks = computeRisks(ops, sc, pr, await aiPendingItems(ctx), now);
      const modes = (m: string) => ops.roles.filter((r) => r.roleType === m).length;
      return finish({ title: 'Company Performance Report', subtitle: `${w.label}`, scopeNote: 'Company-wide', summary: [...metricSummary(ts, w, now), { label: 'Active projects', value: ops.projects.filter((x) => x.status === 'active').length }, { label: 'Roles (AI / Human / Hybrid / Vacant)', value: `${modes('ai')} / ${modes('human')} / ${modes('hybrid')} / ${modes('vacant')}` }, { label: 'People active', value: ops.members.filter((m) => m.status === 'active').length }, { label: 'AI employees active', value: ops.agents.filter((a) => a.status === 'active').length }, { label: 'Open risks (high)', value: `${risks.length} (${risks.filter((r) => r.severity === 'high').length})` }],
        tables: [{ title: 'Departments', columns: METRIC_COLS, rows: ops.depts.map((d) => metricRow(d.name, ops.tasks.filter((t) => t.departmentId === d.id), w, now)) },
          { title: 'Roles', columns: ['Role', 'Department', 'Mode', 'Owner', ...METRIC_COLS.slice(1)], rows: ops.roles.map((r) => { const m = metricRow(r.name, ops.tasks.filter((t) => t.roleId === r.id), w, now); return [r.name, N.dn.get(r.departmentId!) ?? '—', mode(r), ownerOf(r.id), ...m.slice(1)]; }) },
          { title: 'Projects', columns: ['Project', 'Status', 'Health', 'Progress', 'Deadline'], rows: ops.projects.map((x) => { const pt = ops.tasks.filter((t) => t.projectId === x.id && t.status !== 'cancelled'); const h = projectHealth(x, { total: pt.length, done: pt.filter((t) => t.status === 'completed').length, open: pt.filter((t) => t.status !== 'completed').length, overdue: pt.filter((t) => t.status !== 'completed' && t.dueDate && t.dueDate < today(now)).length }, now); return [x.name, x.status, h.health.replace('_', ' '), h.progress == null ? '—' : `${Math.round(h.progress * 100)}%`, x.deadline]; }) },
          { title: 'Top risks', columns: ['Severity', 'Category', 'Subject', 'Detail'], rows: risks.slice(0, 10).map((r) => [r.severity, r.category, r.subject, r.detail]) }, kpiTable(ops.kpis)] });
    }
    case 'department': {
      const dept = ops.depts.find((d) => d.id === p.departmentId); if (!dept) throw notFound('Department not found'); if (!pr.deptIn(dept.id)) throw forbidden('This department is outside your report access');
      targets = [{ departmentId: dept.id }]; const roleIds = new Set(ops.roles.filter((r) => r.departmentId === dept.id).map((r) => r.id));
      const ts = ops.tasks.filter((t) => t.departmentId === dept.id || (t.roleId && roleIds.has(t.roleId)));
      const people = ops.members.filter((m) => m.status === 'active' && (m.departmentId === dept.id || ops.assigns.some((a) => a.membershipId === m.id && roleIds.has(a.roleId))));
      return finish({ title: `Department Report — ${dept.name}`, subtitle: w.label, scopeNote: `Department: ${dept.name}`, summary: [...metricSummary(ts, w, now), { label: 'Roles', value: roleIds.size }, { label: 'People', value: people.length }],
        tables: [{ title: 'Roles', columns: ['Role', 'Mode', 'Owner', ...METRIC_COLS.slice(1)], rows: ops.roles.filter((r) => r.departmentId === dept.id).map((r) => { const m = metricRow(r.name, ops.tasks.filter((t) => t.roleId === r.id), w, now); return [r.name, mode(r), ownerOf(r.id), ...m.slice(1)]; }) },
          { title: 'People', columns: METRIC_COLS, rows: people.map((m) => metricRow(m.name, ts.filter((t) => t.ownerMembershipId === m.id), w, now)) },
          kpiTable(ops.kpis.filter((k) => roleIds.has(k.roleId))), taskTable('Open and recent tasks', ts.filter((t) => (OPEN_STATUSES as string[]).includes(t.status) || (t.completedAt && isoDay(t.completedAt) >= w.from && isoDay(t.completedAt) <= w.to)), N)] });
    }
    case 'role': {
      const role = ops.roles.find((r) => r.id === p.roleId); if (!role) throw notFound('Role not found');
      if (!pr.roleIn(role.id)) throw forbidden('This role is outside your report access');
      targets = [{ roleId: role.id, departmentId: role.departmentId }]; const ts = ops.tasks.filter((t) => t.roleId === role.id);
      const team = ops.assigns.filter((a) => a.roleId === role.id).map((a) => (a.membershipId ? N.mn.get(a.membershipId) : `◉ ${N.an.get(a.agentId!)}`) + (a.isPrimary ? ' (owner)' : ''));
      return finish({ title: `Role Performance Report — ${role.name}`, subtitle: w.label, scopeNote: `Role: ${role.name}`, summary: [{ label: 'Mode', value: mode(role) }, { label: 'Team', value: team.join(', ') || 'Vacant' }, { label: 'Department', value: N.dn.get(role.departmentId!) ?? '—' }, ...metricSummary(ts, w, now)],
        tables: [{ title: 'Responsibilities', columns: ['Responsibility', 'Owner', 'Priority', 'Tasks (done/total)', 'Completion', 'On-time', 'Overdue', 'Next deadline', 'Status', 'Expected outcome'], rows: respRows(ops, new Set([role.id]), w, now).map((r) => [r.title, r.ownerName ?? r.ownerRoleName, r.priority, `${r.tasks.completed}/${r.tasks.total}`, r.completionPct == null ? '—' : `${r.completionPct}%`, pct(r.onTimeRate), r.tasks.overdue, r.nextDeadline, r.status.replace('_', ' '), r.expectedOutcome]) },
          kpiTable(ops.kpis.filter((k) => k.roleId === role.id)), taskTable('Tasks', ts, N)] });
    }
    case 'employee': {
      const mid = p.membershipId ?? sc.me; const m = ops.members.find((x) => x.id === mid); if (!m) throw notFound('Employee not found');
      if (!pr.employeeIn(mid)) throw forbidden('This employee is outside your report access');
      selfOnly = mid === sc.me; targets = pr.rolesOfMember(mid).map((r) => ({ roleId: r, departmentId: pr.roleById.get(r)?.departmentId ?? null })); if (m.departmentId) targets.push({ departmentId: m.departmentId });
      const ts = ops.tasks.filter((t) => t.ownerMembershipId === mid); const proj = ops.projects.filter((x) => x.ownerMembershipId === mid || ops.projectMembers.some((pm) => pm.projectId === x.id && pm.membershipId === mid));
      return finish({ title: `Employee Performance Report — ${m.name}`, subtitle: w.label, scopeNote: selfOnly ? 'Your own report' : `Employee: ${m.name}`, summary: [{ label: 'Status', value: m.empStatus ?? m.status }, { label: 'Roles', value: pr.rolesOfMember(mid).map((r) => N.rn.get(r)).join(', ') || '—' }, ...metricSummary(ts, w, now)],
        tables: [taskTable('Tasks', ts, N), { title: 'Projects', columns: ['Project', 'Status', 'Deadline'], rows: proj.map((x) => [x.name, x.status, x.deadline]) }] });
    }
    case 'ai_employee': {
      const a = ops.agents.find((x) => x.id === p.agentId); if (!a) throw notFound('AI employee not found'); if (!pr.agentIn(a.id)) throw forbidden('This AI employee is outside your report access');
      targets = pr.rolesOfAgent(a.id).map((r) => ({ roleId: r, departmentId: pr.roleById.get(r)?.departmentId ?? null })); if (a.departmentId) targets.push({ departmentId: a.departmentId });
      const ts = ops.tasks.filter((t) => t.ownerAgentId === a.id); const from = new Date(w.from + 'T00:00:00Z'), to = new Date(w.to + 'T23:59:59.999Z');
      const [runs, items] = await Promise.all([ctx.db.select().from(S.aiRuns).where(and(eq(S.aiRuns.companyId, ctx.companyId), eq(S.aiRuns.agentId, a.id), gte(S.aiRuns.startedAt, from), lte(S.aiRuns.startedAt, to))),
        ctx.db.select().from(S.aiWorkItems).where(and(eq(S.aiWorkItems.companyId, ctx.companyId), eq(S.aiWorkItems.agentId, a.id), gte(S.aiWorkItems.createdAt, from), lte(S.aiWorkItems.createdAt, to)))]);
      const usage = await ctx.db.select().from(S.aiUsageRecords).where(and(eq(S.aiUsageRecords.companyId, ctx.companyId), eq(S.aiUsageRecords.agentId, a.id), gte(S.aiUsageRecords.createdAt, from), lte(S.aiUsageRecords.createdAt, to)));
      const cnt = (s: string) => runs.filter((r) => r.status === s).length; const wi = (s: string) => items.filter((i) => i.status === s).length; const costKnown = usage.every((u) => u.costUsd != null);
      return finish({ title: `AI Employee Performance Report — ${a.name}`, subtitle: w.label, scopeNote: `AI employee: ${a.name}`, summary: [{ label: 'Status', value: a.status }, { label: 'Accountable manager', value: N.mn.get(a.managerMembershipId!) ?? '—' }, { label: 'Runs (ok / blocked / failed)', value: `${cnt('succeeded')} / ${cnt('blocked')} / ${cnt('failed')}` }, { label: 'Tokens', value: usage.reduce((s, u) => s + u.inputTokens + u.outputTokens, 0) }, { label: 'Cost (USD)', value: costKnown && usage.length ? Number(usage.reduce((s, u) => s + Number(u.costUsd), 0).toFixed(4)) : usage.length ? 'n/a (no price configured)' : 0 },
          { label: 'Work items (pending / approved / rejected / executed)', value: `${wi('pending_review')} / ${wi('approved')} / ${wi('rejected')} / ${wi('executed')}` }, ...metricSummary(ts, w, now)],
        tables: [{ title: 'Recent runs', columns: ['Started', 'Status', 'Autonomy', 'Tokens', 'Input'], rows: runs.sort((x, y) => y.startedAt.getTime() - x.startedAt.getTime()).slice(0, 30).map((r) => [isoDay(r.startedAt), r.status, `L${r.autonomyLevel}`, r.inputTokens + r.outputTokens, r.input.slice(0, 80)]) }, taskTable('Tasks owned', ts, N)] });
    }
    case 'task_completion': {
      let ts = ops.tasks.filter((t) => pr.taskIn(t)); const sub: string[] = [];
      if (p.departmentId) { if (!pr.deptIn(p.departmentId)) throw forbidden('Outside your report access'); ts = ts.filter((t) => t.departmentId === p.departmentId || (t.roleId && ops.roles.find((r) => r.id === t.roleId)?.departmentId === p.departmentId)); targets.push({ departmentId: p.departmentId }); sub.push(N.dn.get(p.departmentId) ?? ''); }
      if (p.roleId) { if (!pr.roleIn(p.roleId)) throw forbidden('Outside your report access'); ts = ts.filter((t) => t.roleId === p.roleId); targets.push({ roleId: p.roleId, departmentId: pr.roleById.get(p.roleId)?.departmentId ?? null }); sub.push(N.rn.get(p.roleId) ?? ''); }
      if (p.projectId) { if (!pr.projectIn(p.projectId)) throw forbidden('Outside your report access'); ts = ts.filter((t) => t.projectId === p.projectId); sub.push(N.pn.get(p.projectId) ?? ''); }
      const owners = [...new Set(ts.map((t) => N.owner(t)))];
      return finish({ title: 'Task Completion Report', subtitle: `${w.label}${sub.length ? ' · ' + sub.join(', ') : ''}`, scopeNote: sub.length ? sub.join(', ') : 'Everything within your report access', summary: metricSummary(ts, w, now),
        tables: [{ title: 'By status', columns: ['Status', 'Tasks'], rows: TASK_STATUSES.map((s) => [TASK_STATUS_LABEL[s], ts.filter((t) => t.status === s).length]) }, { title: 'By priority', columns: ['Priority', 'Open', 'Completed'], rows: ['critical', 'high', 'medium', 'low'].map((x) => [x, ts.filter((t) => t.priority === x && (OPEN_STATUSES as string[]).includes(t.status)).length, ts.filter((t) => t.priority === x && t.status === 'completed').length]) },
          { title: 'By owner', columns: METRIC_COLS, rows: owners.map((o) => metricRow(o, ts.filter((t) => N.owner(t) === o), w, now)) }, taskTable('Completed in period', ts.filter((t) => t.completedAt && isoDay(t.completedAt) >= w.from && isoDay(t.completedAt) <= w.to), N), taskTable('Overdue', ts.filter((t) => (OPEN_STATUSES as string[]).includes(t.status) && t.dueDate && t.dueDate < today(now)), N)] });
    }
    case 'kpi': {
      const ks = ops.kpis.filter((k) => (!p.roleId || k.roleId === p.roleId) && (!p.departmentId || pr.roleById.get(k.roleId)?.departmentId === p.departmentId) && pr.roleIn(k.roleId));
      if (p.roleId && !pr.roleIn(p.roleId)) throw forbidden('Outside your report access');
      targets = [...new Set(ks.map((k) => k.roleId))].map((r) => ({ roleId: r, departmentId: pr.roleById.get(r)?.departmentId ?? null }));
      const t = kpiTable(ks); const st = (s: string) => t.rows.filter((r) => r[5] === s).length;
      return finish({ title: 'KPI Report', subtitle: w.label, scopeNote: 'KPIs within your report access', summary: [{ label: 'KPIs shown', value: t.rows.length }, { label: 'Met', value: st('met') }, { label: 'On track', value: st('on track') }, { label: 'At risk', value: st('at risk') }, { label: 'Off track', value: st('off track') }, { label: 'No data', value: st('no data') }, { label: 'Restricted (hidden)', value: restricted.length }], tables: [t] });
    }
    case 'project': {
      const x = ops.projects.find((q) => q.id === p.projectId); if (!x) throw notFound('Project not found'); if (!pr.projectIn(x.id)) throw forbidden('This project is outside your report access');
      targets = [{ departmentId: x.departmentId }]; const pt = ops.tasks.filter((t) => t.projectId === x.id); const live = pt.filter((t) => t.status !== 'cancelled');
      const h = projectHealth(x, { total: live.length, done: live.filter((t) => t.status === 'completed').length, open: live.filter((t) => t.status !== 'completed').length, overdue: live.filter((t) => t.status !== 'completed' && t.dueDate && t.dueDate < today(now)).length }, now);
      const team = ops.projectMembers.filter((m) => m.projectId === x.id).map((m) => (m.membershipId ? N.mn.get(m.membershipId) : `◉ ${N.an.get(m.agentId!)}`) ?? '');
      return finish({ title: `Project Report — ${x.name}`, subtitle: w.label, scopeNote: `Project: ${x.name}`, summary: [{ label: 'Status', value: x.status }, { label: 'Health', value: h.health.replace('_', ' ') }, { label: 'Progress', value: h.progress == null ? '—' : `${Math.round(h.progress * 100)}%` }, { label: 'Deadline', value: x.deadline ?? '—', hint: x.deadline ? `${daysBetween(today(now), x.deadline)} day(s) from today` : undefined }, { label: 'Owner', value: N.mn.get(x.ownerMembershipId) ?? '' }, { label: 'Deliverables done', value: `${x.deliverables.filter((d) => d.done).length}/${x.deliverables.length}` }, ...metricSummary(pt, w, now)],
        tables: [{ title: 'Goals', columns: ['Goal'], rows: x.goals.map((g) => [g]) }, { title: 'Deliverables', columns: ['Deliverable', 'Done'], rows: x.deliverables.map((d) => [d.title, d.done ? 'yes' : 'no']) }, { title: 'Team', columns: ['Member'], rows: [[N.mn.get(x.ownerMembershipId) + ' (owner)'], ...team.map((t) => [t])] }, taskTable('Tasks', pt, N)] });
    }
    case 'risk': {
      const risks = computeRisks(ops, sc, pr, await aiPendingItems(ctx), now); const c = (s: string) => risks.filter((r) => r.severity === s).length;
      if (!sc.financial) restricted.push('Risks from financial KPIs are not included (needs finance access)');
      return finish({ title: 'Risk Report', subtitle: `As of ${today(now)}`, scopeNote: sc.all ? 'Company-wide' : 'Within your report access', summary: [{ label: 'High', value: c('high') }, { label: 'Medium', value: c('medium') }, { label: 'Low', value: c('low') }, { label: 'Total', value: risks.length }],
        definitions: ['Overdue: high if the task is critical/high priority or more than 7 days late, otherwise medium.', 'Blocked ≥3 days (high ≥7), approvals waiting ≥3 days, projects past deadline (high) or behind schedule (medium), KPIs off track, vacant roles, AI work waiting ≥3 days.'],
        tables: [{ title: 'Risk register', columns: ['Severity', 'Category', 'Subject', 'Detail', 'Owner', 'Since'], rows: risks.map((r) => [r.severity, r.category, r.subject, r.detail, r.owner, r.since]) }] });
    }
  }
}

/** Everything a report catalog needs to populate pickers: only entities the caller may report on. */
export async function reportCatalog(ctx: Ctx) {
  const ops = await loadOps(ctx.db, ctx.companyId); const sc = await reportScope(ctx, ops); const pr = makePredicates(sc, ops);
  const nm = <T extends { id: string }>(xs: T[], f: (x: T) => boolean, label: (x: T) => string) => xs.filter(f).map((x) => ({ id: x.id, name: label(x) }));
  const grants = await ctx.db.select({ n: sql<number>`count(*)` }).from(S.reportGrants).where(and(eq(S.reportGrants.companyId, ctx.companyId), eq(S.reportGrants.membershipId, ctx.membership.id), sql`${S.reportGrants.revokedAt} is null`));
  const departments = nm(ops.depts, (d) => pr.deptIn(d.id), (d) => d.name), roles = nm(ops.roles, (r) => pr.roleIn(r.id), (r) => r.name);
  const employees = nm(ops.members.filter((m) => m.status !== 'removed'), (m) => pr.employeeIn(m.id), (m) => m.name), agents = nm(ops.agents, (a) => pr.agentIn(a.id), (a) => a.name), projects = nm(ops.projects, (x) => pr.projectIn(x.id), (x) => x.name);
  const hasAny = sc.all || departments.length || roles.length || projects.length || employees.length > 1;
  const types = ['employee', ...(sc.all ? ['company'] : []), ...(departments.length ? ['department'] : []), ...(roles.length ? ['role', 'kpi'] : []), ...(agents.length ? ['ai_employee'] : []), ...(hasAny ? ['task_completion', 'risk'] : []), ...(projects.length ? ['project'] : [])];
  return { types, departments, roles, employees, agents, projects, access: { company: sc.all, financial: sc.financial, hr: sc.hr, customGrants: Number(grants[0].n), canExport: ctx.hasAny('reports.export') || ctx.isOwner } };
}

// ───────────── performance dashboard & founder dashboard ─────────────
export async function performanceRows(ctx: Ctx, dimension: string, period: string, anchor?: string | null, from?: string | null, to?: string | null) {
  let w: Window; try { w = resolveWindow(period, anchor, from, to); } catch (e) { throw badRequest((e as Error).message); }
  const now = new Date(); const ops = await loadOps(ctx.db, ctx.companyId); const sc = await reportScope(ctx, ops); const pr = makePredicates(sc, ops); const N = names(ops);
  const row = (id: string, name: string, ts: Ops['tasks'], extra: Record<string, unknown> = {}, ks: Ops['kpis'] = []) => {
    const m = taskMetrics(ts.map(lite), w, now);
    const att = ks.filter((k) => kpiAllowed(sc, k)).map((k) => computeKpi(ops, k, w, now).attainment).filter((x): x is number => x != null);
    return { id, name, ...m, kpiAttainment: att.length ? Math.round((att.reduce((a, b) => a + b, 0) / att.length) * 100) : null, kpiCount: ks.length, ...extra };
  };
  let rows: ReturnType<typeof row>[] = [];
  if (dimension === 'company') { if (!sc.all) throw forbidden('Company-wide performance needs company-wide report access'); rows = [row(ctx.companyId, 'Company', ops.tasks, {}, ops.kpis)]; }
  else if (dimension === 'department') rows = ops.depts.filter((d) => pr.deptIn(d.id)).map((d) => { const rids = new Set(ops.roles.filter((r) => r.departmentId === d.id).map((r) => r.id)); return row(d.id, d.name, ops.tasks.filter((t) => t.departmentId === d.id || (t.roleId && rids.has(t.roleId))), { roles: rids.size }, ops.kpis.filter((k) => rids.has(k.roleId))); });
  else if (dimension === 'role') rows = ops.roles.filter((r) => pr.roleIn(r.id)).map((r) => row(r.id, r.name, ops.tasks.filter((t) => t.roleId === r.id), { mode: r.roleType, department: N.dn.get(r.departmentId!) ?? null, owner: ownerName(ops, r.id, N) }, ops.kpis.filter((k) => k.roleId === r.id)));
  else if (dimension === 'employee') rows = ops.members.filter((m) => m.status === 'active' && pr.employeeIn(m.id)).map((m) => row(m.id, m.name, ops.tasks.filter((t) => t.ownerMembershipId === m.id), { roles: pr.rolesOfMember(m.id).map((r) => N.rn.get(r)).join(', ') }));
  else if (dimension === 'agent') {
    const from2 = new Date(w.from + 'T00:00:00Z'), to2 = new Date(w.to + 'T23:59:59.999Z');
    const runs = await ctx.db.select({ agentId: S.aiRuns.agentId, status: S.aiRuns.status, tok: sql<number>`${S.aiRuns.inputTokens} + ${S.aiRuns.outputTokens}` }).from(S.aiRuns).where(and(eq(S.aiRuns.companyId, ctx.companyId), gte(S.aiRuns.startedAt, from2), lte(S.aiRuns.startedAt, to2)));
    rows = ops.agents.filter((a) => pr.agentIn(a.id)).map((a) => row(a.id, a.name, ops.tasks.filter((t) => t.ownerAgentId === a.id), { status: a.status, runs: runs.filter((r) => r.agentId === a.id).length, runsOk: runs.filter((r) => r.agentId === a.id && r.status === 'succeeded').length, tokens: runs.filter((r) => r.agentId === a.id).reduce((s, r) => s + Number(r.tok), 0) }));
  } else if (dimension === 'project') rows = ops.projects.filter((x) => pr.projectIn(x.id)).map((x) => { const pt = ops.tasks.filter((t) => t.projectId === x.id && t.status !== 'cancelled'); const h = projectHealth(x, { total: pt.length, done: pt.filter((t) => t.status === 'completed').length, open: pt.filter((t) => t.status !== 'completed').length, overdue: pt.filter((t) => t.status !== 'completed' && t.dueDate && t.dueDate < today(now)).length }, now); return row(x.id, x.name, ops.tasks.filter((t) => t.projectId === x.id), { status: x.status, health: h.health, progress: h.progress == null ? null : Math.round(h.progress * 100), deadline: x.deadline }); });
  else throw badRequest('Unknown dimension');
  return { window: w, dimension, rows };
}
const ownerName = (ops: Ops, roleId: string, N: ReturnType<typeof names>) => { const a = ops.assigns.filter((x) => x.roleId === roleId).sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary))[0]; return a ? (a.membershipId ? N.mn.get(a.membershipId) : `◉ ${N.an.get(a.agentId!)}`) ?? null : null; };

export async function founderDashboard(ctx: Ctx) {
  const now = new Date(); const ops = await loadOps(ctx.db, ctx.companyId); const sc = await reportScope(ctx, ops);
  if (!sc.all) throw forbidden('The founder dashboard needs company-wide report access'); const pr = makePredicates(sc, ops); const N = names(ops);
  const t0 = today(now); const w: Window = { period: 'custom', from: addDays(t0, -29), to: t0, label: 'Last 30 days' }; const w7 = { from: addDays(t0, -6), to: t0 };
  const m = taskMetrics(ops.tasks.map(lite), w, now); const m7 = taskMetrics(ops.tasks.map(lite), w7, now);
  const projRows = ops.projects.filter((p) => !['completed', 'cancelled'].includes(p.status)).map((p) => { const pt = ops.tasks.filter((t) => t.projectId === p.id && t.status !== 'cancelled'); const s = { total: pt.length, done: pt.filter((t) => t.status === 'completed').length, open: pt.filter((t) => t.status !== 'completed').length, overdue: pt.filter((t) => t.status !== 'completed' && t.dueDate && t.dueDate < t0).length }; return { id: p.id, name: p.name, status: p.status, deadline: p.deadline, owner: N.mn.get(p.ownerMembershipId) ?? '', ...projectHealth(p, s, now), tasks: s }; });
  const att = ops.kpis.filter((k) => kpiAllowed(sc, k)).map((k) => computeKpi(ops, k, w, now).attainment).filter((x): x is number => x != null);
  const live = projRows.filter((p) => p.status === 'active');
  const health = healthScore({ onTime: m.onTimeRate, overdueRatio: m.open ? m.overdue / m.open : null, kpiAttainment: att.length ? att.reduce((a, b) => a + b, 0) / att.length : null, projectsOk: live.length ? live.filter((p) => !['late', 'at_risk'].includes(p.health)).length / live.length : null });
  const pending = await aiPendingItems(ctx); const risks = computeRisks(ops, sc, pr, pending, now);
  const from7 = new Date(w7.from + 'T00:00:00Z'); const runs = await ctx.db.select({ s: S.aiRuns.status, tok: sql<number>`${S.aiRuns.inputTokens} + ${S.aiRuns.outputTokens}` }).from(S.aiRuns).where(and(eq(S.aiRuns.companyId, ctx.companyId), gte(S.aiRuns.startedAt, from7)));
  const people = ops.members.filter((x) => x.status === 'active');
  const done7 = ops.tasks.filter((t) => t.status === 'completed' && t.completedAt && isoDay(t.completedAt) >= w7.from);
  const deptRows = ops.depts.map((d) => { const rids = new Set(ops.roles.filter((r) => r.departmentId === d.id).map((r) => r.id)); const x = taskMetrics(ops.tasks.filter((t) => t.departmentId === d.id || (t.roleId && rids.has(t.roleId))).map(lite), w, now); return { id: d.id, name: d.name, completionRate: x.completionRate, onTimeRate: x.onTimeRate, overdue: x.overdue, open: x.open }; });
  const roleRows = ops.roles.map((r) => { const x = taskMetrics(ops.tasks.filter((t) => t.roleId === r.id).map(lite), w, now); return { id: r.id, name: r.name, mode: r.roleType, completionRate: x.completionRate, onTimeRate: x.onTimeRate, overdue: x.overdue, open: x.open }; }).filter((r) => r.open || r.completionRate != null).sort((a, b) => b.overdue - a.overdue).slice(0, 8);
  const openT = ops.tasks.filter((t) => (OPEN_STATUSES as string[]).includes(t.status));
  const dto = (t: Ops['tasks'][number]) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate, owner: N.owner(t) });
  return {
    window: w, health, tasks: m, tasks7d: m7, projects: projRows, departments: deptRows, roles: roleRows, restrictedKpis: ops.kpis.filter((k) => !kpiAllowed(sc, k)).length,
    ai: { active: ops.agents.filter((a) => a.status === 'active').length, runs7d: runs.length, ok: runs.filter((r) => r.s === 'succeeded').length, blocked: runs.filter((r) => r.s === 'blocked').length, failed: runs.filter((r) => r.s === 'failed').length, tokens7d: runs.reduce((s, r) => s + Number(r.tok), 0), pendingReview: pending.length },
    humans: { active: people.length, completed7d: done7.filter((t) => t.ownerMembershipId).length, aiCompleted7d: done7.filter((t) => t.ownerAgentId).length, busiest: people.map((x) => ({ name: x.name, open: openT.filter((t) => t.ownerMembershipId === x.id).length })).sort((a, b) => b.open - a.open).slice(0, 5) },
    approvals: { tasks: ops.tasks.filter((t) => t.status === 'awaiting_approval').map(dto), aiItems: pending.length },
    deadlines: { tasks: openT.filter((t) => t.dueDate && t.dueDate >= t0 && t.dueDate <= addDays(t0, 7)).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 10).map(dto), projects: projRows.filter((p) => p.deadline && p.deadline >= t0 && p.deadline <= addDays(t0, 14)).map((p) => ({ id: p.id, name: p.name, deadline: p.deadline })) },
    overdue: openT.filter((t) => t.dueDate && t.dueDate < t0).sort((a, b) => a.dueDate!.localeCompare(b.dueDate!)).slice(0, 8).map(dto), risks: risks.slice(0, 8), riskCounts: { high: risks.filter((r) => r.severity === 'high').length, medium: risks.filter((r) => r.severity === 'medium').length, low: risks.filter((r) => r.severity === 'low').length },
  };
}

/** What anyone sees about their own work, with no report permission needed. */
export async function myWork(ctx: Ctx) {
  const t0 = today(); const rows = await ctx.db.select().from(S.tasks).where(and(eq(S.tasks.companyId, ctx.companyId), eq(S.tasks.ownerMembershipId, ctx.membership.id), sql`${S.tasks.archivedAt} is null`));
  const open = rows.filter((t) => (OPEN_STATUSES as string[]).includes(t.status));
  const dto = (t: typeof rows[number]) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, dueDate: t.dueDate });
  return { open: open.length, overdue: open.filter((t) => t.dueDate && t.dueDate < t0).length, dueSoon: open.filter((t) => t.dueDate && t.dueDate >= t0 && t.dueDate <= addDays(t0, 3)).length, awaitingMyApproval: 0, upcoming: open.sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')).slice(0, 6).map(dto), completed30d: rows.filter((t) => t.status === 'completed' && t.completedAt && isoDay(t.completedAt) >= addDays(t0, -29)).length };
}

export async function listReportGrants(ctx: Ctx) {
  ctx.require('permissions.view');
  const rows = await ctx.db.select({ g: S.reportGrants, name: S.users.name }).from(S.reportGrants).innerJoin(S.companyMemberships, and(eq(S.companyMemberships.companyId, S.reportGrants.companyId), eq(S.companyMemberships.id, S.reportGrants.membershipId))).innerJoin(S.users, eq(S.users.id, S.companyMemberships.userId)).where(and(eq(S.reportGrants.companyId, ctx.companyId), sql`${S.reportGrants.revokedAt} is null`));
  const ops = await loadOps(ctx.db, ctx.companyId); const N = names(ops);
  return rows.map(({ g, name }) => ({ id: g.id, membershipId: g.membershipId, person: name, scopeType: g.scopeType, scopeId: g.scopeId, scopeName: ({ department: N.dn, role: N.rn, project: N.pn, employee: N.mn } as Record<string, Map<string, string>>)[g.scopeType]?.get(g.scopeId) ?? '(removed)', createdAt: g.createdAt }));
}
export async function addReportGrant(ctx: Ctx, g: { membershipId: string; scopeType: 'department' | 'role' | 'project' | 'employee'; scopeId: string }) {
  ctx.require('permissions.configure');
  const ops = await loadOps(ctx.db, ctx.companyId);
  const exists = ({ department: ops.depts, role: ops.roles, project: ops.projects, employee: ops.members } as Record<string, { id: string }[]>)[g.scopeType].some((x) => x.id === g.scopeId);
  if (!exists) throw badRequest('That item does not exist in this company');
  const m = ops.members.find((x) => x.id === g.membershipId && x.status === 'active'); if (!m) throw badRequest('The person must be an active employee');
  if (!ctx.isOwner) { const mine = await reportScope(ctx, ops); const pr = makePredicates(mine, ops); const ok = g.scopeType === 'department' ? pr.deptIn(g.scopeId) : g.scopeType === 'role' ? pr.roleIn(g.scopeId) : g.scopeType === 'project' ? pr.projectIn(g.scopeId) : pr.employeeIn(g.scopeId); if (!ok) throw forbidden('You can only share report access you have yourself'); }
  const [r] = await ctx.db.insert(S.reportGrants).values({ companyId: ctx.companyId, ...g, grantedBy: ctx.user.id }).onConflictDoNothing().returning();
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'report.access_granted', 'report', r?.id ?? null, { to: m.name, ...g });
  return r ?? null;
}
export async function revokeReportGrant(ctx: Ctx, id: string) {
  ctx.require('permissions.configure');
  const r = await ctx.db.update(S.reportGrants).set({ revokedAt: new Date() }).where(and(eq(S.reportGrants.companyId, ctx.companyId), eq(S.reportGrants.id, id), sql`${S.reportGrants.revokedAt} is null`)).returning({ id: S.reportGrants.id });
  if (!r.length) throw notFound('Grant not found');
  await audit(ctx.db, ctx.companyId, ctx.user.id, 'report.access_revoked', 'report', id);
}
void kpiVisible;
