'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCompany } from '@/components/company';
import { DeleteRoleConfirm } from '@/components/role-dialogs';
import { Badge, Empty, ErrorBox, Loading, PageHeader, roleTone } from '@/components/ui';
import { ROLE_TYPES, ROLE_TYPE_LABEL } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

export default function Roles() {
  const { id, can } = useCompany();
  const r = useApi(`/companies/${id}/roles`);
  const [q, setQ] = useState(''); const [type, setType] = useState(''); const [del, setDel] = useState<any>(null);
  const list = useMemo(() => (r.data?.roles ?? []).filter((x: any) => (!type || x.roleType === type) && (!q || (x.name + ' ' + (x.departmentName ?? '')).toLowerCase().includes(q.toLowerCase()))), [r.data, q, type]);
  if (r.loading) return <Loading />;
  if (r.error) return <ErrorBox error={r.error} retry={r.reload} />;
  return (
    <>
      <PageHeader title="Roles" subtitle="Every role has responsibilities, rules, permissions and KPIs — independent of who holds it." actions={can('roles.create') && <Link className="btn-primary" href={`/c/${id}/roles/new`}>New role</Link>} />
      <div className="mb-4 flex flex-wrap gap-2"><input aria-label="Search roles" className="input max-w-xs" placeholder="Search roles or departments…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by type" className="input w-auto" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option>{ROLE_TYPES.map((t) => <option key={t} value={t}>{ROLE_TYPE_LABEL[t]}</option>)}</select></div>
      {list.length === 0 ? <Empty title={r.data.roles.length ? 'No roles match your filters' : 'No roles yet'} hint={r.data.roles.length ? undefined : 'Create a role from a template or from scratch.'} /> : (
        <div className="card overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-slate-200 text-slate-500"><tr><th className="p-3">Role</th><th className="p-3">Department</th><th className="p-3">Reports to</th><th className="p-3">Type</th><th className="p-3">People</th><th className="p-3 text-right">Resp. / KPIs</th><th className="p-3" /></tr></thead>
          <tbody className="divide-y divide-slate-100">{list.map((x: any) => (
            <tr key={x.id} className="hover:bg-slate-50"><td className="p-3"><Link className="font-medium text-brand-700 hover:underline" href={`/c/${id}/roles/${x.id}`}>{x.name}</Link></td><td className="p-3">{x.departmentName ?? '—'}</td><td className="p-3">{x.reportsToName ?? <span className="text-slate-400">Founder</span>}</td>
              <td className="p-3"><Badge tone={roleTone(x.roleType)}>{ROLE_TYPE_LABEL[x.roleType as keyof typeof ROLE_TYPE_LABEL]}</Badge></td><td className="p-3">{x.assignees.map((a: any) => a.name).join(', ') || '—'}</td><td className="p-3 text-right">{x.responsibilityCount} / {x.kpiCount}</td>
              <td className="p-3 text-right whitespace-nowrap">{can('roles.create') && <button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { if (await act(() => api('POST', `/companies/${id}/roles/${x.id}/duplicate`, {}), 'Role duplicated')) r.reload(); }}>Duplicate</button>}{can('roles.delete') && <button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => setDel(x)}>Delete</button>}</td></tr>))}</tbody></table></div>)}
      <DeleteRoleConfirm cid={id} role={del} onClose={() => setDel(null)} onDone={() => { setDel(null); r.reload(); }} />
    </>
  );
}
