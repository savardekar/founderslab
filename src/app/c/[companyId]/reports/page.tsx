'use client';
import { useEffect, useState } from 'react';
import { useCompany } from '@/components/company';
import { Empty, ErrorBox, Field, Loading, PageHeader } from '@/components/ui';
import { act, api, useApi } from '@/lib/client';

const LABEL: Record<string, string> = { company: 'Company Performance', department: 'Department', role: 'Role Performance', employee: 'Employee Performance', ai_employee: 'AI Employee Performance', task_completion: 'Task Completion', kpi: 'KPI', project: 'Project', risk: 'Risk' };

export default function Reports() {
  const { id, can, me } = useCompany(); const cat = useApi(`/companies/${id}/reports/catalog`);
  const [f, setF] = useState<any>({ type: 'employee', period: 'monthly', anchor: '', from: '', to: '', departmentId: '', roleId: '', membershipId: '', agentId: '', projectId: '' });
  const [rep, setRep] = useState<any>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (cat.data && !cat.data.types.includes(f.type)) setF((x: any) => ({ ...x, type: cat.data.types[0] })); }, [cat.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (cat.loading) return <Loading />; if (cat.error) return <ErrorBox error={cat.error} retry={cat.reload} />;
  const c = cat.data; const set = (k: string) => (e: React.ChangeEvent<any>) => { setF({ ...f, [k]: e.target.value }); setRep(null); };
  const query = () => { const q = new URLSearchParams({ type: f.type, period: f.period }); for (const k of ['anchor', 'from', 'to']) if (f[k] && (k === 'anchor' || f.period === 'custom')) q.set(k, f[k]); const ent: Record<string, string> = { department: 'departmentId', role: 'roleId', employee: 'membershipId', ai_employee: 'agentId', project: 'projectId' }; if (ent[f.type] && f[ent[f.type]]) q.set(ent[f.type], f[ent[f.type]]); if (['kpi', 'task_completion'].includes(f.type)) { if (f.roleId) q.set('roleId', f.roleId); else if (f.departmentId) q.set('departmentId', f.departmentId); } return q.toString(); };
  const needsEntity = (['department', 'role', 'ai_employee', 'project'] as string[]).includes(f.type);
  const entityOk = !needsEntity || f[{ department: 'departmentId', role: 'roleId', ai_employee: 'agentId', project: 'projectId' }[f.type as 'department']];
  async function run() { setBusy(true); const r = await act(() => api('GET', `/companies/${id}/reports/run?${query()}`)); setBusy(false); if (r) setRep(r); }
  async function download(format: 'csv' | 'pdf') {
    const res = await fetch(`/api/companies/${id}/reports/export?${query()}&format=${format}`, { credentials: 'same-origin' });
    if (!res.ok) { const j = await res.json().catch(() => ({})); return act(async () => { throw new Error(j.error ?? 'Export failed'); }); }
    const blob = await res.blob(); const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `report.${format}`;
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  }
  const Pick = ({ k, label, items }: { k: string; label: string; items: { id: string; name: string }[] }) => <Field label={label} id={k}><select id={k} className="input" value={f[k]} onChange={set(k)}>{!needsEntity || f.type === 'kpi' || f.type === 'task_completion' || k === 'membershipId' ? <option value="">{k === 'membershipId' ? 'Me' : 'All I can see'}</option> : <option value="">Select…</option>}{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select></Field>;
  return (
    <>
      <PageHeader title="Reports" subtitle="Each report is limited to what your permissions allow. Exports are checked again before anything is generated." />
      <div className="card mb-6 grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Report" id="type"><select id="type" className="input" value={f.type} onChange={set('type')}>{c.types.map((t: string) => <option key={t} value={t}>{LABEL[t] ?? t}</option>)}</select></Field>
        {f.type === 'department' && <Pick k="departmentId" label="Department" items={c.departments} />}{f.type === 'role' && <Pick k="roleId" label="Role" items={c.roles} />}{f.type === 'employee' && <Pick k="membershipId" label="Employee" items={c.employees} />}{f.type === 'ai_employee' && <Pick k="agentId" label="AI employee" items={c.agents} />}{f.type === 'project' && <Pick k="projectId" label="Project" items={c.projects} />}
        {(f.type === 'kpi' || f.type === 'task_completion') && <Pick k="roleId" label="Role (optional)" items={c.roles} />}
        <Field label="Period" id="period"><select id="period" className="input" value={f.period} onChange={set('period')}>{['daily', 'weekly', 'monthly', 'quarterly', 'custom'].map((p) => <option key={p}>{p}</option>)}</select></Field>
        {f.period === 'custom' ? <><Field label="From" id="from"><input id="from" type="date" className="input" value={f.from} onChange={set('from')} /></Field><Field label="To" id="to"><input id="to" type="date" className="input" value={f.to} onChange={set('to')} /></Field></> : <Field label="Around date (optional)" id="anchor"><input id="anchor" type="date" className="input" value={f.anchor} onChange={set('anchor')} /></Field>}
        <div className="flex items-end"><button className="btn-primary w-full" disabled={busy || !entityOk || (f.period === 'custom' && (!f.from || !f.to))} onClick={run}>{busy ? 'Building…' : 'Run report'}</button></div>
      </div>
      {!rep ? <Empty title="Choose a report and run it" hint={`You can report on: ${c.types.map((t: string) => LABEL[t] ?? t).join(', ')}.`} /> : (
        <article className="card p-6">
          <header className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-xl font-semibold">{rep.title}</h2><p className="text-sm text-slate-500">{rep.subtitle} · {rep.from} → {rep.to} · {rep.scopeNote}</p><p className="text-xs text-slate-400">Generated {new Date(rep.generatedAt).toLocaleString()} by {rep.generatedBy}</p></div>
            <div className="flex gap-2"><button className="btn-secondary" onClick={() => download('csv')}>Export CSV</button><button className="btn-secondary" onClick={() => download('pdf')}>Export PDF</button></div></header>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">{rep.summary.map((s: any) => <div key={s.label} className="rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-500">{s.label}</p><p className="text-lg font-semibold">{String(s.value ?? '—')}</p>{s.hint && <p className="text-xs text-slate-400">{s.hint}</p>}</div>)}</div>
          {rep.tables.filter((t: any) => t.rows.length).map((t: any) => <section key={t.title} className="mb-6"><h3 className="mb-2 font-semibold">{t.title}</h3><div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full text-left text-sm"><thead className="bg-slate-50 text-slate-500"><tr>{t.columns.map((col: string) => <th key={col} className="p-2">{col}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{t.rows.map((r: any[], i: number) => <tr key={i}>{r.map((cell, j) => <td key={j} className="p-2">{cell ?? '—'}</td>)}</tr>)}</tbody></table></div></section>)}
          {rep.restricted.length > 0 && <div className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900"><b>Not included (restricted):</b><ul className="list-disc pl-5">{rep.restricted.map((x: string) => <li key={x}>{x}</li>)}</ul></div>}
          <footer className="border-t border-slate-100 pt-3 text-xs text-slate-400">{rep.definitions.map((d: string) => <p key={d}>• {d}</p>)}</footer>
        </article>)}
      {can('permissions.view') && <Grants cid={id} me={me} can={can} />}
    </>
  );
}

function Grants({ cid, can }: any) {
  const g = useApi(`/companies/${cid}/report-grants`); const mem = useApi(can('members.view') ? `/companies/${cid}/members` : null); const depts = useApi(can('departments.view') ? `/companies/${cid}/departments` : null); const roles = useApi(can('roles.view') ? `/companies/${cid}/roles` : null); const projs = useApi(`/companies/${cid}/projects`);
  const [s, setS] = useState({ membershipId: '', scopeType: 'department', scopeId: '' });
  const items: { id: string; name: string }[] = s.scopeType === 'department' ? depts.data?.departments ?? [] : s.scopeType === 'role' ? roles.data?.roles ?? [] : s.scopeType === 'project' ? projs.data?.projects ?? [] : (mem.data?.members ?? []).map((m: any) => ({ id: m.membershipId, name: m.name }));
  return (
    <section className="card mt-8 p-5"><h2 className="font-semibold">Custom report access</h2><p className="mb-3 text-sm text-slate-500">Give a person access to one more department, role, project or employee's reports, beyond what their role grants. Reporting lines never do this automatically, and financial/HR data still needs its own permission.</p>
      {g.data && (g.data.grants.length === 0 ? <p className="mb-3 text-sm text-slate-400">No custom grants.</p> : <ul className="mb-3 divide-y divide-slate-100 text-sm">{g.data.grants.map((x: any) => <li key={x.id} className="flex items-center justify-between py-2"><span><b>{x.person}</b> → {x.scopeType}: {x.scopeName}</span>{can('permissions.configure') && <button className="btn-ghost text-red-600" onClick={async () => { if (await act(() => api('DELETE', `/companies/${cid}/report-grants/${x.id}`), 'Revoked')) g.reload(); }}>Revoke</button>}</li>)}</ul>)}
      {can('permissions.configure') && mem.data && <div className="flex flex-wrap gap-2"><select aria-label="Person" className="input w-auto" value={s.membershipId} onChange={(e) => setS({ ...s, membershipId: e.target.value })}><option value="">Person…</option>{mem.data.members.map((m: any) => <option key={m.membershipId} value={m.membershipId}>{m.name}</option>)}</select>
        <select aria-label="Type" className="input w-auto" value={s.scopeType} onChange={(e) => setS({ ...s, scopeType: e.target.value, scopeId: '' })}>{['department', 'role', 'project', 'employee'].map((t) => <option key={t}>{t}</option>)}</select>
        <select aria-label="Item" className="input w-auto" value={s.scopeId} onChange={(e) => setS({ ...s, scopeId: e.target.value })}><option value="">Item…</option>{items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</select>
        <button className="btn-primary" disabled={!s.membershipId || !s.scopeId} onClick={async () => { if (await act(() => api('POST', `/companies/${cid}/report-grants`, s), 'Access granted')) { setS({ ...s, scopeId: '' }); g.reload(); } }}>Grant</button></div>}
    </section>
  );
}
