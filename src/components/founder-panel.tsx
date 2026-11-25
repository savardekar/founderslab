'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useCompany } from './company';
import { TaskDetail, statusTone } from './task-detail';
import { Badge, Loading } from './ui';
import { TASK_STATUS_LABEL, type TaskStatus } from '@/lib/constants';
import { useApi } from '@/lib/client';

const sev = (s: string) => (s === 'high' ? 'red' : s === 'medium' ? 'amber' : 'slate') as 'red' | 'amber' | 'slate';
const pc = (v: number | null) => (v == null ? '—' : `${v}%`);
const Card = ({ title, children, className = '' }: { title: string; children: React.ReactNode; className?: string }) => <section className={`card p-5 ${className}`}><h2 className="mb-3 font-semibold">{title}</h2>{children}</section>;

/** "My work" for everyone. */
export function MyWork() {
  const { id } = useCompany(); const w = useApi(`/companies/${id}/me/work`); const [open, setOpen] = useState<string | null>(null);
  if (!w.data) return null; const x = w.data;
  return (
    <Card title="My work" className="mt-6">
      <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4">{[['Open', x.open], ['Overdue', x.overdue], ['Due in 3 days', x.dueSoon], ['Done (30 days)', x.completed30d]].map(([k, v]) => <div key={k as string} className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">{k}</p><p className={`text-xl font-semibold ${k === 'Overdue' && Number(v) > 0 ? 'text-red-600' : ''}`}>{v}</p></div>)}</div>
      {x.upcoming.length === 0 ? <p className="text-sm text-slate-500">Nothing assigned to you. <Link className="text-brand-700 underline" href={`/c/${id}/tasks`}>Open tasks</Link></p> : <ul className="divide-y divide-slate-100 text-sm">{x.upcoming.map((t: any) => <li key={t.id} className="flex items-center justify-between py-2"><button className="text-left hover:text-brand-700 hover:underline" onClick={() => setOpen(t.id)}>{t.title}</button><span className="flex items-center gap-2 text-xs text-slate-500">{t.dueDate ?? 'no date'}<Badge tone={statusTone(t.status)}>{TASK_STATUS_LABEL[t.status as TaskStatus]}</Badge></span></li>)}</ul>}
      {open && <TaskDetail taskId={open} onClose={() => setOpen(null)} onChanged={w.reload} openTask={setOpen} />}
    </Card>
  );
}

/** Founder command center: only rendered when the API grants company-wide report access. */
export function FounderPanel() {
  const { id } = useCompany(); const d = useApi(`/companies/${id}/dashboard/founder`); const [open, setOpen] = useState<string | null>(null);
  if (d.loading) return <Loading />; if (d.error || !d.data) return null; const x = d.data; const h = x.health; const base = `/c/${id}`;
  const tone = h.score == null ? 'text-slate-500' : h.score >= 80 ? 'text-emerald-600' : h.score >= 60 ? 'text-amber-600' : 'text-red-600';
  const taskLink = (t: any) => <button className="text-left hover:text-brand-700 hover:underline" onClick={() => setOpen(t.id)}>{t.title}</button>;
  return (
    <div className="mt-6 space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Company health"><p className={`text-4xl font-bold ${tone}`}>{h.score ?? '—'}<span className="ml-2 text-base font-medium">{h.label}</span></p>
          <ul className="mt-3 space-y-1 text-xs text-slate-500">{h.components.map((c: any) => <li key={c.key} className="flex justify-between"><span>{c.key} · {c.weight}%</span><b>{c.value == null ? 'no data' : Math.round(c.value)}</b></li>)}</ul>{x.restrictedKpis > 0 && <p className="mt-2 text-xs text-slate-400">{x.restrictedKpis} sensitive KPI(s) not counted.</p>}</Card>
        <Card title={`Task completion · ${x.window.label}`}><div className="grid grid-cols-2 gap-3 text-sm">{[['Completion rate', pc(x.tasks.completionRate)], ['On-time rate', pc(x.tasks.onTimeRate)], ['Completed', x.tasks.completedInWindow], ['Overdue', x.tasks.overdue], ['Open', x.tasks.open], ['Blocked', x.tasks.blocked]].map(([k, v]) => <div key={k as string}><p className="text-xs text-slate-500">{k}</p><p className={`text-lg font-semibold ${k === 'Overdue' && Number(v) > 0 ? 'text-red-600' : ''}`}>{v}</p></div>)}</div></Card>
        <Card title="Important risks"><p className="mb-2 text-xs text-slate-500">{x.riskCounts.high} high · {x.riskCounts.medium} medium · {x.riskCounts.low} low</p>{x.risks.length === 0 ? <p className="text-sm text-emerald-700">No open risks detected.</p> : <ul className="space-y-2 text-sm">{x.risks.slice(0, 5).map((r: any, i: number) => <li key={i}><Badge tone={sev(r.severity)}>{r.severity}</Badge> <b>{r.category}:</b> {r.subject}<div className="text-xs text-slate-500">{r.detail}</div></li>)}</ul>}<Link className="mt-2 inline-block text-xs text-brand-700 underline" href={`${base}/reports`}>Full risk report →</Link></Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Active projects">{x.projects.length === 0 ? <p className="text-sm text-slate-500">No active projects.</p> : <ul className="space-y-2 text-sm">{x.projects.slice(0, 6).map((p: any) => <li key={p.id} className="flex items-center justify-between"><Link className="hover:text-brand-700 hover:underline" href={`${base}/projects?project=${p.id}`}>{p.name}</Link><span className="flex items-center gap-2 text-xs text-slate-500">{p.progress == null ? '—' : `${Math.round(p.progress * 100)}%`}<Badge tone={p.health === 'on_track' ? 'green' : p.health === 'late' ? 'red' : p.health === 'at_risk' ? 'amber' : 'slate'}>{p.health.replace('_', ' ')}</Badge></span></li>)}</ul>}</Card>
        <Card title="Pending approvals">{x.approvals.tasks.length + x.approvals.aiItems === 0 ? <p className="text-sm text-slate-500">Nothing is waiting for you.</p> : <ul className="space-y-1 text-sm">{x.approvals.tasks.map((t: any) => <li key={t.id}>{taskLink(t)} <span className="text-xs text-slate-400">· {t.owner}</span></li>)}{x.approvals.aiItems > 0 && <li><Link className="text-brand-700 underline" href={`${base}/ai-employees`}>{x.approvals.aiItems} AI work item(s) to review</Link></li>}</ul>}</Card>
        <Card title="Department performance"><table className="w-full text-sm"><thead className="text-left text-xs text-slate-500"><tr><th>Department</th><th>Completion</th><th>On-time</th><th>Overdue</th></tr></thead><tbody>{x.departments.map((r: any) => <tr key={r.id}><td className="py-1">{r.name}</td><td>{pc(r.completionRate)}</td><td>{pc(r.onTimeRate)}</td><td className={r.overdue ? 'text-red-600' : ''}>{r.overdue}</td></tr>)}</tbody></table>{x.departments.length === 0 && <p className="text-sm text-slate-500">No departments yet.</p>}</Card>
        <Card title="Role performance (most overdue first)"><table className="w-full text-sm"><thead className="text-left text-xs text-slate-500"><tr><th>Role</th><th>Mode</th><th>Completion</th><th>Overdue</th></tr></thead><tbody>{x.roles.map((r: any) => <tr key={r.id}><td className="py-1">{r.name}</td><td className="text-xs text-slate-500">{r.mode}</td><td>{pc(r.completionRate)}</td><td className={r.overdue ? 'text-red-600' : ''}>{r.overdue}</td></tr>)}</tbody></table>{x.roles.length === 0 && <p className="text-sm text-slate-500">No task activity yet.</p>}</Card>
        <Card title="AI employee activity (7 days)"><p className="text-sm">{x.ai.active} active · {x.ai.runs7d} runs ({x.ai.ok} ok, {x.ai.blocked} blocked, {x.ai.failed} failed) · {x.ai.tokens7d.toLocaleString()} tokens</p><p className="mt-1 text-sm text-slate-500">{x.ai.pendingReview} item(s) awaiting human review · AI completed {x.humans.aiCompleted7d} task(s)</p></Card>
        <Card title="Human activity (7 days)"><p className="text-sm">{x.humans.active} active people · {x.humans.completed7d} tasks completed</p><ul className="mt-2 text-sm text-slate-600">{x.humans.busiest.map((b: any) => <li key={b.name}>{b.name}: {b.open} open</li>)}</ul></Card>
        <Card title="Overdue tasks">{x.overdue.length === 0 ? <p className="text-sm text-emerald-700">Nothing overdue.</p> : <ul className="space-y-1 text-sm">{x.overdue.map((t: any) => <li key={t.id}>{taskLink(t)} <span className="text-xs text-red-600">· due {t.dueDate}</span> <span className="text-xs text-slate-400">· {t.owner}</span></li>)}</ul>}</Card>
        <Card title="Upcoming deadlines">{x.deadlines.tasks.length + x.deadlines.projects.length === 0 ? <p className="text-sm text-slate-500">Nothing due in the next week.</p> : <ul className="space-y-1 text-sm">{x.deadlines.tasks.map((t: any) => <li key={t.id}>{taskLink(t)} <span className="text-xs text-slate-500">· {t.dueDate} · {t.owner}</span></li>)}{x.deadlines.projects.map((p: any) => <li key={p.id}>▣ {p.name} <span className="text-xs text-slate-500">· {p.deadline}</span></li>)}</ul>}</Card>
      </div>
      {open && <TaskDetail taskId={open} onClose={() => setOpen(null)} onChanged={d.reload} openTask={setOpen} />}
    </div>
  );
}
