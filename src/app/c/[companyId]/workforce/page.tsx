'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCompany } from '@/components/company';
import { Badge, Empty, ErrorBox, Loading, PageHeader, Tabs, roleTone } from '@/components/ui';
import { ROLE_TYPE_LABEL } from '@/lib/constants';
import { useApi } from '@/lib/client';

const tone = (s: string) => (s === 'active' ? 'green' : s === 'on_leave' ? 'amber' : 'slate') as 'green' | 'amber' | 'slate';

export default function Workforce() {
  const { id, can } = useCompany();
  const [tab, setTab] = useState<'roles' | 'directory'>('roles');
  const wf = useApi(`/companies/${id}/workforce`);
  const dir = useApi(can('members.view') || can('agents.view') ? `/companies/${id}/workforce/directory` : null);
  const [mode, setMode] = useState(''); const [q, setQ] = useState(''); const [kind, setKind] = useState('');
  const roles = useMemo(() => (wf.data?.roles ?? []).filter((r: any) => (!mode || r.mode === mode) && (!q || r.name.toLowerCase().includes(q.toLowerCase()))), [wf.data, mode, q]);
  const people = useMemo(() => (dir.data?.people ?? []).filter((p: any) => (!kind || p.kind === kind) && (!q || p.name.toLowerCase().includes(q.toLowerCase()))), [dir.data, kind, q]);
  if (wf.loading) return <Loading />;
  if (wf.error) return <ErrorBox error={wf.error} retry={wf.reload} />;
  const c = wf.data.counts;
  const card = (label: string, n: number, m: string, hint: string) => (
    <button onClick={() => { setTab('roles'); setMode(mode === m ? '' : m); }} className={`card p-4 text-left transition hover:border-brand-500 ${mode === m ? 'border-brand-500 ring-2 ring-brand-500/20' : ''}`}><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-2xl font-semibold">{n}</p><p className="text-xs text-slate-400">{hint}</p></button>);
  return (
    <>
      <PageHeader title="Workforce" subtitle="Who — person or AI — holds every role, and how each role is run." />
      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {card('AI mode', c.ai, 'ai', 'AI performs the role')}{card('Human mode', c.human, 'human', 'A person owns the role')}{card('Hybrid mode', c.hybrid, 'hybrid', 'AI and people together')}{card('Vacant', c.vacant, 'vacant', 'Nobody assigned')}
      </section>
      <Tabs tabs={[{ id: 'roles', label: 'Role assignment' }, ...(dir.data ? [{ id: 'directory' as const, label: `Directory (${dir.data.people.length})` }] : [])]} value={tab} onChange={setTab} />
      <div className="mb-4 flex flex-wrap gap-2"><input aria-label="Search" className="input max-w-xs" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        {tab === 'roles' ? <select aria-label="Mode" className="input w-auto" value={mode} onChange={(e) => setMode(e.target.value)}><option value="">All modes</option>{(['ai', 'human', 'hybrid', 'vacant'] as const).map((m) => <option key={m} value={m}>{ROLE_TYPE_LABEL[m]}</option>)}</select>
          : <select aria-label="Kind" className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">People and AI</option><option value="human">People</option><option value="ai">AI employees</option></select>}</div>
      {tab === 'roles' && (roles.length === 0 ? <Empty title="No roles match" hint="Create roles in the Company Builder, then assign people or AI employees here." /> : (
        <div className="card overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-slate-200 text-slate-500"><tr><th className="p-3">Role</th><th className="p-3">Mode</th><th className="p-3">Owner</th><th className="p-3">Team</th><th className="p-3">Department</th><th className="p-3">Reports to</th><th className="p-3">Responsibilities</th></tr></thead>
          <tbody className="divide-y divide-slate-100 align-top">{roles.map((r: any) => (
            <tr key={r.id} className="hover:bg-slate-50"><td className="p-3"><Link className="font-medium text-brand-700 hover:underline" href={`/c/${id}/roles/${r.id}`}>{r.name}</Link>{r.status === 'inactive' && <> <Badge>inactive</Badge></>}</td>
              <td className="p-3"><Badge tone={roleTone(r.mode)}>{ROLE_TYPE_LABEL[r.mode as keyof typeof ROLE_TYPE_LABEL]}</Badge></td>
              <td className="p-3">{r.owner ? <span>{r.owner.kind === 'ai' ? '◉ ' : ''}{r.owner.name}</span> : <span className="text-amber-700">Unowned</span>}</td>
              <td className="p-3"><div className="flex flex-wrap gap-1">{r.assignees.length ? r.assignees.map((a: any) => <Badge key={a.assignmentId} tone={a.kind === 'ai' ? 'violet' : 'green'}>{a.kind === 'ai' ? '◉ ' : ''}{a.name}{a.status !== 'active' ? ' (inactive)' : ''}</Badge>) : <span className="text-slate-400">—</span>}</div></td>
              <td className="p-3">{r.departmentName ?? '—'}</td><td className="p-3">{r.reportsToName ?? <span className="text-slate-400">Founder</span>}</td>
              <td className="max-w-xs p-3 text-slate-600">{r.responsibilities.slice(0, 2).join(' · ')}{r.responsibilities.length > 2 ? ` +${r.responsibilities.length - 2}` : ''}{!r.responsibilities.length && '—'}</td></tr>))}</tbody></table></div>))}
      {tab === 'directory' && dir.data && (
        <div className="card overflow-x-auto"><div className="border-b border-slate-100 p-3 text-sm text-slate-500">{dir.data.counts.humans} active people · {dir.data.counts.inactiveHumans} inactive · {dir.data.counts.ai} active AI · {dir.data.counts.inactiveAi} inactive AI</div>
          <table className="w-full text-left text-sm"><thead className="border-b border-slate-200 text-slate-500"><tr><th className="p-3">Name</th><th className="p-3">Type</th><th className="p-3">Status</th><th className="p-3">Department</th><th className="p-3">Manager</th><th className="p-3">Roles</th></tr></thead>
            <tbody className="divide-y divide-slate-100">{people.map((p: any) => (
              <tr key={p.kind + p.id}><td className="p-3 font-medium">{p.kind === 'ai' ? <Link className="text-brand-700 hover:underline" href={`/c/${id}/ai-employees/${p.id}`}>◉ {p.name}</Link> : can('members.view') ? <Link className="text-brand-700 hover:underline" href={`/c/${id}/employees/${p.id}`}>{p.name}</Link> : p.name}<div className="text-xs font-normal text-slate-400">{p.jobTitle ?? p.email}</div></td>
                <td className="p-3"><Badge tone={p.kind === 'ai' ? 'violet' : 'slate'}>{p.kind === 'ai' ? 'AI' : 'Person'}</Badge></td><td className="p-3"><Badge tone={tone(p.status)}>{p.status.replace('_', ' ')}</Badge></td>
                <td className="p-3">{p.departmentName ?? '—'}</td><td className="p-3">{p.managerName ?? '—'}</td><td className="p-3">{p.roles.join(', ') || '—'}</td></tr>))}</tbody></table></div>)}
    </>
  );
}
