'use client';
import { useRef, useState } from 'react';
import { useCompany } from './company';
import { Badge, Empty, Field, Loading, Modal, fmtDate, titleCase } from './ui';
import { PRIORITIES, TASK_STATUS_LABEL, type TaskStatus } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

export const statusTone = (s: string) => (s === 'completed' ? 'green' : s === 'blocked' ? 'red' : s === 'in_progress' ? 'brand' : s === 'awaiting_approval' || s === 'in_review' ? 'amber' : 'slate') as 'green' | 'red' | 'brand' | 'amber' | 'slate';
export const prioTone = (p: string) => (p === 'critical' ? 'red' : p === 'high' ? 'amber' : 'slate') as 'red' | 'amber' | 'slate';

export function TaskDetail({ taskId, onClose, onChanged, openTask }: { taskId: string; onClose: () => void; onChanged: () => void; openTask: (id: string) => void }) {
  const { id: cid } = useCompany();
  const d = useApi(`/companies/${cid}/tasks/${taskId}`);
  const all = useApi(`/companies/${cid}/tasks`);
  const [comment, setComment] = useState(''); const [sub, setSub] = useState(''); const [blockFor, setBlockFor] = useState(false); const [reason, setReason] = useState(''); const [dep, setDep] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const reload = () => { d.reload(); onChanged(); };
  const x = d.data; const t = x?.task;
  const move = async (status: string, extra: object = {}) => { if (await act(() => api('POST', `/companies/${cid}/tasks/${taskId}/status`, { status, ...extra }), `Moved to ${TASK_STATUS_LABEL[status as TaskStatus]}`)) { setBlockFor(false); setReason(''); reload(); } };
  const patch = async (body: object) => { if (await act(() => api('PATCH', `/companies/${cid}/tasks/${taskId}`, body))) reload(); };
  async function upload(f: File) {
    const buf = new Uint8Array(await f.arrayBuffer()); let bin = ''; buf.forEach((b) => (bin += String.fromCharCode(b)));
    if (await act(() => api('POST', `/companies/${cid}/tasks/${taskId}/attachments`, { fileName: f.name, contentType: f.type || 'application/octet-stream', dataBase64: btoa(bin) }), 'Attached')) reload();
  }
  return (
    <Modal open onClose={onClose} title={t?.title ?? 'Task'} wide>
      {d.loading || !x ? <Loading /> : d.error ? <p className="text-sm text-red-700">{d.error.message}</p> : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2"><Badge tone={statusTone(t.status)}>{TASK_STATUS_LABEL[t.status as TaskStatus]}</Badge><Badge tone={prioTone(t.priority)}>{t.priority}</Badge>{t.requiresApproval && <Badge tone="violet">needs approval</Badge>}{x.view?.overdue && <Badge tone="red">overdue</Badge>}{x.waitingOn.length > 0 && <Badge tone="amber">waiting on {x.waitingOn.length}</Badge>}</div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Info k="Owner" v={`${x.view?.ownerKind === 'ai' ? '◉ ' : ''}${x.view?.ownerName ?? ''}`} /><Info k="Created by" v={x.createdByName ?? '—'} /><Info k="Role" v={x.view?.roleName ?? '—'} /><Info k="Department" v={x.view?.departmentName ?? '—'} /><Info k="Project" v={x.view?.projectName ?? '—'} /><Info k="Responsibility" v={x.responsibilityTitle ?? '—'} />
            <Info k="Start" v={t.startDate ?? '—'} /><Info k="Due" v={t.dueDate ?? '—'} /><Info k="Effort (est / actual)" v={`${t.estimatedHours ?? '—'} / ${t.actualHours ?? '—'} h`} />
          </div>
          {t.blockedReason && <p className="rounded-lg bg-red-50 p-3 text-red-800"><b>Blocked:</b> {t.blockedReason}</p>}
          {x.can.editText && !['completed', 'cancelled'].includes(t.status) && <Edit t={t} patch={patch} />}
          {t.description && <p className="whitespace-pre-wrap text-slate-700">{t.description}</p>}

          <div className="flex flex-wrap gap-2">
            {x.allowedMoves.filter((m: string) => !(m === 'completed' && t.requiresApproval)).map((m: string) => <button key={m} className={m === 'completed' ? 'btn-primary' : m === 'cancelled' ? 'btn-ghost text-red-600' : 'btn-secondary'} onClick={() => (m === 'blocked' ? setBlockFor(true) : move(m))}>{m === 'completed' && t.status === 'completed' ? 'Reopen' : `→ ${TASK_STATUS_LABEL[m as TaskStatus]}`}</button>)}
            {t.status === 'awaiting_approval' && x.can.approve && <><button className="btn-primary" onClick={async () => { if (await act(() => api('POST', `/companies/${cid}/tasks/${taskId}/approve`, {}), 'Approved')) reload(); }}>Approve</button><button className="btn-secondary" onClick={async () => { const r = window.prompt('Why is this not approved?'); if (r && (await act(() => api('POST', `/companies/${cid}/tasks/${taskId}/reject`, { reason: r }), 'Sent back'))) reload(); }}>Reject</button></>}
            {x.can.delete && <button className="btn-ghost text-red-600" onClick={async () => { if (window.confirm('Delete this task and its subtasks?') && (await act(() => api('DELETE', `/companies/${cid}/tasks/${taskId}`), 'Deleted'))) { onChanged(); onClose(); } }}>Delete</button>}
          </div>
          {blockFor && <div className="flex gap-2"><input aria-label="Blocked reason" className="input" autoFocus placeholder="What is it blocked by?" value={reason} onChange={(e) => setReason(e.target.value)} /><button className="btn-primary" disabled={!reason.trim()} onClick={() => move('blocked', { reason })}>Block</button></div>}

          {t.deliverables.length > 0 && <Section title="Deliverables"><ul className="space-y-1">{t.deliverables.map((dl: any) => <li key={dl.id}><label className="flex items-center gap-2"><input type="checkbox" checked={dl.done} disabled={!x.can.editText || ['completed', 'cancelled'].includes(t.status)} onChange={(e) => patch({ deliverables: t.deliverables.map((q: any) => (q.id === dl.id ? { ...q, done: e.target.checked } : q)) })} />{dl.title}</label></li>)}</ul></Section>}
          <Section title={`Subtasks (${x.subtasks.length})`}>
            <ul className="space-y-1">{x.subtasks.map((s: any) => <li key={s.id} className="flex items-center justify-between"><button className="text-brand-700 hover:underline" onClick={() => openTask(s.id)}>{s.title}</button><Badge tone={statusTone(s.status)}>{TASK_STATUS_LABEL[s.status as TaskStatus]}</Badge></li>)}</ul>
            <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('POST', `/companies/${cid}/tasks`, { title: sub, parentTaskId: taskId, roleId: t.roleId, projectId: t.projectId }), 'Subtask added')) { setSub(''); reload(); } }}><input aria-label="New subtask" className="input" placeholder="Add a subtask…" value={sub} onChange={(e) => setSub(e.target.value)} required /><button className="btn-secondary">Add</button></form></Section>
          <Section title="Dependencies">
            {x.dependencies.length === 0 ? <p className="text-slate-500">This task does not depend on anything.</p> : <ul className="space-y-1">{x.dependencies.map((q: any) => <li key={q.id} className="flex items-center justify-between"><button className="text-brand-700 hover:underline" onClick={() => openTask(q.id)}>{q.title}</button><span className="flex items-center gap-2"><Badge tone={statusTone(q.status)}>{TASK_STATUS_LABEL[q.status as TaskStatus]}</Badge>{x.can.editText && <button className="btn-ghost px-2 text-red-600" onClick={async () => { if (await act(() => api('PUT', `/companies/${cid}/tasks/${taskId}/dependencies`, { ids: x.dependencies.filter((z: any) => z.id !== q.id).map((z: any) => z.id) }))) reload(); }}>Remove</button>}</span></li>)}</ul>}
            {x.can.editText && all.data && <div className="mt-2 flex gap-2"><select aria-label="Add dependency" className="input" value={dep} onChange={(e) => setDep(e.target.value)}><option value="">Depends on…</option>{all.data.tasks.filter((q: any) => q.id !== taskId && !x.dependencies.some((z: any) => z.id === q.id)).map((q: any) => <option key={q.id} value={q.id}>{q.title}</option>)}</select><button className="btn-secondary" disabled={!dep} onClick={async () => { if (await act(() => api('PUT', `/companies/${cid}/tasks/${taskId}/dependencies`, { ids: [...x.dependencies.map((z: any) => z.id), dep] }))) { setDep(''); reload(); } }}>Add</button></div>}
            {x.dependents.length > 0 && <p className="mt-2 text-slate-500">Blocks: {x.dependents.map((q: any) => q.title).join(', ')}</p>}</Section>
          <Section title={`Attachments (${x.attachments.length})`}>
            <ul className="space-y-1">{x.attachments.map((a: any) => <li key={a.id} className="flex items-center justify-between"><a className="text-brand-700 hover:underline" href={`/api/companies/${cid}/tasks/${taskId}/attachments/${a.id}`}>{a.fileName}</a><span className="text-slate-400">{Math.ceil(a.sizeBytes / 1024)} KB</span></li>)}</ul>
            {x.can.editText && <><input ref={file} type="file" className="sr-only" aria-label="Attach file" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} /><button className="btn-secondary mt-2" onClick={() => file.current?.click()}>Attach a file</button><p className="mt-1 text-xs text-slate-400">PDF, images, text/CSV, Word, Excel, PowerPoint · up to 2 MB</p></>}</Section>
          <Section title={`Comments (${x.comments.length})`}>
            <ul className="space-y-2">{x.comments.map((c: any) => <li key={c.id} className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">{c.user ?? `◉ ${c.agent}`} · {fmtDate(c.createdAt)}</p><p className="whitespace-pre-wrap">{c.body}</p></li>)}</ul>
            <form className="mt-2 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('POST', `/companies/${cid}/tasks/${taskId}/comments`, { body: comment }))) { setComment(''); reload(); } }}><input aria-label="Comment" className="input" placeholder="Write a comment…" value={comment} onChange={(e) => setComment(e.target.value)} required /><button className="btn-secondary">Post</button></form></Section>
          <Section title="Activity"><ul className="space-y-1 text-xs text-slate-500">{x.activity.map((a: any) => <li key={a.id}>{fmtDate(a.createdAt)} · <b>{a.user ?? (a.agent ? `◉ ${a.agent}` : 'System')}</b> {titleCase(a.action)}{a.metadata?.to && typeof a.metadata.to === 'string' ? ` → ${TASK_STATUS_LABEL[a.metadata.to as TaskStatus] ?? a.metadata.to}` : ''}</li>)}</ul></Section>
        </div>)}
    </Modal>
  );
}
const Info = ({ k, v }: { k: string; v: string }) => <div><p className="text-xs text-slate-500">{k}</p><p className="font-medium">{v}</p></div>;
const Section = ({ title, children }: { title: string; children: React.ReactNode }) => <section><h3 className="mb-2 font-semibold">{title}</h3>{children}</section>;
function Edit({ t, patch }: { t: any; patch: (b: object) => void }) {
  const [f, setF] = useState({ title: t.title, description: t.description ?? '', priority: t.priority, startDate: t.startDate ?? '', dueDate: t.dueDate ?? '', estimatedHours: t.estimatedHours ?? '', actualHours: t.actualHours ?? '' });
  return (
    <details className="rounded-lg border border-slate-200 p-3"><summary className="cursor-pointer font-medium">Edit details</summary>
      <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); patch({ title: f.title, description: f.description, priority: f.priority, startDate: f.startDate || null, dueDate: f.dueDate || null, estimatedHours: f.estimatedHours === '' ? null : Number(f.estimatedHours), actualHours: f.actualHours === '' ? null : Number(f.actualHours) }); }}>
        <div className="sm:col-span-2"><Field label="Title" id="et"><input id="et" className="input" required value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field></div>
        <div className="sm:col-span-2"><Field label="Description" id="ed"><textarea id="ed" rows={3} className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        <Field label="Priority" id="ep"><select id="ep" className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
        <Field label="Estimated hours" id="eh"><input id="eh" type="number" min={0} step="0.25" className="input" value={f.estimatedHours} onChange={(e) => setF({ ...f, estimatedHours: e.target.value })} /></Field>
        <Field label="Start" id="es"><input id="es" type="date" className="input" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} /></Field><Field label="Due" id="edu"><input id="edu" type="date" className="input" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} /></Field>
        <Field label="Actual hours" id="ea"><input id="ea" type="number" min={0} step="0.25" className="input" value={f.actualHours} onChange={(e) => setF({ ...f, actualHours: e.target.value })} /></Field>
        <div className="flex items-end justify-end"><button className="btn-primary">Save</button></div></form></details>
  );
}
export { Empty };
