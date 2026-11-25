'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCompany } from '@/components/company';
import { Badge, Confirm, Empty, ErrorBox, Field, Loading, PageHeader, Tabs, fmtDate, titleCase } from '@/components/ui';
import { AUTONOMY } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';
import { WorkItem } from '@/components/work-item';

type Tab = 'profile' | 'ai' | 'tools' | 'resp' | 'activity';

export default function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const [agentId, setAgentId] = useState<string | null>(null);
  useEffect(() => { params.then((p) => setAgentId(p.agentId)); }, [params]);
  return agentId ? <Agent agentId={agentId} /> : <Loading />;
}

function Agent({ agentId }: { agentId: string }) {
  const { id } = useCompany();
  const d = useApi(`/companies/${id}/agents/${agentId}`);
  const [tab, setTab] = useState<Tab>('profile'); const [del, setDel] = useState(false);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  const x = d.data; const a = x.agent; const c = x.can;
  const toggle = async () => { if (await act(() => api('POST', `/companies/${id}/agents/${agentId}/status`, { status: a.status === 'active' ? 'inactive' : 'active' }), a.status === 'active' ? 'Deactivated' : 'Activated')) d.reload(); };
  return (
    <>
      <p className="mb-2 text-sm text-slate-500"><Link className="hover:underline" href={`/c/${id}/ai-employees`}>AI Employees</Link> › {a.name}</p>
      <PageHeader title={`◉ ${a.name}`} subtitle={a.description ?? undefined} actions={<><Badge tone={a.status === 'active' ? 'green' : 'slate'}>{a.status}</Badge>
        {c.edit && <button className={a.status === 'active' ? 'btn-secondary' : 'btn-primary'} onClick={toggle}>{a.status === 'active' ? 'Deactivate' : 'Activate'}</button>}{c.delete && <button className="btn-ghost text-red-600" onClick={() => setDel(true)}>Delete</button>}</>} />
      {!x.providerConfigured && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The provider “{x.config?.provider}” is not connected on the server, so this AI employee cannot run yet. {x.providerHint}</div>}
      {x.pendingReview > 0 && <button onClick={() => setTab('activity')} className="mb-4 w-full rounded-lg border border-amber-200 bg-amber-50 p-3 text-left text-sm text-amber-900">{x.pendingReview} item(s) waiting for human review →</button>}
      <Tabs tabs={[{ id: 'profile', label: 'Profile' }, { id: 'ai', label: 'Instructions & AI' }, { id: 'tools', label: 'Tools' }, { id: 'resp', label: 'Responsibilities' }, { id: 'activity', label: 'Activity & usage' }]} value={tab} onChange={setTab} />
      {tab === 'profile' && <Profile cid={id} x={x} reload={d.reload} />}
      {tab === 'ai' && x.config && <AiConfig cid={id} x={x} reload={d.reload} />}
      {tab === 'tools' && <Tools cid={id} x={x} reload={d.reload} />}
      {tab === 'resp' && <Resp cid={id} x={x} reload={d.reload} />}
      {tab === 'activity' && <Activity cid={id} x={x} reload={d.reload} />}
      <Confirm open={del} danger title="Delete AI employee?" confirmLabel="Delete" onClose={() => setDel(false)} message={<>“{a.name}” is deactivated and removed from its roles. Its run history and usage stay on record.</>} onConfirm={async () => { if (await act(() => api('DELETE', `/companies/${id}/agents/${agentId}`), 'Deleted')) location.href = `/c/${id}/ai-employees`; }} />
    </>
  );
}

function Profile({ cid, x, reload }: any) {
  const a = x.agent; const mem = useApi(x.can.edit ? `/companies/${cid}/members` : null); const depts = useApi(x.can.edit ? `/companies/${cid}/departments` : null);
  const [f, setF] = useState({ name: a.name, description: a.description ?? '', departmentId: a.departmentId ?? '', managerMembershipId: a.managerMembershipId ?? '' });
  const roles = useApi(x.can.assign ? `/companies/${cid}/roles` : null); const [pick, setPick] = useState('');
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <form className="card grid gap-4 p-5 sm:grid-cols-2 lg:col-span-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('PATCH', `/companies/${cid}/agents/${a.id}`, { name: f.name, description: f.description, departmentId: f.departmentId || null, managerMembershipId: f.managerMembershipId || undefined }), 'Saved')) reload(); }}>
        <Field label="Name" id="n"><input id="n" className="input" required disabled={!x.can.edit} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Department" id="d"><select id="d" className="input" disabled={!x.can.edit} value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">— None —</option>{depts.data?.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}{!depts.data && a.departmentId && <option value={a.departmentId}>{a.departmentName}</option>}</select></Field>
        <Field label="Accountable manager" id="m"><select id="m" className="input" disabled={!x.can.edit} value={f.managerMembershipId} onChange={(e) => setF({ ...f, managerMembershipId: e.target.value })}>{mem.data ? mem.data.members.map((m: any) => <option key={m.membershipId} value={m.membershipId}>{m.name}</option>) : <option value={f.managerMembershipId}>{a.managerName}</option>}</select></Field>
        <Field label="Autonomy"><input className="input" disabled value={x.config ? AUTONOMY[x.config.autonomyLevel as 1 | 2 | 3 | 4].label : '—'} /></Field>
        <div className="sm:col-span-2"><Field label="Description" id="ds"><textarea id="ds" rows={2} className="input" disabled={!x.can.edit} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field></div>
        {x.can.edit && <div className="sm:col-span-2 flex justify-end"><button className="btn-primary">Save profile</button></div>}
      </form>
      <div className="card p-4"><h3 className="mb-2 font-semibold">Roles</h3>
        {x.assignments.length === 0 ? <p className="text-sm text-slate-500">Not assigned to a role.</p> : <ul className="space-y-2 text-sm">{x.assignments.map((r: any) => <li key={r.assignmentId} className="flex items-center justify-between"><span><Link className="text-brand-700 hover:underline" href={`/c/${cid}/roles/${r.roleId}`}>{r.roleName}</Link> {r.isOwner && <Badge tone="brand">owner</Badge>} <Badge>{r.roleType}</Badge></span>{x.can.assign && <button className="btn-ghost px-2 text-red-600" onClick={async () => { if (await act(() => api('DELETE', `/companies/${cid}/roles/${r.roleId}/assignments/${r.assignmentId}`), 'Removed from role')) reload(); }}>Remove</button>}</li>)}</ul>}
        {x.can.assign && roles.data && <div className="mt-3 flex gap-2"><select aria-label="Role" className="input" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Assign to role…</option>{roles.data.roles.filter((r: any) => !x.assignments.some((a2: any) => a2.roleId === r.id)).map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select><button className="btn-primary" disabled={!pick} onClick={async () => { if (await act(() => api('POST', `/companies/${cid}/roles/${pick}/assignments`, { agentId: a.id }), 'Assigned')) { setPick(''); reload(); } }}>Add</button></div>}
        <p className="mt-3 text-xs text-slate-500">When a person shares the role, the role runs in Hybrid mode.</p></div>
    </div>
  );
}

function AiConfig({ cid, x, reload }: any) {
  const meta = useApi(`/companies/${cid}/ai/meta`); const c = x.config; const ro = !x.can.configure;
  const [f, setF] = useState<any>({ provider: c.provider, model: c.model, instructions: c.instructions ?? '', autonomyLevel: c.autonomyLevel, knowledgeScope: c.knowledgeScope, monthlyTokenLimit: c.monthlyTokenLimit ?? '', monthlyBudgetUsd: c.monthlyBudgetUsd ?? '' });
  const s = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="card grid gap-4 p-5 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('PUT', `/companies/${cid}/agents/${x.agent.id}/config`, { provider: f.provider, model: f.model, instructions: f.instructions, autonomyLevel: Number(f.autonomyLevel), knowledgeScope: f.knowledgeScope, monthlyTokenLimit: f.monthlyTokenLimit === '' ? null : Number(f.monthlyTokenLimit), monthlyBudgetUsd: f.monthlyBudgetUsd === '' ? null : Number(f.monthlyBudgetUsd) }), 'Configuration saved')) reload(); }}>
      {ro && <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">You can view but not change this configuration (agents.configure).</p>}
      <Field label="Provider" id="p"><select id="p" className="input" disabled={ro} value={f.provider} onChange={s('provider')}>{(meta.data?.providers ?? [{ id: f.provider, label: f.provider }]).map((p: any) => <option key={p.id} value={p.id}>{p.label}{p.configured === false ? ' (not configured)' : ''}</option>)}</select></Field>
      <Field label="Model" id="m" hint="Model ID as named by the provider."><input id="m" className="input" required disabled={ro} value={f.model} onChange={s('model')} /></Field>
      <Field label="Autonomy level" id="a" hint={AUTONOMY[Number(f.autonomyLevel) as 1 | 2 | 3 | 4].help}><select id="a" className="input" disabled={ro} value={f.autonomyLevel} onChange={s('autonomyLevel')}>{([1, 2, 3, 4] as const).map((l) => <option key={l} value={l}>{AUTONOMY[l].label}</option>)}</select></Field>
      <Field label="Knowledge access" id="k" hint="What company information it may read."><select id="k" className="input" disabled={ro} value={f.knowledgeScope} onChange={s('knowledgeScope')}><option value="none">None</option><option value="role">Its own role(s) only</option><option value="department">Its department</option><option value="company">Whole organization</option></select></Field>
      <Field label="Monthly token limit" id="t" hint="Hard stop. Blank = unlimited."><input id="t" type="number" min={0} className="input" disabled={ro} value={f.monthlyTokenLimit} onChange={s('monthlyTokenLimit')} /></Field>
      <Field label="Monthly budget (USD)" id="b" hint="Enforced only when model prices are configured on the server (AI_MODEL_PRICING_JSON)."><input id="b" type="number" min={0} step="0.01" className="input" disabled={ro} value={f.monthlyBudgetUsd} onChange={s('monthlyBudgetUsd')} /></Field>
      <div className="sm:col-span-2"><Field label="Instructions" id="i" hint="Always included in its system prompt, together with its role, responsibilities and rules."><textarea id="i" rows={8} className="input font-mono text-xs" disabled={ro} value={f.instructions} onChange={s('instructions')} /></Field></div>
      {!ro && <div className="sm:col-span-2 flex items-center justify-between"><span className="text-xs text-slate-400">Config version {c.version}</span><button className="btn-primary">Save configuration</button></div>}
    </form>
  );
}

function Tools({ cid, x, reload }: any) {
  const [t, setT] = useState<any[]>(x.tools); const ro = !x.can.configure;
  return (
    <div className="space-y-3"><p className="text-sm text-slate-500">An AI employee can use only the tools enabled here. Tools that change things follow its autonomy level; “Run without approval” applies only at Level 4 and only to routine tools.</p>
      <div className="card divide-y divide-slate-100">{t.map((tool: any, i: number) => (
        <div key={tool.key} className={`flex flex-wrap items-start justify-between gap-3 p-4 ${!tool.connected ? 'opacity-60' : ''}`}>
          <div className="max-w-xl"><p className="font-medium">{tool.label} <Badge tone={tool.kind === 'read' ? 'green' : tool.kind === 'write' ? 'amber' : 'slate'}>{tool.kind === 'external' ? 'external' : tool.kind}</Badge>{!tool.connected && <> <Badge tone="red">not connected</Badge></>}</p><p className="text-sm text-slate-500">{tool.description}</p></div>
          <div className="flex flex-col items-end gap-1 text-sm"><label className="flex items-center gap-2"><input type="checkbox" disabled={ro || !tool.connected} checked={tool.enabled} onChange={(e) => setT(t.map((x2, j) => (j === i ? { ...x2, enabled: e.target.checked } : x2)))} />Enabled</label>
            {tool.kind === 'write' && tool.enabled && <label className="flex items-center gap-2 text-slate-600"><input type="checkbox" disabled={ro || !tool.routine} checked={!tool.requiresApproval} onChange={(e) => setT(t.map((x2, j) => (j === i ? { ...x2, requiresApproval: !e.target.checked } : x2)))} />Run without approval (Level 4)</label>}</div></div>))}</div>
      {!ro && <div className="flex justify-end"><button className="btn-primary" onClick={async () => { if (await act(() => api('PUT', `/companies/${cid}/agents/${x.agent.id}/tools`, { tools: t.filter((q) => q.connected).map((q) => ({ toolKey: q.key, enabled: q.enabled, requiresApproval: q.requiresApproval })) }), 'Tools saved')) reload(); }}>Save tools</button></div>}
    </div>
  );
}

function Resp({ cid, x, reload }: any) {
  const [sel, setSel] = useState<Set<string>>(new Set(x.responsibilities.selected)); const av = x.responsibilities.available; const ro = !x.can.configure;
  if (!av.length) return <Empty title="Nothing to choose from" hint="Assign this AI employee to a role first. Its responsibilities come from that role." />;
  return (
    <div className="space-y-3"><p className="text-sm text-slate-500">Tick the responsibilities the AI performs. Unticked ones stay with the people sharing the role (for example, the AI researches and drafts while the human CMO approves and decides).</p>
      <div className="card divide-y divide-slate-100">{av.map((r: any) => <label key={r.id} className="flex items-center gap-3 p-3 text-sm"><input type="checkbox" disabled={ro} checked={sel.has(r.id)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(r.id) : n.delete(r.id); setSel(n); }} /><span className="flex-1">{r.title}</span><Badge>{r.roleName}</Badge></label>)}</div>
      {!ro && <div className="flex justify-end"><button className="btn-primary" onClick={async () => { if (await act(() => api('PUT', `/companies/${cid}/agents/${x.agent.id}/responsibilities`, { ids: [...sel] }), 'Saved')) reload(); }}>Save responsibilities</button></div>}
    </div>
  );
}

function Activity({ cid, x, reload }: any) {
  const items = useApi(`/companies/${cid}/ai-work-items?agentId=${x.agent.id}`);
  const [input, setInput] = useState(''); const [busy, setBusy] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const u = x.usage;
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="card p-4"><p className="text-sm text-slate-500">Tokens this month</p><p className="text-xl font-semibold">{u.tokens.toLocaleString()}{u.tokenLimit != null && <span className="text-sm font-normal text-slate-400"> / {u.tokenLimit.toLocaleString()}</span>}</p></div>
        <div className="card p-4"><p className="text-sm text-slate-500">Cost this month</p><p className="text-xl font-semibold">{u.costComplete && u.calls > 0 ? `$${u.costUsd.toFixed(4)}` : u.calls === 0 ? '$0' : 'n/a'}</p><p className="text-xs text-slate-400">{u.costComplete ? (u.budgetUsd != null ? `Budget $${u.budgetUsd}` : 'No budget set') : 'Model price not configured on the server'}</p></div>
        <div className="card p-4"><p className="text-sm text-slate-500">Calls this month</p><p className="text-xl font-semibold">{u.calls}</p></div></div>
      {x.can.edit && <form className="card space-y-2 p-4" onSubmit={async (e) => { e.preventDefault(); setBusy(true); const r = await act(() => api('POST', `/companies/${cid}/agents/${x.agent.id}/run`, { input })); setBusy(false); if (r) { r.run.status === 'succeeded' ? setInput('') : null; act(async () => { if (r.run.status !== 'succeeded') throw new Error(r.run.error ?? 'Run did not complete'); }); reload(); items.reload(); } }}>
        <h3 className="font-semibold">Give it a task</h3><textarea aria-label="Task" rows={3} className="input" required placeholder={x.agent.status === 'active' ? 'e.g. Review our marketing responsibilities and propose a Q4 plan' : 'Activate this AI employee to run it'} disabled={x.agent.status !== 'active'} value={input} onChange={(e) => setInput(e.target.value)} />
        <div className="flex justify-between"><span className="text-xs text-slate-500">Level {x.config?.autonomyLevel}: output is {x.config?.autonomyLevel <= 1 ? 'suggestions' : x.config?.autonomyLevel === 2 ? 'drafts' : 'drafts and queued actions'} — nothing external is ever sent.</span><button className="btn-primary" disabled={busy || x.agent.status !== 'active'}>{busy ? 'Running…' : 'Run'}</button></div></form>}
      <section><h3 className="mb-2 font-semibold">Review queue</h3>{!items.data ? <Loading /> : items.data.items.length === 0 ? <Empty title="No work items yet" /> : <ul className="space-y-3">{items.data.items.map((w: any) => <WorkItem key={w.id} cid={cid} w={w} onDone={() => { items.reload(); reload(); }} />)}</ul>}</section>
      <section><h3 className="mb-2 font-semibold">Execution history</h3>{x.runs.length === 0 ? <Empty title="No runs yet" /> : <div className="card divide-y divide-slate-100">{x.runs.map((r: any) => (
        <div key={r.id} className="p-3 text-sm"><button className="flex w-full items-start justify-between gap-3 text-left" onClick={() => setOpen(open === r.id ? null : r.id)}><span><Badge tone={r.status === 'succeeded' ? 'green' : r.status === 'running' ? 'amber' : r.status === 'blocked' ? 'amber' : 'red'}>{r.status}</Badge> <span className="ml-1">{r.input.slice(0, 90)}</span></span><span className="shrink-0 text-xs text-slate-400">{fmtDate(r.startedAt)} · {r.inputTokens + r.outputTokens} tok</span></button>
          {open === r.id && <div className="mt-2 space-y-2 rounded-lg bg-slate-50 p-3 text-xs">{r.error && <p className="text-red-700">Error: {r.error}</p>}{r.summary && <p><b>Summary:</b> {r.summary}</p>}<p className="text-slate-500">Model {r.model} · autonomy level {r.autonomyLevel}</p>{r.steps.map((s: any, i: number) => <p key={i}>• {s.tool}: <b>{titleCase(String(s.decision))}</b> — {String(s.result).slice(0, 160)}</p>)}</div>}</div>))}</div>}</section>
    </div>
  );
}
