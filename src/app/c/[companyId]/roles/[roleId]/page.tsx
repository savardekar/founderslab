'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useCompany } from '@/components/company';
import { PermissionMatrix, type Grant } from '@/components/permission-matrix';
import { DeleteRoleConfirm, MoveRoleModal } from '@/components/role-dialogs';
import { Badge, Confirm, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Tabs, roleTone } from '@/components/ui';
import { ALL_PERMISSION_KEYS, FREQUENCIES, PRIORITIES, REPORTING_FREQUENCIES, ROLE_TYPES, ROLE_TYPE_LABEL, RULE_KINDS } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

type Tab = 'overview' | 'responsibilities' | 'rules' | 'kpis' | 'permissions' | 'people';
const KIND = { allow: ['Can', 'green'], deny: ['Cannot', 'red'], requires_approval: ['Needs approval', 'amber'] } as const;

export default function RoleDetail({ params }: { params: Promise<{ roleId: string }> }) {
  const [roleId, setRoleId] = useState<string | null>(null);
  useEffect(() => { params.then((p) => setRoleId(p.roleId)); }, [params]);
  if (!roleId) return <Loading />;
  return <Detail roleId={roleId} />;
}

function Detail({ roleId }: { roleId: string }) {
  const { id, can, me } = useCompany();
  const d = useApi(`/companies/${id}/roles/${roleId}`);
  const roles = useApi(`/companies/${id}/roles`);
  const [tab, setTab] = useState<Tab>('overview');
  const [move, setMove] = useState(false); const [del, setDel] = useState(false);
  const reload = () => { d.reload(); roles.reload(); };
  if (d.loading || roles.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  const x = d.data; const r = x.role; const flat = roles.data?.roles ?? [];
  const t = { departmentId: r.departmentId, roleId };
  const tabs: { id: Tab; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'responsibilities', label: `Responsibilities (${x.responsibilities.length})` }, { id: 'rules', label: `Rules (${x.rules.length})` }, { id: 'kpis', label: `KPIs (${x.kpis.length})` },
    ...(can('permissions.view') ? [{ id: 'permissions' as Tab, label: 'Permissions' }] : []), { id: 'people', label: `People (${x.assignees.length})` }];
  return (
    <>
      <p className="mb-2 text-sm text-slate-500"><Link className="hover:underline" href={`/c/${id}/roles`}>Roles</Link> › {x.ancestors.map((a: any) => <span key={a.id}><Link className="hover:underline" href={`/c/${id}/roles/${a.id}`}>{a.name}</Link> › </span>)}{r.name}</p>
      <PageHeader title={r.name} subtitle={r.description ?? undefined} actions={<>
        <Badge tone={roleTone(r.roleType)}>{ROLE_TYPE_LABEL[r.roleType as keyof typeof ROLE_TYPE_LABEL]}</Badge>{r.status === 'inactive' && <Badge>Inactive</Badge>}
        {can('roles.edit') && <button className="btn-secondary" onClick={() => setMove(true)}>Change manager</button>}
        {can('roles.create') && <button className="btn-secondary" onClick={async () => { const c = await act(() => api('POST', `/companies/${id}/roles/${roleId}/duplicate`, {}), 'Role duplicated'); if (c) location.href = `/c/${id}/roles/${c.role.id}`; }}>Duplicate</button>}
        {can('roles.delete') && <button className="btn-ghost text-red-600" onClick={() => setDel(true)}>Delete</button>}</>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && <Overview cid={id} x={x} flat={flat} canEdit={can('roles.edit', ) && (me.accessLevel === 'owner' || can('roles.edit'))} reload={reload} />}
      {tab === 'responsibilities' && <Responsibilities cid={id} x={x} flat={flat} can={can} reload={reload} />}
      {tab === 'rules' && <Rules cid={id} x={x} canEdit={can('roles.edit')} reload={reload} />}
      {tab === 'kpis' && <Kpis cid={id} x={x} canEdit={can('roles.edit')} reload={reload} />}
      {tab === 'permissions' && <Perms cid={id} roleId={roleId} canEdit={can('permissions.configure')} me={me} can={can} />}
      {tab === 'people' && <People cid={id} x={x} canAssign={can('roles.assign')} canSeeMembers={can('members.view')} reload={reload} />}
      {move && <MoveRoleModal cid={id} role={{ id: roleId, name: r.name, reportsToRoleId: r.reportsToRoleId }} roles={flat} onClose={() => setMove(false)} onDone={() => { setMove(false); reload(); }} />}
      <DeleteRoleConfirm cid={id} role={del ? { id: roleId, name: r.name, reportsToRoleId: r.reportsToRoleId } : null} onClose={() => setDel(false)} onDone={() => { location.href = `/c/${id}/roles`; }} />
      <span className="hidden">{JSON.stringify(t)}</span>
    </>
  );
}

function Overview({ cid, x, flat, canEdit, reload }: any) {
  const r = x.role; const depts = useApi(`/companies/${cid}/departments`);
  const [f, setF] = useState<any>({ name: r.name, description: r.description ?? '', departmentId: r.departmentId ?? '', roleType: r.roleType, status: r.status, reportingFrequency: r.reportingFrequency, hasApprovalAuthority: r.hasApprovalAuthority, approvalLimit: r.approvalLimit ?? '' });
  const s = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <form className="card grid gap-4 p-5 sm:grid-cols-2 lg:col-span-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('PATCH', `/companies/${cid}/roles/${r.id}`, { ...f, departmentId: f.departmentId || null, approvalLimit: f.hasApprovalAuthority && f.approvalLimit !== '' ? Number(f.approvalLimit) : null }), 'Role saved')) reload(); }}>
        <Field label="Name" id="n"><input id="n" className="input" required disabled={!canEdit} value={f.name} onChange={s('name')} /></Field>
        <Field label="Department" id="d"><select id="d" className="input" disabled={!canEdit} value={f.departmentId} onChange={s('departmentId')}><option value="">— None —</option>{depts.data?.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        <Field label="Role type" id="t"><select id="t" className="input" disabled={!canEdit} value={f.roleType} onChange={s('roleType')}>{ROLE_TYPES.map((t) => <option key={t} value={t}>{ROLE_TYPE_LABEL[t]}</option>)}</select></Field>
        <Field label="Status" id="st"><select id="st" className="input" disabled={!canEdit} value={f.status} onChange={s('status')}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>
        <Field label="Reporting frequency" id="rf"><select id="rf" className="input" disabled={!canEdit} value={f.reportingFrequency} onChange={s('reportingFrequency')}>{REPORTING_FREQUENCIES.map((x) => <option key={x}>{x}</option>)}</select></Field>
        <div className="flex items-end gap-3"><label className="flex items-center gap-2 pb-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={f.hasApprovalAuthority} onChange={s('hasApprovalAuthority')} />Approval authority</label>{f.hasApprovalAuthority && <input aria-label="Approval limit" type="number" min={0} className="input" placeholder="Limit" disabled={!canEdit} value={f.approvalLimit} onChange={s('approvalLimit')} />}</div>
        <div className="sm:col-span-2"><Field label="Description" id="ds"><textarea id="ds" rows={3} className="input" disabled={!canEdit} value={f.description} onChange={s('description')} /></Field></div>
        {canEdit && <div className="sm:col-span-2 flex justify-end"><button className="btn-primary">Save changes</button></div>}
      </form>
      <div className="space-y-4">
        <div className="card p-4"><h3 className="mb-2 font-semibold">Reports to</h3>{x.reportsTo ? <Link className="text-brand-700 hover:underline" href={`/c/${cid}/roles/${x.reportsTo.id}`}>{x.reportsTo.name}</Link> : <p className="text-sm text-slate-500">Founder (top level)</p>}</div>
        <div className="card p-4"><h3 className="mb-2 font-semibold">Direct reports ({x.directReports.length})</h3>{x.directReports.length ? <ul className="space-y-1 text-sm">{x.directReports.map((c: any) => <li key={c.id}><Link className="text-brand-700 hover:underline" href={`/c/${cid}/roles/${c.id}`}>{c.name}</Link></li>)}</ul> : <p className="text-sm text-slate-500">None</p>}</div>
        <p className="px-1 text-xs text-slate-500">Reporting lines don't grant access. What this role can do is set on the Permissions tab.</p>
      </div>
    </div>
  );
}

function Responsibilities({ cid, x, flat, can, reload }: any) {
  const [edit, setEdit] = useState<any>(null); const [del, setDel] = useState<any>(null);
  const list = x.responsibilities;
  async function order(i: number, d: number) { const ids = list.map((r: any) => r.id); const j = i + d; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; if (await act(() => api('PUT', `/companies/${cid}/roles/${x.role.id}/responsibilities/order`, { ids }))) reload(); }
  const blank = { title: '', description: '', expectedOutcome: '', priority: 'medium', frequency: 'ongoing', requiresApproval: false, ownerRoleId: '' };
  return (
    <>
      <div className="mb-3 flex justify-end">{can('responsibilities.create') && <button className="btn-primary" onClick={() => setEdit(blank)}>Add responsibility</button>}</div>
      {list.length === 0 ? <Empty title="No responsibilities yet" hint="Responsibilities define what this role is accountable for." /> : <ul className="space-y-2">{list.map((r: any, i: number) => (
        <li key={r.id} className="card flex items-start justify-between gap-3 p-4"><div className="min-w-0"><p className="font-medium">{r.title} <Badge tone={r.priority === 'critical' ? 'red' : r.priority === 'high' ? 'amber' : 'slate'}>{r.priority}</Badge> <Badge>{r.frequency}</Badge>{r.requiresApproval && <Badge tone="violet">needs approval</Badge>}{r.ownerRoleName && <Badge tone="brand">owned by {r.ownerRoleName}</Badge>}</p>
          {r.description && <p className="mt-1 text-sm text-slate-600">{r.description}</p>}{r.expectedOutcome && <p className="mt-1 text-sm text-slate-500"><b>Outcome:</b> {r.expectedOutcome}</p>}</div>
          <div className="flex shrink-0 gap-1">{can('responsibilities.edit') && <><button aria-label="Move up" className="btn-ghost px-2" onClick={() => order(i, -1)}>↑</button><button aria-label="Move down" className="btn-ghost px-2" onClick={() => order(i, 1)}>↓</button><button className="btn-secondary" onClick={() => setEdit({ ...r, description: r.description ?? '', expectedOutcome: r.expectedOutcome ?? '', ownerRoleId: r.ownerRoleId ?? '' })}>Edit</button></>}{can('responsibilities.delete') && <button className="btn-ghost text-red-600" onClick={() => setDel(r)}>Delete</button>}</div></li>))}</ul>}
      {x.responsibilitiesOwnedFromOtherRoles.length > 0 && <div className="card mt-4 p-4"><h3 className="mb-2 font-semibold">Also owned by this role (assigned from other roles)</h3><ul className="list-disc pl-5 text-sm">{x.responsibilitiesOwnedFromOtherRoles.map((o: any) => <li key={o.id}>{o.title} <span className="text-slate-500">— from {o.fromRoleName}</span></li>)}</ul></div>}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit responsibility' : 'Add responsibility'} wide>
        {edit && <form className="grid gap-4 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const body = { title: edit.title, description: edit.description, expectedOutcome: edit.expectedOutcome, priority: edit.priority, frequency: edit.frequency, requiresApproval: edit.requiresApproval, ...(can('responsibilities.assign') || !edit.ownerRoleId ? { ownerRoleId: edit.ownerRoleId || null } : {}) };
          if (await act(() => (edit.id ? api('PATCH', `/companies/${cid}/responsibilities/${edit.id}`, body) : api('POST', `/companies/${cid}/roles/${x.role.id}/responsibilities`, body)), 'Saved')) { setEdit(null); reload(); } }}>
          <div className="sm:col-span-2"><Field label="Title" id="rt"><input id="rt" className="input" required autoFocus value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><Field label="Description" id="rd"><textarea id="rd" rows={2} className="input" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><Field label="Expected outcome" id="ro"><input id="ro" className="input" value={edit.expectedOutcome} onChange={(e) => setEdit({ ...edit, expectedOutcome: e.target.value })} /></Field></div>
          <Field label="Priority" id="rp"><select id="rp" className="input" value={edit.priority} onChange={(e) => setEdit({ ...edit, priority: e.target.value })}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
          <Field label="Frequency" id="rfq"><select id="rfq" className="input" value={edit.frequency} onChange={(e) => setEdit({ ...edit, frequency: e.target.value })}>{FREQUENCIES.map((p) => <option key={p}>{p}</option>)}</select></Field>
          {can('responsibilities.assign') && <Field label="Owned by another role" id="rown" hint="Moves accountability to that role; this role keeps the record."><select id="rown" className="input" value={edit.ownerRoleId} onChange={(e) => setEdit({ ...edit, ownerRoleId: e.target.value })}><option value="">— This role —</option>{flat.filter((f: any) => f.id !== x.role.id).map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}</select></Field>}
          <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" checked={edit.requiresApproval} onChange={(e) => setEdit({ ...edit, requiresApproval: e.target.checked })} />Requires approval</label>
          <div className="sm:col-span-2 flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary">Save</button></div></form>}
      </Modal>
      <Confirm open={!!del} danger title="Delete responsibility?" confirmLabel="Delete" onClose={() => setDel(null)} message={<>“{del?.title}” will be removed from this role. A record of the change is kept in the audit log.</>} onConfirm={async () => { if (await act(() => api('DELETE', `/companies/${cid}/responsibilities/${del.id}`), 'Deleted')) { setDel(null); reload(); } }} />
    </>
  );
}

function Rules({ cid, x, canEdit, reload }: any) {
  const [kind, setKind] = useState('allow'); const [text, setText] = useState('');
  return (
    <div className="space-y-3">
      {x.rules.length === 0 ? <Empty title="No rules yet" hint="Rules say what this role can do, can't do, or can only do with approval." /> : <ul className="card divide-y divide-slate-100">{x.rules.map((r: any) => <li key={r.id} className="flex items-center justify-between gap-3 p-3 text-sm"><span><Badge tone={KIND[r.kind as keyof typeof KIND][1] as any}>{KIND[r.kind as keyof typeof KIND][0]}</Badge> <span className="ml-2">{r.text}</span></span>{canEdit && <button className="btn-ghost px-2 text-red-600" onClick={async () => { if (await act(() => api('DELETE', `/companies/${cid}/roles/${x.role.id}/rules/${r.id}`))) reload(); }}>Remove</button>}</li>)}</ul>}
      {canEdit && <form className="flex flex-wrap gap-2" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('POST', `/companies/${cid}/roles/${x.role.id}/rules`, { kind, text }))) { setText(''); reload(); } }}>
        <select aria-label="Rule type" className="input w-44" value={kind} onChange={(e) => setKind(e.target.value)}>{RULE_KINDS.map((k) => <option key={k} value={k}>{KIND[k][0]}</option>)}</select><input aria-label="Rule text" className="input min-w-0 flex-1" required placeholder="e.g. approve expenses up to the configured limit" value={text} onChange={(e) => setText(e.target.value)} /><button className="btn-primary">Add rule</button></form>}
    </div>
  );
}

function Kpis({ cid, x, canEdit, reload }: any) {
  const [k, setK] = useState({ name: '', target: '', unit: '', period: 'monthly' });
  return (
    <div className="space-y-3">
      {x.kpis.length === 0 ? <Empty title="No KPIs yet" hint="KPIs define how this role's success is measured. Values are recorded in a later phase." /> : <div className="card overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-slate-200 text-slate-500"><tr><th className="p-3">KPI</th><th className="p-3">Target</th><th className="p-3">Period</th><th className="p-3" /></tr></thead><tbody className="divide-y divide-slate-100">{x.kpis.map((q: any) => <tr key={q.id}><td className="p-3 font-medium">{q.name}</td><td className="p-3">{q.target ? `${q.target} ${q.unit ?? ''}` : '—'}</td><td className="p-3">{q.period}</td><td className="p-3 text-right">{canEdit && <button className="btn-ghost px-2 text-red-600" onClick={async () => { if (await act(() => api('DELETE', `/companies/${cid}/roles/${x.role.id}/kpis/${q.id}`))) reload(); }}>Remove</button>}</td></tr>)}</tbody></table></div>}
      {canEdit && <form className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api('POST', `/companies/${cid}/roles/${x.role.id}/kpis`, k))) { setK({ name: '', target: '', unit: '', period: 'monthly' }); reload(); } }}>
        <input aria-label="KPI name" className="input" required placeholder="KPI name" value={k.name} onChange={(e) => setK({ ...k, name: e.target.value })} /><input aria-label="Target" className="input" placeholder="Target" value={k.target} onChange={(e) => setK({ ...k, target: e.target.value })} /><input aria-label="Unit" className="input" placeholder="Unit" value={k.unit} onChange={(e) => setK({ ...k, unit: e.target.value })} /><select aria-label="Period" className="input" value={k.period} onChange={(e) => setK({ ...k, period: e.target.value })}>{REPORTING_FREQUENCIES.filter((p) => p !== 'none').map((p) => <option key={p}>{p}</option>)}</select><button className="btn-primary">Add KPI</button></form>}
    </div>
  );
}

function Perms({ cid, roleId, canEdit, me, can }: any) {
  const p = useApi(`/companies/${cid}/roles/${roleId}/permissions`);
  const [g, setG] = useState<Grant[] | null>(null);
  useEffect(() => { if (p.data) setG(p.data.grants); }, [p.data]);
  const allowed = useMemo(() => (me.accessLevel === 'owner' ? null : new Set<string>(ALL_PERMISSION_KEYS.filter((k) => can(k)))), [me, can]);
  if (p.loading || !g) return <Loading />;
  if (p.error) return <ErrorBox error={p.error} retry={p.reload} />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">These permissions apply to whoever holds this role, enforced on the server for every request. “Own department” limits a permission to roles in the holder's own department.</p>
      <PermissionMatrix grants={g} onChange={setG} disabled={!canEdit} allowedKeys={allowed} />
      {canEdit && <div className="flex justify-end"><button className="btn-primary" onClick={async () => { if (await act(() => api('PUT', `/companies/${cid}/roles/${roleId}/permissions`, { grants: g }), 'Permissions saved')) p.reload(); }}>Save permissions</button></div>}
    </div>
  );
}

function People({ cid, x, canAssign, canSeeMembers, reload }: any) {
  const { can } = useCompany();
  const m = useApi(canAssign && canSeeMembers ? `/companies/${cid}/members` : null); const ag = useApi(can('agents.assign') && can('agents.view') ? `/companies/${cid}/agents` : null);
  const [pick, setPick] = useState('');
  const takenM = new Set(x.assignees.filter((a: any) => a.kind === 'human').map((a: any) => a.membershipId)); const takenA = new Set(x.assignees.filter((a: any) => a.kind === 'ai').map((a: any) => a.agentId));
  const assign = async () => { const [k, v] = pick.split(':'); if (await act(() => api('POST', `/companies/${cid}/roles/${x.role.id}/assignments`, k === 'a' ? { agentId: v } : { membershipId: v }), 'Assigned')) { setPick(''); reload(); } };
  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">Mode follows who is assigned: AI only → AI mode · people only → Human mode · both → Hybrid mode. The owner is accountable for the role.</p>
      {x.assignees.length === 0 ? <Empty title="Nobody is assigned" hint="This role is vacant. Assign a team member or an AI employee." /> : <ul className="card divide-y divide-slate-100">{x.assignees.map((a: any) => <li key={a.assignmentId} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"><span className="font-medium">{a.kind === 'ai' ? '◉ ' : ''}{a.name} <Badge tone={a.kind === 'ai' ? 'violet' : 'green'}>{a.kind === 'ai' ? 'AI' : 'Person'}</Badge> {a.isOwner && <Badge tone="brand">owner</Badge>}</span>
        {canAssign && <span className="flex gap-1">{!a.isOwner && <button className="btn-ghost px-2" onClick={async () => { if (await act(() => api('POST', `/companies/${cid}/roles/${x.role.id}/owner`, { assignmentId: a.assignmentId }), 'Owner changed')) reload(); }}>Make owner</button>}<button className="btn-ghost px-2 text-red-600" onClick={async () => { if (await act(() => api('DELETE', `/companies/${cid}/roles/${x.role.id}/assignments/${a.assignmentId}`), 'Unassigned')) reload(); }}>Unassign</button></span>}</li>)}</ul>}
      {(m.data || ag.data) && <div className="flex gap-2"><select aria-label="Assignee" className="input max-w-sm" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Add a team member or AI employee…</option>
        {m.data && <optgroup label="People">{m.data.members.filter((q: any) => !takenM.has(q.membershipId)).map((q: any) => <option key={q.membershipId} value={`m:${q.membershipId}`}>{q.name}</option>)}</optgroup>}
        {ag.data && <optgroup label="AI employees">{ag.data.agents.filter((q: any) => !takenA.has(q.id)).map((q: any) => <option key={q.id} value={`a:${q.id}`}>◉ {q.name}</option>)}</optgroup>}</select><button className="btn-primary" disabled={!pick} onClick={assign}>Assign</button></div>}
    </div>
  );
}
