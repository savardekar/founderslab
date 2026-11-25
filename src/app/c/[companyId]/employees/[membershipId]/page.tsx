'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useCompany } from '@/components/company';
import { PermissionMatrix, type Grant } from '@/components/permission-matrix';
import { Badge, Confirm, ErrorBox, Field, Loading, PageHeader, Tabs, fmtDate } from '@/components/ui';
import { ALL_PERMISSION_KEYS } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

export default function Page({ params }: { params: Promise<{ membershipId: string }> }) {
  const [mid, setMid] = useState<string | null>(null);
  useEffect(() => { params.then((p) => setMid(p.membershipId)); }, [params]);
  return mid ? <Employee mid={mid} /> : <Loading />;
}

function Employee({ mid }: { mid: string }) {
  const { id, can, me } = useCompany();
  const e = useApi(`/companies/${id}/employees/${mid}`);
  const [tab, setTab] = useState<'profile' | 'access'>('profile'); const [off, setOff] = useState(false);
  if (e.loading) return <Loading />;
  if (e.error) return <ErrorBox error={e.error} retry={e.reload} />;
  const x = e.data; const inactive = x.status === 'inactive'; const isOwner = x.accessLevel === 'owner'; const self = x.membershipId === me.membershipId;
  return (
    <>
      <p className="mb-2 text-sm text-slate-500"><Link className="hover:underline" href={`/c/${id}/employees`}>Employees</Link> › {x.name}</p>
      <PageHeader title={x.name} subtitle={`${x.email}${x.jobTitle ? ` · ${x.jobTitle}` : ''}`} actions={<><Badge tone={x.status === 'active' ? 'green' : x.status === 'on_leave' ? 'amber' : 'slate'}>{x.status.replace('_', ' ')}</Badge><Badge tone={isOwner ? 'violet' : x.accessLevel === 'admin' ? 'brand' : 'slate'}>{isOwner ? 'owner' : x.accessLevel}</Badge>
        {can('members.delete') && !isOwner && !self && (inactive ? <button className="btn-primary" onClick={async () => { if (await act(() => api('POST', `/companies/${id}/employees/${mid}/reactivate`, {}), 'Reactivated. Role assignments were not restored.')) e.reload(); }}>Reactivate</button> : <button className="btn-secondary text-red-600" onClick={() => setOff(true)}>Deactivate</button>)}</>} />
      {inactive && <div className="mb-4 rounded-lg border border-slate-200 bg-slate-100 p-3 text-sm text-slate-700">Deactivated {x.deactivatedAt ? fmtDate(x.deactivatedAt) : ''}. They cannot sign in to this company. Their past work and role history are kept.</div>}
      <Tabs tabs={[{ id: 'profile', label: 'Profile & assignments' }, ...(can('permissions.view') && !isOwner ? [{ id: 'access' as const, label: 'Permissions' }] : [])]} value={tab} onChange={setTab} />
      {tab === 'profile' && <Profile cid={id} x={x} can={can} reload={e.reload} />}
      {tab === 'access' && <Access cid={id} mid={mid} can={can} me={me} />}
      <Confirm open={off} danger title="Deactivate employee?" confirmLabel="Deactivate" onClose={() => setOff(false)} message={<>{x.name} loses access immediately and is removed from {x.roles.length} role(s), which become vacant or pass to remaining owners. Reactivation restores access but not role assignments.</>} onConfirm={async () => { if (await act(() => api('POST', `/companies/${id}/employees/${mid}/deactivate`, {}), 'Employee deactivated')) { setOff(false); e.reload(); } }} />
    </>
  );
}

function Profile({ cid, x, can, reload }: any) {
  const edit = can('members.edit') && x.status !== 'inactive';
  const depts = useApi(edit ? `/companies/${cid}/departments` : null); const mem = useApi(edit ? `/companies/${cid}/members` : null);
  const roles = useApi(can('roles.assign') && x.status !== 'inactive' ? `/companies/${cid}/roles` : null);
  const [f, setF] = useState({ jobTitle: x.jobTitle ?? '', departmentId: x.departmentId ?? '', managerMembershipId: x.managerMembershipId ?? '', phone: x.phone ?? '', bio: x.bio ?? '', status: x.status === 'on_leave' ? 'on_leave' : 'active' });
  const [pick, setPick] = useState('');
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <form className="card grid gap-4 p-5 sm:grid-cols-2 lg:col-span-2" onSubmit={async (ev) => { ev.preventDefault(); if (await act(() => api('PATCH', `/companies/${cid}/employees/${x.membershipId}`, { jobTitle: f.jobTitle, departmentId: f.departmentId || null, managerMembershipId: f.managerMembershipId || null, phone: f.phone, bio: f.bio, status: f.status }), 'Profile saved')) reload(); }}>
        <Field label="Job title" id="jt"><input id="jt" className="input" disabled={!edit} value={f.jobTitle} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} /></Field>
        <Field label="Status" id="st"><select id="st" className="input" disabled={!edit || x.accessLevel === 'owner'} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Active</option><option value="on_leave">On leave</option></select></Field>
        <Field label="Department" id="d"><select id="d" className="input" disabled={!edit} value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">— None —</option>{depts.data?.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}{!depts.data && x.departmentId && <option value={x.departmentId}>{x.departmentName}</option>}</select></Field>
        <Field label="Manager" id="m"><select id="m" className="input" disabled={!edit} value={f.managerMembershipId} onChange={(e) => setF({ ...f, managerMembershipId: e.target.value })}><option value="">— None —</option>{mem.data?.members.filter((m: any) => m.membershipId !== x.membershipId).map((m: any) => <option key={m.membershipId} value={m.membershipId}>{m.name}</option>)}{!mem.data && x.managerMembershipId && <option value={x.managerMembershipId}>{x.managerName}</option>}</select></Field>
        <Field label="Phone" id="p"><input id="p" className="input" disabled={!edit} value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Started"><input className="input" disabled value={x.startDate ? fmtDate(x.startDate) : '—'} /></Field>
        <div className="sm:col-span-2"><Field label="About" id="b"><textarea id="b" rows={3} className="input" disabled={!edit} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} /></Field></div>
        {edit && <div className="sm:col-span-2 flex justify-end"><button className="btn-primary">Save profile</button></div>}
      </form>
      <div className="space-y-4">
        <div className="card p-4"><h3 className="mb-2 font-semibold">Roles</h3>{x.roles.length === 0 ? <p className="text-sm text-slate-500">No role assigned.</p> : <ul className="space-y-2 text-sm">{x.roles.map((r: any) => <li key={r.assignmentId} className="flex items-center justify-between"><span><Link className="text-brand-700 hover:underline" href={`/c/${cid}/roles/${r.roleId}`}>{r.roleName}</Link> {r.isOwner && <Badge tone="brand">owner</Badge>}</span>{can('roles.assign') && x.status !== 'inactive' && <button className="btn-ghost px-2 text-red-600" onClick={async () => { if (await act(() => api('DELETE', `/companies/${cid}/roles/${r.roleId}/assignments/${r.assignmentId}`), 'Removed from role')) reload(); }}>Remove</button>}</li>)}</ul>}
          {roles.data && <div className="mt-3 flex gap-2"><select aria-label="Role" className="input" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Assign to role…</option>{roles.data.roles.filter((r: any) => !x.roles.some((a: any) => a.roleId === r.id)).map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select><button className="btn-primary" disabled={!pick} onClick={async () => { if (await act(() => api('POST', `/companies/${cid}/roles/${pick}/assignments`, { membershipId: x.membershipId }), 'Assigned')) { setPick(''); reload(); } }}>Add</button></div>}</div>
        <div className="card p-4"><h3 className="mb-2 font-semibold">Direct reports</h3>{x.directReports.length ? <ul className="space-y-1 text-sm">{x.directReports.map((d: any) => <li key={d.membershipId}><Link className="text-brand-700 hover:underline" href={`/c/${cid}/employees/${d.membershipId}`}>{d.name}</Link></li>)}</ul> : <p className="text-sm text-slate-500">None</p>}</div>
        {x.onboarding.length > 0 && <div className="card p-4"><h3 className="mb-2 font-semibold">Onboarding</h3><ul className="space-y-1 text-sm">{x.onboarding.map((o: any) => <li key={o.id}>{o.done ? '✓' : '○'} {o.title}</li>)}</ul></div>}
      </div>
    </div>
  );
}

function Access({ cid, mid, can, me }: any) {
  const p = useApi(`/companies/${cid}/members/${mid}/permissions`); const [g, setG] = useState<Grant[] | null>(null);
  useEffect(() => { if (p.data) setG(p.data.keys.map((key: string) => ({ key, scope: 'company' as const }))); }, [p.data]);
  if (p.loading || !g) return <Loading />;
  const allowed = me.accessLevel === 'owner' ? null : new Set<string>(ALL_PERMISSION_KEYS.filter((k) => can(k)));
  const edit = can('permissions.configure') && mid !== me.membershipId;
  return (
    <div className="space-y-3"><p className="text-sm text-slate-500">Direct permissions for this person, company-wide, in addition to whatever their roles grant. Reporting lines never grant access.</p>
      <PermissionMatrix grants={g} onChange={setG} showScope={false} disabled={!edit} allowedKeys={allowed} />
      {edit && <div className="flex justify-end"><button className="btn-primary" onClick={async () => { if (await act(() => api('PUT', `/companies/${cid}/members/${mid}/permissions`, { keys: g.map((x) => x.key) }), 'Permissions saved')) p.reload(); }}>Save permissions</button></div>}</div>
  );
}
