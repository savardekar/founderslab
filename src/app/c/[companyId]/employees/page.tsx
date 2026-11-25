'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useCompany } from '@/components/company';
import { PermissionMatrix, type Grant } from '@/components/permission-matrix';
import { Badge, Confirm, Empty, ErrorBox, Field, Loading, Modal, PageHeader, fmtDate } from '@/components/ui';
import { ALL_PERMISSION_KEYS } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

export default function Employees() {
  const { id, can, me } = useCompany();
  const m = useApi(`/companies/${id}/members`); const emps = useApi(`/companies/${id}/employees`); const roles = useApi(can('roles.view') ? `/companies/${id}/roles` : null); const depts = useApi(can('departments.view') ? `/companies/${id}/departments` : null);
  const [inv, setInv] = useState<any>(null); const [sent, setSent] = useState<any>(null); const [rm, setRm] = useState<any>(null); const [perm, setPerm] = useState<any>(null);
  if (m.loading || emps.loading) return <Loading />;
  if (m.error) return <ErrorBox error={m.error} retry={m.reload} />;
  const { invites } = m.data; const members = emps.data?.employees ?? [];
  return (
    <>
      <PageHeader title="Employees" subtitle="People with access to this company. A person's access comes from their access level and the roles they hold." actions={can('members.create') && <button className="btn-primary" onClick={() => setInv({ email: '', accessLevel: 'member', roleIds: [], departmentId: '', managerMembershipId: '', jobTitle: '' })}>Invite employee</button>} />
      <div className="card divide-y divide-slate-100">{members.map((p: any) => (
        <div key={p.membershipId} className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div><p className="font-medium"><Link className="hover:text-brand-700 hover:underline" href={`/c/${id}/employees/${p.membershipId}`}>{p.name}</Link> {p.status !== 'active' && <Badge tone={p.status === 'on_leave' ? 'amber' : 'slate'}>{p.status.replace('_', ' ')}</Badge>} <Badge tone={p.accessLevel === 'owner' ? 'violet' : p.accessLevel === 'admin' ? 'brand' : 'slate'}>{p.accessLevel === 'owner' ? 'Founder / Owner' : p.accessLevel}</Badge></p>
            <p className="text-sm text-slate-500">{p.email}{p.jobTitle ? ` · ${p.jobTitle}` : ''}{p.departmentName ? ` · ${p.departmentName}` : ''}{p.managerName ? ` · reports to ${p.managerName}` : ''}</p>
            <p className="mt-1 text-sm">{p.roles.length ? p.roles.map((r: any) => <Badge key={r.assignmentId} tone="green">{r.roleName}</Badge>) : <span className="text-slate-400">No role assigned</span>}</p></div>
          <div className="flex gap-2">
            {p.accessLevel !== 'owner' && me.accessLevel === 'owner' && <button className="btn-secondary" onClick={async () => { if (await act(() => api('PATCH', `/companies/${id}/members/${p.membershipId}`, { accessLevel: p.accessLevel === 'admin' ? 'member' : 'admin' }), 'Access level updated')) m.reload(); }}>{p.accessLevel === 'admin' ? 'Make member' : 'Make admin'}</button>}
            {p.accessLevel === 'admin' && can('permissions.configure') && <button className="btn-secondary" onClick={() => setPerm(p)}>Admin permissions</button>}
            {p.accessLevel !== 'owner' && p.membershipId !== me.membershipId && can('members.delete') && p.status !== 'inactive' && <button className="btn-ghost text-red-600" onClick={() => setRm(p)}>Remove</button>}</div></div>))}</div>
      {invites.length > 0 && <><h2 className="mb-2 mt-6 font-semibold">Pending invitations</h2><div className="card divide-y divide-slate-100">{invites.map((i: any) => <div key={i.id} className="flex items-center justify-between p-3 text-sm"><span>{i.email} <Badge>{i.accessLevel}</Badge> <span className="text-slate-400">expires {fmtDate(i.expiresAt)}</span></span>{can('members.delete') && <button className="btn-ghost text-red-600" onClick={async () => { if (await act(() => api('DELETE', `/companies/${id}/invites/${i.id}`), 'Invitation revoked')) m.reload(); }}>Revoke</button>}</div>)}</div></>}
      {members.length === 1 && invites.length === 0 && <div className="mt-4"><Empty title="It's just you for now" hint="That's fine — run the company with AI roles and invite people when you hire." /></div>}

      <Modal open={!!inv} onClose={() => setInv(null)} title="Invite employee">
        {inv && <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const r = await act(() => api('POST', `/companies/${id}/invites`, { email: inv.email, accessLevel: inv.accessLevel, roleIds: inv.roleIds, departmentId: inv.departmentId || null, managerMembershipId: inv.managerMembershipId || null, jobTitle: inv.jobTitle || null })); if (r) { setInv(null); setSent(r); m.reload(); } }}>
          <Field label="Email" id="ie"><input id="ie" type="email" required autoFocus className="input" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} /></Field>
          {me.accessLevel === 'owner' && <Field label="Access level" id="ia" hint="Members only get what their role grants. Admins can manage the company configuration within the permissions you set."><select id="ia" className="input" value={inv.accessLevel} onChange={(e) => setInv({ ...inv, accessLevel: e.target.value })}><option value="member">Member</option><option value="admin">Admin</option></select></Field>}
          <div className="grid gap-4 sm:grid-cols-2"><Field label="Job title" id="ij"><input id="ij" className="input" value={inv.jobTitle} onChange={(e) => setInv({ ...inv, jobTitle: e.target.value })} /></Field>
            {depts.data && <Field label="Department" id="id"><select id="id" className="input" value={inv.departmentId} onChange={(e) => setInv({ ...inv, departmentId: e.target.value })}><option value="">— None —</option>{depts.data.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>}
            <Field label="Manager" id="im"><select id="im" className="input" value={inv.managerMembershipId} onChange={(e) => setInv({ ...inv, managerMembershipId: e.target.value })}><option value="">— None —</option>{members.filter((x: any) => x.status === 'active').map((x: any) => <option key={x.membershipId} value={x.membershipId}>{x.name}</option>)}</select></Field></div>
          {roles.data && can('roles.assign') && <fieldset><legend className="label">Assign to roles (optional)</legend><div className="max-h-36 overflow-y-auto rounded-lg border border-slate-200 p-2">{roles.data.roles.map((r: any) => <label key={r.id} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={inv.roleIds.includes(r.id)} onChange={(e) => setInv({ ...inv, roleIds: e.target.checked ? [...inv.roleIds, r.id] : inv.roleIds.filter((x: string) => x !== r.id) })} />{r.name}</label>)}</div></fieldset>}
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setInv(null)}>Cancel</button><button className="btn-primary">Send invitation</button></div></form>}
      </Modal>
      <Modal open={!!sent} onClose={() => setSent(null)} title="Invitation created">
        {sent && <div className="space-y-3 text-sm">{sent.emailDelivered ? <p>An email was sent to <b>{sent.email}</b>.</p> : <p className="rounded-lg bg-amber-50 p-3 text-amber-900">No email provider is configured, so no email was sent. {sent.devLink ? 'Share this link with the invitee yourself:' : 'Configure a mail transport to deliver invitations.'}</p>}
          {sent.devLink && <input readOnly className="input" value={sent.devLink} onFocus={(e) => e.target.select()} aria-label="Invitation link" />}<div className="flex justify-end"><button className="btn-primary" onClick={() => setSent(null)}>Done</button></div></div>}
      </Modal>
      <Confirm open={!!rm} danger title="Remove from company?" confirmLabel="Remove" onClose={() => setRm(null)} message={<>{rm?.name} loses access immediately. Their role assignments end (history is kept), and roles left without anyone become vacant. Company records they created remain with the company.</>} onConfirm={async () => { const r = await act(() => api('DELETE', `/companies/${id}/members/${rm.membershipId}`)); if (r) { setRm(null); m.reload(); } }} />
      {perm && <AdminPerms cid={id} person={perm} me={me} can={can} onClose={() => setPerm(null)} />}
    </>
  );
}

function AdminPerms({ cid, person, me, can, onClose }: any) {
  const p = useApi(`/companies/${cid}/members/${person.membershipId}/permissions`);
  const [g, setG] = useState<Grant[] | null>(null);
  if (p.data && !g) setG(p.data.keys.map((key: string) => ({ key, scope: 'company' as const })));
  const allowed = me.accessLevel === 'owner' ? null : new Set<string>(ALL_PERMISSION_KEYS.filter((k) => can(k)));
  return (
    <Modal open onClose={onClose} title={`Permissions — ${person.name}`} wide>
      <p className="mb-3 text-sm text-slate-500">Admins don't automatically get everything. These grants apply company-wide, in addition to anything their roles grant.</p>
      {!g ? <Loading /> : <><PermissionMatrix grants={g} onChange={setG} showScope={false} allowedKeys={allowed} />
        <div className="mt-4 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button><button className="btn-primary" onClick={async () => { if (await act(() => api('PUT', `/companies/${cid}/members/${person.membershipId}/permissions`, { keys: g.map((x) => x.key) }), 'Permissions saved')) onClose(); }}>Save</button></div></>}
    </Modal>
  );
}
