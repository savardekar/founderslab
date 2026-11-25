import { OPEN_STATUSES, type KpiSource } from '@/lib/constants';

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
export const today = (now = new Date()) => isoDay(now);
export const addDays = (day: string, n: number) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);

export type Window = { period: string; from: string; to: string; label: string };
/** Calendar windows in UTC: day, ISO week (Mon–Sun), month, quarter, or a custom range (max 366 days). */
export function resolveWindow(period: string, anchor?: string | null, from?: string | null, to?: string | null, now = new Date()): Window {
  const a = anchor && /^\d{4}-\d{2}-\d{2}$/.test(anchor) ? anchor : today(now);
  const d = new Date(a + 'T00:00:00Z');
  if (period === 'daily') return { period, from: a, to: a, label: a };
  if (period === 'weekly') { const dow = (d.getUTCDay() + 6) % 7; const f = addDays(a, -dow); return { period, from: f, to: addDays(f, 6), label: `Week of ${f}` }; }
  if (period === 'monthly') { const f = isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); const t = isoDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); return { period, from: f, to: t, label: f.slice(0, 7) }; }
  if (period === 'quarterly') { const q = Math.floor(d.getUTCMonth() / 3); const f = isoDay(new Date(Date.UTC(d.getUTCFullYear(), q * 3, 1))); const t = isoDay(new Date(Date.UTC(d.getUTCFullYear(), q * 3 + 3, 0))); return { period, from: f, to: t, label: `${d.getUTCFullYear()} Q${q + 1}` }; }
  if (period === 'custom') {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!from || !to || !re.test(from) || !re.test(to) || from > to) throw new Error('Custom range needs valid from and to dates (from ≤ to)');
    if (daysBetween(from, to) > 366) throw new Error('Custom range is limited to 366 days');
    return { period, from, to, label: `${from} → ${to}` };
  }
  throw new Error('Unknown period');
}

export type TaskLite = { id: string; status: string; dueDate: string | null; startDate?: string | null; completedAt: Date | null; createdAt: Date; priority: string; roleId: string | null; departmentId: string | null; ownerMembershipId: string | null; ownerAgentId: string | null; projectId: string | null; title?: string; statusChangedAt?: Date };
const open = new Set<string>(OPEN_STATUSES);

export type TaskMetrics = {
  total: number; open: number; dueInWindow: number; dueCompleted: number; completedInWindow: number; createdInWindow: number; overdue: number; blocked: number; awaitingApproval: number;
  completionRate: number | null; onTimeRate: number | null; avgCycleDays: number | null;
};
/**
 * Definitions (also printed on every report):
 *  completion rate = of non-cancelled tasks DUE in the window, % that are completed.
 *  on-time rate    = of tasks COMPLETED in the window that have a due date, % completed on/before the due date.
 *  overdue         = open tasks whose due date is before today.
 *  cycle time      = average days from creation to completion of tasks completed in the window.
 */
export function taskMetrics(tasks: TaskLite[], w: { from: string; to: string }, now = new Date()): TaskMetrics {
  const t0 = today(now);
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const due = live.filter((t) => t.dueDate && t.dueDate >= w.from && t.dueDate <= w.to);
  const doneIn = tasks.filter((t) => t.status === 'completed' && t.completedAt && isoDay(t.completedAt) >= w.from && isoDay(t.completedAt) <= w.to);
  const withDue = doneIn.filter((t) => t.dueDate);
  const cyc = doneIn.map((t) => (t.completedAt!.getTime() - t.createdAt.getTime()) / 864e5);
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    total: live.length, open: live.filter((t) => open.has(t.status)).length,
    dueInWindow: due.length, dueCompleted: due.filter((t) => t.status === 'completed').length,
    completedInWindow: doneIn.length, createdInWindow: tasks.filter((t) => isoDay(t.createdAt) >= w.from && isoDay(t.createdAt) <= w.to).length,
    overdue: live.filter((t) => open.has(t.status) && t.dueDate && t.dueDate < t0).length,
    blocked: live.filter((t) => t.status === 'blocked').length, awaitingApproval: live.filter((t) => t.status === 'awaiting_approval').length,
    completionRate: pct(due.filter((t) => t.status === 'completed').length, due.length),
    onTimeRate: pct(withDue.filter((t) => isoDay(t.completedAt!) <= t.dueDate!).length, withDue.length),
    avgCycleDays: cyc.length ? Math.round((cyc.reduce((a, b) => a + b, 0) / cyc.length) * 10) / 10 : null,
  };
}

/** Value of a task-derived KPI, or null when there is nothing to measure. */
export function calcKpi(source: KpiSource | string, tasks: TaskLite[], w: { from: string; to: string }, now = new Date()): number | null {
  const m = taskMetrics(tasks, w, now);
  switch (source) {
    case 'tasks.completion_rate': return m.completionRate;
    case 'tasks.on_time_rate': return m.onTimeRate;
    case 'tasks.overdue_count': return m.overdue;
    case 'tasks.completed_count': return m.completedInWindow;
    case 'tasks.blocked_count': return m.blocked;
    default: return null;
  }
}

export type KpiStatus = 'met' | 'on_track' | 'at_risk' | 'off_track' | 'no_data';
/** attainment 1.0 = target reached. Lower-is-better KPIs invert the ratio. */
export function kpiAttainment(actual: number | null, target: number | null, direction: string): { attainment: number | null; status: KpiStatus } {
  if (actual == null || target == null) return { attainment: null, status: 'no_data' };
  let a: number;
  if (direction === 'lower') a = actual <= 0 ? 1 : target <= 0 ? 0 : target / actual; else a = target === 0 ? (actual >= 0 ? 1 : 0) : actual / target;
  a = Math.max(0, a);
  const status: KpiStatus = a >= 1 ? 'met' : a >= 0.8 ? 'on_track' : a >= 0.5 ? 'at_risk' : 'off_track';
  return { attainment: Math.round(a * 1000) / 1000, status };
}

/** Transparent company-health score: weighted average of the components that have data. */
export function healthScore(c: { onTime: number | null; overdueRatio: number | null; kpiAttainment: number | null; projectsOk: number | null }) {
  const parts = [
    { key: 'Delivery (on-time rate)', weight: 40, value: c.onTime },
    { key: 'Execution (no overdue backlog)', weight: 25, value: c.overdueRatio == null ? null : Math.max(0, 100 - c.overdueRatio * 100) },
    { key: 'Goals (KPI attainment)', weight: 20, value: c.kpiAttainment == null ? null : Math.min(100, c.kpiAttainment * 100) },
    { key: 'Projects (not at risk)', weight: 15, value: c.projectsOk == null ? null : c.projectsOk * 100 },
  ];
  const used = parts.filter((p) => p.value != null);
  if (!used.length) return { score: null as number | null, label: 'Not enough data yet', components: parts };
  const w = used.reduce((a, p) => a + p.weight, 0);
  const score = Math.round(used.reduce((a, p) => a + (p.value as number) * p.weight, 0) / w);
  return { score, label: score >= 80 ? 'Healthy' : score >= 60 ? 'Needs attention' : 'At risk', components: parts };
}
