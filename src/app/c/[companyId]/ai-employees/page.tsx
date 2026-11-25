'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useCompany } from '@/components/company';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Tabs } from '@/components/ui';
import { WorkItem } from '@/components/work-item';
import { AUTONOMY } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

export default function AiEmployees() {
  const { id, can, me } = useCompany();
  const [tab, setTab] = useState<'agents' | 'review'>('agents');
  const agents = useApi(`/companies/${id}/agents`); const meta = useApi(`/companies/${id}/ai/meta`);
  const queue = useApi(tab === 'review' ? `/companies/${id}/ai-work-items?status=pending_review` : null);
  const [create, setCreate] = useState<any>(null);
  if (agents.loading || meta.loading) return <Loading />;
  if (agents.error) return <ErrorBox error={agents.error} retry={agents.reload} />;
  const providers = meta.data?.providers ?? [];
  const anyConfigured = providers.some((p: any) => p.configured);
  return (
    <>
      <PageHeader title="AI Employees" subtitle="AI team members with a role, a human accountable for them, limited tools and a defined autonomy level." actions={can('agents.create') && <NewButton onClick={() => setCreate({ name: '', roleId: '', departmentId: '', provider: providers[0]?.id ?? 'anthropic', model: '', autonomyLevel: 1, knowledgeScope: 'role', instructions: '' })} />} />
      {!anyConfigured && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><b>No AI provider is connected on the server.</b> You can create and configure AI employees, but they cannot run until credentials are set. {providers.map((p: any) => <span key={p.id} className="block">• {p.label}: {p.setupHint}</span>)}</div>}
      <Tabs tabs={[{ id: 'agents', label: `AI employees (${agents.data.agents.length})` }, { id: 'review', label: 'Review queue' }]} value={tab} onChange={setTab} />
      {tab === 'agents' && (agents.data.agents.length === 0 ? <Empty title="No AI employees yet" hint="Create one, give it a role, and decide how much it may do on its own." /> : (
        <div className="grid gap-3 md:grid-cols-2">{agents.data.agents.map((a: any) => (
          <Link key={a.id} href={`/c/${id}/ai-employees/${a.id}`} className="card block p-4 transition hover:border-brand-500">
            <div className="flex items-start justify-between"><div><p className="font-semibold">◉ {a.name}</p><p className="text-sm text-slate-500">{a.roles.length ? a.roles.map((r: any) => r.name).join(', ') : 'No role assigned'}{a.departmentName ? ` · ${a.departmentName}` : ''}</p></div><Badge tone={a.status === 'active' ? 'green' : 'slate'}>{a.status}</Badge></div>
            <p className="mt-3 text-sm text-slate-600">Reports to <b>{a.managerName ?? '—'}</b> · {AUTONOMY[a.autonomyLevel as 1 | 2 | 3 | 4]?.label}</p>
            <p className="mt-1 text-xs text-slate-400">{a.model ?? 'no model'}{a.pendingReview > 0 && <span className="ml-2 font-medium text-amber-700">{a.pendingReview} awaiting review</span>}</p></Link>))}</div>))}
      {tab === 'review' && (!queue.data ? <Loading /> : queue.data.items.length === 0 ? <Empty title="Nothing waiting for review" /> : (
        <ul className="space-y-3">{queue.data.items.map((w: any) => <WorkItem key={w.id} cid={id} w={w} onDone={() => { queue.reload(); agents.reload(); }} />)}</ul>))}
      <CreateModal cid={id} state={create} setState={setCreate} meta={meta.data} me={me} can={can} onDone={(aid: string) => { location.href = `/c/${id}/ai-employees/${aid}`; }} />
    </>
  );
}
const NewButton = ({ onClick }: { onClick: () => void }) => <button className="btn-primary" onClick={onClick}>New AI employee</button>;

function CreateModal({ cid, state, setState, meta, me, can, onDone }: any) {
  const roles = useApi(state && can('roles.view') ? `/companies/${cid}/roles` : null); const depts = useApi(state && can('departments.view') ? `/companies/${cid}/departments` : null); const mem = useApi(state && can('members.view') ? `/companies/${cid}/members` : null);
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const s = (k: string) => (e: React.ChangeEvent<any>) => setState({ ...state, [k]: e.target.value });
  const canHigh = can('agents.approve');
  return (
    <Modal open onClose={() => setState(null)} title="New AI employee" wide>
      <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); setBusy(true);
        const r = await act(() => api('POST', `/companies/${cid}/agents`, { name: state.name, departmentId: state.departmentId || null, managerMembershipId: state.managerMembershipId || null, roleId: state.roleId || null, config: { provider: state.provider, model: state.model, autonomyLevel: Number(state.autonomyLevel), knowledgeScope: state.knowledgeScope, instructions: state.instructions } }), 'AI employee created'); setBusy(false); if (r) onDone(r.agent.id); }}>
        <Field label="Name *" id="an"><input id="an" className="input" required autoFocus placeholder="e.g. AI CMO" value={state.name} onChange={s('name')} /></Field>
        <Field label="Role" id="ar" hint="Assigns it to the role; you can add more later.">{roles.data ? <select id="ar" className="input" value={state.roleId} onChange={s('roleId')}><option value="">— Assign later —</option>{roles.data.roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select> : <input className="input" disabled value="(no permission to list roles)" />}</Field>
        {depts.data && <Field label="Department" id="ad"><select id="ad" className="input" value={state.departmentId} onChange={s('departmentId')}><option value="">— From its role —</option>{depts.data.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
        <Field label="Accountable manager" id="am" hint="The person responsible for this AI employee.">{mem.data ? <select id="am" className="input" value={state.managerMembershipId ?? me.membershipId} onChange={s('managerMembershipId')}>{mem.data.members.map((m: any) => <option key={m.membershipId} value={m.membershipId}>{m.name}</option>)}</select> : <input className="input" disabled value="You" />}</Field>
        <Field label="AI provider" id="ap"><select id="ap" className="input" value={state.provider} onChange={s('provider')}>{(meta?.providers ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.label}{p.configured ? '' : ' (not configured on server)'}</option>)}</select></Field>
        <Field label="Model *" id="amo" hint="Model ID exactly as your provider names it."><input id="amo" className="input" required value={state.model} onChange={s('model')} /></Field>
        <Field label="Autonomy" id="aa"><select id="aa" className="input" value={state.autonomyLevel} onChange={s('autonomyLevel')}>{([1, 2, 3, 4] as const).map((l) => <option key={l} value={l} disabled={l >= 3 && !canHigh}>{AUTONOMY[l].label}{l >= 3 && !canHigh ? ' (needs approve permission)' : ''}</option>)}</select></Field>
        <Field label="Knowledge access" id="ak"><select id="ak" className="input" value={state.knowledgeScope} onChange={s('knowledgeScope')}><option value="none">None</option><option value="role">Its own role(s) only</option><option value="department">Its department</option><option value="company">Whole organization</option></select></Field>
        <div className="sm:col-span-2"><Field label="Instructions" id="ai" hint="How it should work, tone, priorities. Applied on every run."><textarea id="ai" rows={4} className="input" value={state.instructions} onChange={s('instructions')} /></Field></div>
        <p className="sm:col-span-2 text-xs text-slate-500">{AUTONOMY[Number(state.autonomyLevel) as 1 | 2 | 3 | 4].help} It starts inactive; you'll review tools, responsibilities and budget before activating.</p>
        <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setState(null)}>Cancel</button><button className="btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create AI employee'}</button></div>
      </form>
    </Modal>
  );
}
