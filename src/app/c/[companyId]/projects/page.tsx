'use client';
import { Suspense, useEffect, useState } from 'react';
import { useCompany } from '@/components/company';
import { TaskDetail, statusTone } from '@/components/task-detail';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, PageHeader } from '@/components/ui';
import { PROJECT_STATUSES, TASK_STATUS_LABEL, type TaskStatus } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

const healthTone = (h: string) => (h === 'on_track' || h === 'completed' ? 'green' : h === 'late' ? 'red' : h === 'at_risk' ? 'amber' : 'slate') as 'green' | 'red' | 'amber' | 'slate';

function Projects() {
  const { id, can } = useCompany(); const list = useApi(`/companies/${id}/projects`);
  const [open, setOpen] = useState<string | null>(null); const [create, setCreate] = useState<any>(null);
  useEffect(() => { const p = new URLSearchParams(location.search).get('project'); if (p) setOpen(p); }, []);
  if (list.loading) return <Loading />; if (list.error) return <ErrorBox error={list.error} retry={list.reload} />;
  return (
    <>
      <PageHeader title="Projects" subtitle="Goals, deliverables and the tasks that deliver them." actions={can('projects.create') && <button className="btn-primary" onClick={() => setCreate({ name: '', description: '', departmentId: '', status: 'planning', startDate: '', deadline: '', goals: '', deliverables: '' })}>New project</button>} />
      {list.data.projects.length === 0 ? <Empty title="No projects yet" hint={can('projects.create') ? 'Create a project to group tasks around a goal.' : 'Projects you own or belong to appear here.'} /> : (
        <div className="grid gap-3 md:grid-cols-2">{list.data.projects.map((p: any) => (
          <button key={p.id} onClick={() => setOpen(p.id)} className="card p-4 text-left transition hover:border-brand-500"><div className="flex items-start justify-between"><div><p className="font-semibold">{p.name}</p><p className="text-sm text-slate-500">{p.ownerName}{p.departmentName ? ` · ${p.departmentName}` : ''} · team of {p.teamSize}</p></div><Badge tone={healthTone(p.health)}>{p.health.replace('_', ' ')}</Badge></div>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round((p.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}><div className="h-full bg-brand-600" style={{ width: `${Math.round((p.progress ?? 0) * 100)}%` }} /></div>
            <p className="mt-2 text-xs text-slate-500">{p.tasks.done}/{p.tasks.total} tasks · {p.deliverablesDone}/{p.deliverables.length} deliverables{p.tasks.overdue ? ` · ${p.tasks.overdue} overdue` : ''}{p.deadline ? ` · due ${p.deadline}` : ''}</p></button>))}</div>)}
      {open && <ProjectDetail pid={open} onClose={() => setOpen(null)} onChanged={list.reload} />}
      <Modal open={!!create} onClose={() => setCreate(null)} title="New project" wide>
        {create && <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const r = await act(() => api('POST', `/companies/${id}/projects`, { name: create.name, description: create.description, departmentId: create.departmentId || null, status: create.status, startDate: create.startDate || null, deadline: create.deadline || null, goals: create.goals.split('\n').map((x: string) => x.trim()).filter(Boolean), deliverables: create.deliverables.split('\n').map((x: string) => x.trim()).filter(Boolean).map((title: string) => ({ title })) }), 'Project created'); if (r) { setCreate(null); list.reload(); setOpen(r.project.id); } }}>
          <div className="sm:col-span-2"><Field label="Name *" id="n"><input id="n" className="input" required autoFocus value={create.name} onChange={(e) => setCreate({ ...create, name: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><Field label="Description" id="d"><textarea id="d" rows={2} className="input" value={create.description} onChange={(e) => setCreate({ ...create, description: e.target.value })} /></Field></div>
          <DeptSelect cid={id} value={create.departmentId} onChange={(v: string) => setCreate({ ...create, departmentId: v })} />
          <Field label="Status" id="s"><select id="s" className="input" value={create.status} onChange={(e) => setCreate({ ...create, status: e.target.value })}>{PROJECT_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Start" id="sd"><input id="sd" type="date" className="input" value={create.startDate} onChange={(e) => setCreate({ ...create, startDate: e.target.value })} /></Field><Field label="Deadline" id="dl"><input id="dl" type="date" className="input" value={create.deadline} onChange={(e) => setCreate({ ...create, deadline: e.target.value })} /></Field>
          <Field label="Goals" id="g" hint="One per line."><textarea id="g" rows={3} className="input" value={create.goals} onChange={(e) => setCreate({ ...create, goals: e.target.value })} /></Field><Field label="Deliverables" id="dv" hint="One per line."><textarea id="dv" rows={3} className="input" value={create.deliverables} onChange={(e) => setCreate({ ...create, deliverables: e.target.value })} /></Field>
          <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setCreate(null)}>Cancel</button><button className="btn-primary">Create project</button></div></form>}
      </Modal>
    </>
  );
}
export default function Page() { return <Suspense><Projects /></Suspense>; }

function DeptSelect({ cid, value, onChange }: any) { const { can } = useCompany(); const d = useApi(can('departments.view') ? `/companies/${cid}/departments` : null); return <Field label="Department" id="dp"><select id="dp" className="input" value={value} onChange={(e) => onChange(e.target.value)}><option value="">— None —</option>{d.data?.departments.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>; }

function ProjectDetail({ pid, onClose, onChanged }: { pid: string; onClose: () => void; onChanged: () => void }) {
  const { id, can } = useCompany(); const d = useApi(`/companies/${id}/projects/${pid}`); const mem = useApi(can('members.view') ? `/companies/${id}/members` : null); const [task, setTask] = useState<string | null>(null); const [newTask, setNewTask] = useState(''); const [pick, setPick] = useState('');
  const reload = () => { d.reload(); onChanged(); };
  const p = d.data?.project;
  return (
    <Modal open onClose={onClose} title={p?.name ?? 'Project'} wide>
      {!d.data ? <Loading /> : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={healthTone(p.health)}>{p.health.replace('_', ' ')}</Badge><Badge>{p.status}</Badge><span className="text-slate-500">Owner {p.ownerName}{p.departmentName ? ` · ${p.departmentName}` : ''} · {p.startDate ?? '—'} → {p.deadline ?? '—'}</span></div>
          {p.description && <p className="text-slate-700">{p.description}</p>}
          {d.data.can.edit && <div className="flex items-center gap-2"><label className="text-slate-500" htmlFor="ps">Status</label><select id="ps" className="input w-auto" value={p.status} onChange={async (e) => { if (await act(() => api('PATCH', `/companies/${id}/projects/${pid}`, { status: e.target.value }), 'Status updated')) reload(); }}>{PROJECT_STATUSES.map((s) => <option key={s}>{s}</option>)}</select></div>}
          {p.goals.length > 0 && <section><h3 className="mb-1 font-semibold">Goals</h3><ul className="list-disc pl-5">{p.goals.map((g: string) => <li key={g}>{g}</li>)}</ul></section>}
          <section><h3 className="mb-1 font-semibold">Deliverables ({p.deliverablesDone}/{p.deliverables.length})</h3><ul className="space-y-1">{p.deliverables.map((dl: any) => <li key={dl.id}><label className="flex items-center gap-2"><input type="checkbox" checked={dl.done} disabled={!d.data.can.edit} onChange={async (e) => { if (await act(() => api('PATCH', `/companies/${id}/projects/${pid}`, { deliverables: p.deliverables.map((q: any) => (q.id === dl.id ? { ...q, done: e.target.checked } : q)) }))) reload(); }} />{dl.title}</label></li>)}</ul></section>
          <section><h3 className="mb-1 font-semibold">Team</h3><div className="flex flex-wrap gap-1"><Badge tone="brand">{p.ownerName} (owner)</Badge>{d.data.team.map((m: any) => <Badge key={m.id} tone={m.kind === 'ai' ? 'violet' : 'slate'}>{m.kind === 'ai' ? '◉ ' : ''}{m.name}</Badge>)}</div>
            {d.data.can.assign && mem.data && <div className="mt-2 flex gap-2"><select aria-label="Add team member" className="input max-w-xs" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Add a team member…</option>{mem.data.members.filter((m: any) => m.membershipId !== p.ownerMembershipId && !d.data.team.some((t: any) => t.membershipId === m.membershipId)).map((m: any) => <option key={m.membershipId} value={m.membershipId}>{m.name}</option>)}</select><button className="btn-secondary" disabled={!pick} onClick={async () => { if (await act(() => api('PATCH', `/companies/${id}/projects/${pid}`, { team: { membershipIds: [...d.data.team.filter((t: any) => t.membershipId).map((t: any) => t.membershipId), pick], agentIds: d.data.team.filter((t: any) => t.agentId).map((t: any) => t.agentId) } }), 'Team updated')) { setPick(''); reload(); } }}>Add</button></div>}</section>
          <section><h3 className="mb-1 font-semibold">Tasks ({p.tasks.done}/{p.tasks.total} done)</h3>
            {d.data.tasks.length === 0 ? <p className="text-slate-500">No tasks yet.</p> : <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">{d.data.tasks.map((t: any) => <li key={t.id} className="flex items-center justify-between p-2"><button className="text-left text-brand-700 hover:underline" onClick={() => setTask(t.id)}>{t.title}</button><span className="flex items-center gap-2 text-xs text-slate-500">{t.dueDate}<Badge tone={statusTone(t.status)}>{TASK_STATUS_LABEL[t.status as TaskStatus]}</Badge></span></li>)}</ul>}
            <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('POST', `/companies/${id}/tasks`, { title: newTask, projectId: pid }), 'Task added')) { setNewTask(''); reload(); } }}><input aria-label="New task" className="input" placeholder="Add a task to this project…" value={newTask} onChange={(e) => setNewTask(e.target.value)} required /><button className="btn-secondary">Add</button></form></section>
          {d.data.can.delete && <button className="btn-ghost text-red-600" onClick={async () => { if (window.confirm('Delete this project?') && (await act(() => api('DELETE', `/companies/${id}/projects/${pid}`), 'Project deleted'))) { onChanged(); onClose(); } }}>Delete project</button>}
        </div>)}
      {task && <TaskDetail taskId={task} onClose={() => setTask(null)} onChanged={reload} openTask={setTask} />}
    </Modal>
  );
}
