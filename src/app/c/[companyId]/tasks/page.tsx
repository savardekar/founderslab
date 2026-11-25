'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useCompany } from '@/components/company';
import { TaskDetail, prioTone, statusTone } from '@/components/task-detail';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Tabs } from '@/components/ui';
import { PRIORITIES, TASK_STATUSES, TASK_STATUS_LABEL, type TaskStatus } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

type View = 'list' | 'board' | 'calendar';
const BOARD: TaskStatus[] = ['backlog', 'todo', 'in_progress', 'blocked', 'in_review', 'awaiting_approval', 'completed'];

function Tasks() {
  const { id, can, me } = useCompany();
  const [view, setView] = useState<View>('list'); const [mine, setMine] = useState(true); const [status, setStatus] = useState(''); const [q, setQ] = useState(''); const [open, setOpen] = useState<string | null>(null); const [create, setCreate] = useState<any>(null); const [month, setMonth] = useState(new Date());
  useEffect(() => { const t = new URLSearchParams(location.search).get('task'); if (t) setOpen(t); }, []);
  const qs = `?topLevel=${view === 'calendar' ? 0 : 1}${mine ? '&mine=1' : ''}${status ? `&status=${status}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const tasks = useApi(`/companies/${id}/tasks${qs}`);
  const list = tasks.data?.tasks ?? [];
  const overdueN = list.filter((t: any) => t.overdue).length;
  if (tasks.loading && !tasks.data) return <Loading />;
  if (tasks.error) return <ErrorBox error={tasks.error} retry={tasks.reload} />;
  async function drop(taskId: string, to: TaskStatus) {
    const t = list.find((x: any) => x.id === taskId); if (!t || t.status === to) return;
    const reason = to === 'blocked' ? window.prompt('What is it blocked by?') : null; if (to === 'blocked' && !reason) return;
    if (await act(() => api('POST', `/companies/${id}/tasks/${taskId}/status`, { status: to, reason }), `Moved to ${TASK_STATUS_LABEL[to]}`)) tasks.reload(); else tasks.reload();
  }
  return (
    <>
      <PageHeader title="Tasks" subtitle={`${list.length} shown${overdueN ? ` · ${overdueN} overdue` : ''}`} actions={<button className="btn-primary" onClick={() => setCreate({ title: '', description: '', ownerKey: `m:${me.membershipId}`, roleId: '', projectId: '', responsibilityId: '', priority: 'medium', startDate: '', dueDate: '', estimatedHours: '', requiresApproval: false, deliverables: '', dependsOn: [] })}>New task</button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Tabs tabs={[{ id: 'list', label: 'List' }, { id: 'board', label: 'Board' }, { id: 'calendar', label: 'Calendar' }]} value={view} onChange={setView} />
        <div className="mb-4 ml-auto flex flex-wrap gap-2"><input aria-label="Search tasks" className="input w-48" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Status" className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option>{TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABEL[s]}</option>)}</select>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />Only mine</label></div></div>
      {list.length === 0 ? <Empty title={mine ? 'You have no tasks' : 'No tasks found'} hint="Create a task, or switch off “Only mine” to see tasks you have access to." /> : view === 'list' ? (
        <div className="card overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-slate-200 text-slate-500"><tr><th className="p-3">Task</th><th className="p-3">Status</th><th className="p-3">Priority</th><th className="p-3">Owner</th><th className="p-3">Role / project</th><th className="p-3">Due</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{list.map((t: any) => <tr key={t.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(t.id)}><td className="p-3 font-medium">{t.title}{t.subtasks.total > 0 && <span className="ml-2 text-xs text-slate-400">{t.subtasks.done}/{t.subtasks.total} subtasks</span>}{t.waitingOnDependencies > 0 && <span className="ml-2 text-xs text-amber-700">waiting on {t.waitingOnDependencies}</span>}</td>
            <td className="p-3"><Badge tone={statusTone(t.status)}>{TASK_STATUS_LABEL[t.status as TaskStatus]}</Badge></td><td className="p-3"><Badge tone={prioTone(t.priority)}>{t.priority}</Badge></td><td className="p-3">{t.ownerKind === 'ai' ? '◉ ' : ''}{t.ownerName}</td><td className="p-3 text-slate-500">{[t.roleName, t.projectName].filter(Boolean).join(' · ') || '—'}</td><td className={`p-3 ${t.overdue ? 'font-medium text-red-600' : ''}`}>{t.dueDate ?? '—'}</td></tr>)}</tbody></table></div>
      ) : view === 'board' ? (
        <div className="flex gap-3 overflow-x-auto pb-3">{BOARD.map((s) => (
          <div key={s} className="w-64 shrink-0 rounded-xl bg-slate-100 p-2" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e.dataTransfer.getData('text/plain'), s)}>
            <p className="mb-2 px-1 text-xs font-semibold uppercase text-slate-500">{TASK_STATUS_LABEL[s]} · {list.filter((t: any) => t.status === s).length}</p>
            <div className="space-y-2">{list.filter((t: any) => t.status === s).map((t: any) => <div key={t.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/plain', t.id)} onClick={() => setOpen(t.id)} className="card cursor-pointer p-3 text-sm hover:border-brand-500"><p className="font-medium">{t.title}</p><div className="mt-1 flex items-center justify-between text-xs text-slate-500"><span>{t.ownerKind === 'ai' ? '◉ ' : ''}{t.ownerName}</span><span className={t.overdue ? 'font-medium text-red-600' : ''}>{t.dueDate ?? ''}</span></div></div>)}</div></div>))}</div>
      ) : <Calendar tasks={list} month={month} setMonth={setMonth} onOpen={setOpen} />}
      {open && <TaskDetail taskId={open} onClose={() => setOpen(null)} onChanged={tasks.reload} openTask={setOpen} />}
      {create && <CreateTask cid={id} s={create} setS={setCreate} can={can} onDone={(tid: string) => { setCreate(null); tasks.reload(); setOpen(tid); }} />}
    </>
  );
}
export default function Page() { return <Suspense><Tasks /></Suspense>; }

function Calendar({ tasks, month, setMonth, onOpen }: any) {
  const y = month.getFullYear(), m = month.getMonth(); const first = new Date(y, m, 1); const lead = (first.getDay() + 6) % 7; const days = new Date(y, m + 1, 0).getDate();
  const cells = useMemo(() => Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => { const dn = i - lead + 1; return dn < 1 || dn > days ? null : `${y}-${String(m + 1).padStart(2, '0')}-${String(dn).padStart(2, '0')}`; }), [y, m, lead, days]);
  return (
    <div className="card p-3"><div className="mb-2 flex items-center justify-between"><button className="btn-ghost" onClick={() => setMonth(new Date(y, m - 1, 1))}>‹</button><b>{month.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</b><button className="btn-ghost" onClick={() => setMonth(new Date(y, m + 1, 1))}>›</button></div>
      <div className="grid grid-cols-7 gap-px bg-slate-200 text-xs">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="bg-slate-50 p-1 text-center font-medium">{d}</div>)}
        {cells.map((d, i) => <div key={i} className="min-h-20 bg-white p-1">{d && <><p className="text-slate-400">{Number(d.slice(8))}</p>{tasks.filter((t: any) => t.dueDate === d).slice(0, 3).map((t: any) => <button key={t.id} onClick={() => onOpen(t.id)} className={`mb-0.5 block w-full truncate rounded px-1 text-left ${t.overdue ? 'bg-red-50 text-red-700' : t.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : 'bg-brand-50 text-brand-700'}`}>{t.title}</button>)}</>}</div>)}</div></div>
  );
}

function CreateTask({ cid, s, setS, can, onDone }: any) {
  const mem = useApi(can('members.view') ? `/companies/${cid}/members` : null); const ag = useApi(can('agents.view') ? `/companies/${cid}/agents` : null); const roles = useApi(can('roles.view') ? `/companies/${cid}/roles` : null);
  const projects = useApi(`/companies/${cid}/projects`); const resp = useApi(s.roleId ? `/companies/${cid}/responsibilities/tracking?roleId=${s.roleId}` : null); const others = useApi(`/companies/${cid}/tasks`);
  const [busy, setBusy] = useState(false); const set = (k: string) => (e: React.ChangeEvent<any>) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <Modal open onClose={() => setS(null)} title="New task" wide>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); setBusy(true); const [k, v] = s.ownerKey.split(':');
        const r = await act(() => api('POST', `/companies/${cid}/tasks`, { title: s.title, description: s.description, owner: k === 'a' ? { agentId: v } : { membershipId: v }, roleId: s.roleId || null, projectId: s.projectId || null, responsibilityId: s.responsibilityId || null, priority: s.priority, startDate: s.startDate || null, dueDate: s.dueDate || null, estimatedHours: s.estimatedHours === '' ? null : Number(s.estimatedHours), requiresApproval: s.requiresApproval, deliverables: s.deliverables.split('\n').map((x: string) => x.trim()).filter(Boolean), dependsOn: s.dependsOn }), 'Task created'); setBusy(false); if (r) onDone(r.task.id); }}>
        <div className="sm:col-span-2"><Field label="Title *" id="t"><input id="t" className="input" required autoFocus value={s.title} onChange={set('title')} /></Field></div>
        <div className="sm:col-span-2"><Field label="Description" id="d"><textarea id="d" rows={3} className="input" value={s.description} onChange={set('description')} /></Field></div>
        <Field label="Owner" id="o"><select id="o" className="input" value={s.ownerKey} onChange={set('ownerKey')}>{mem.data ? <optgroup label="People">{mem.data.members.map((m: any) => <option key={m.membershipId} value={`m:${m.membershipId}`}>{m.name}</option>)}</optgroup> : <option value={s.ownerKey}>Me</option>}{ag.data && <optgroup label="AI employees">{ag.data.agents.filter((a: any) => a.status === 'active').map((a: any) => <option key={a.id} value={`a:${a.id}`}>◉ {a.name}</option>)}</optgroup>}</select></Field>
        <Field label="Priority" id="p"><select id="p" className="input" value={s.priority} onChange={set('priority')}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Role" id="r">{roles.data ? <select id="r" className="input" value={s.roleId} onChange={(e) => setS({ ...s, roleId: e.target.value, responsibilityId: '' })}><option value="">— None —</option>{roles.data.roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select> : <input className="input" disabled value="(no access to roles)" />}</Field>
        <Field label="Responsibility" id="rs"><select id="rs" className="input" disabled={!s.roleId} value={s.responsibilityId} onChange={set('responsibilityId')}><option value="">— None —</option>{resp.data?.responsibilities.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></Field>
        <Field label="Project" id="pj"><select id="pj" className="input" value={s.projectId} onChange={set('projectId')}><option value="">— None —</option>{projects.data?.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
        <Field label="Estimated hours" id="eh"><input id="eh" type="number" min={0} step="0.25" className="input" value={s.estimatedHours} onChange={set('estimatedHours')} /></Field>
        <Field label="Start date" id="sd"><input id="sd" type="date" className="input" value={s.startDate} onChange={set('startDate')} /></Field><Field label="Due date" id="dd"><input id="dd" type="date" className="input" value={s.dueDate} onChange={set('dueDate')} /></Field>
        <div className="sm:col-span-2"><Field label="Deliverables" id="dl" hint="One per line. All must be ticked before the task can be completed."><textarea id="dl" rows={2} className="input" value={s.deliverables} onChange={set('deliverables')} /></Field></div>
        <Field label="Depends on" id="dp" hint="Hold Ctrl/Cmd to pick several."><select id="dp" multiple className="input h-24" value={s.dependsOn} onChange={(e) => setS({ ...s, dependsOn: [...e.target.selectedOptions].map((o) => o.value) })}>{others.data?.tasks.map((t: any) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
        {can('tasks.create') && <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={s.requiresApproval} onChange={set('requiresApproval')} />Requires approval to complete</label>}
        <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setS(null)}>Cancel</button><button className="btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button></div></form>
    </Modal>
  );
}
