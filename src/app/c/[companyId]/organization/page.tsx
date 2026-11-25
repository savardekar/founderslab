'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useCompany } from '@/components/company';
import { DeleteRoleConfirm, MoveRoleModal, subtreeIds } from '@/components/role-dialogs';
import { Badge, Empty, ErrorBox, Loading, PageHeader, roleTone } from '@/components/ui';
import { ROLE_TYPE_LABEL } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

export default function Organization() {
  const { id, company, can } = useCompany();
  const tree = useApi(`/companies/${id}/org-tree`);
  const flat = useApi(`/companies/${id}/roles`);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [move, setMove] = useState<any>(null); const [del, setDel] = useState<any>(null); const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const reload = () => { tree.reload(); flat.reload(); };
  if (tree.loading || flat.loading) return <Loading />;
  if (tree.error) return <ErrorBox error={tree.error} retry={tree.reload} />;
  const roles = flat.data?.roles ?? [];
  const editable = can('roles.edit');

  async function drop(parentId: string | null) {
    const rid = drag; setDrag(null); setOver(null);
    if (!rid) return;
    const r = roles.find((x: any) => x.id === rid);
    if (!r || r.reportsToRoleId === parentId) return;
    if (parentId && subtreeIds(roles, rid).has(parentId)) return act(async () => { throw new Error('A role cannot report to one of its own reports'); });
    if (await act(() => api('PUT', `/companies/${id}/roles/${rid}/move`, { reportsToRoleId: parentId }), 'Reporting line updated')) reload();
  }
  const Node = ({ n }: { n: any }) => {
    const isCollapsed = collapsed.has(n.id);
    return (
      <li className="relative pl-6 before:absolute before:left-0 before:top-0 before:h-full before:border-l before:border-slate-300 last:before:h-5 after:absolute after:left-0 after:top-5 after:w-5 after:border-t after:border-slate-300">
        <div draggable={editable} onDragStart={(e) => { setDrag(n.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => { setDrag(null); setOver(null); }}
          onDragOver={(e) => { if (drag && drag !== n.id) { e.preventDefault(); setOver(n.id); } }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.preventDefault(); drop(n.id); }}
          className={`card my-1.5 flex flex-wrap items-center justify-between gap-2 p-3 ${over === n.id ? 'border-brand-500 ring-2 ring-brand-500/30' : ''} ${editable ? 'cursor-grab' : ''}`}>
          <div className="flex min-w-0 items-center gap-2">
            {n.children.length > 0 && <button className="btn-ghost px-1.5 py-0.5" aria-label={isCollapsed ? 'Expand' : 'Collapse'} onClick={() => { const s = new Set(collapsed); isCollapsed ? s.delete(n.id) : s.add(n.id); setCollapsed(s); }}>{isCollapsed ? '▸' : '▾'}</button>}
            <div className="min-w-0"><Link href={`/c/${id}/roles/${n.id}`} className="font-medium hover:text-brand-700 hover:underline">{n.name}</Link>
              <p className="truncate text-xs text-slate-500">{[n.departmentName, n.assignees.map((a: any) => a.name).join(', ') || null].filter(Boolean).join(' · ') || 'No department'}</p></div>
          </div>
          <div className="flex items-center gap-2"><Badge tone={roleTone(n.roleType)}>{ROLE_TYPE_LABEL[n.roleType as keyof typeof ROLE_TYPE_LABEL]}</Badge>
            {can('roles.create') && <Link className="btn-ghost px-2 py-1 text-xs" href={`/c/${id}/roles/new?parent=${n.id}`}>＋ Report</Link>}
            {editable && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => setMove(n)}>Move</button>}
            {can('roles.create') && <button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { if (await act(() => api('POST', `/companies/${id}/roles/${n.id}/duplicate`, {}), 'Role duplicated')) reload(); }}>Duplicate</button>}
            {can('roles.delete') && <button className="btn-ghost px-2 py-1 text-xs text-red-600" onClick={() => setDel(n)}>Delete</button>}</div>
        </div>
        {!isCollapsed && n.children.length > 0 && <ul>{n.children.map((c: any) => <Node key={c.id} n={c} />)}</ul>}
      </li>
    );
  };
  return (
    <>
      <PageHeader title="Organization" subtitle={editable ? 'Drag a role onto another to change who it reports to — or use Move.' : 'Your company hierarchy'} actions={can('roles.create') && <Link href={`/c/${id}/roles/new`} className="btn-primary">New role</Link>} />
      {tree.data.roots.length === 0 ? <Empty title="No roles yet" hint="Start from an organization template or create your first role." action={<Link className="btn-primary" href={`/c/${id}/builder`}>Open Company Builder</Link>} /> : (
        <div className="card overflow-x-auto p-4">
          <div onDragOver={(e) => { if (drag) { e.preventDefault(); setOver('root'); } }} onDragLeave={() => setOver(null)} onDrop={(e) => { e.preventDefault(); drop(null); }}
            className={`mb-2 inline-flex items-center gap-2 rounded-lg border px-3 py-2 ${over === 'root' ? 'border-brand-500 bg-brand-50' : 'border-slate-200 bg-slate-50'}`}><span className="flex h-6 w-6 items-center justify-center rounded bg-brand-600 text-xs font-bold text-white">F</span><span className="font-semibold">Founder</span><span className="text-xs text-slate-500">{company.name}{drag ? ' — drop here for top level' : ''}</span></div>
          <ul className="min-w-[640px]">{tree.data.roots.map((n: any) => <Node key={n.id} n={n} />)}</ul>
        </div>)}
      {move && <MoveRoleModal cid={id} role={move} roles={roles} onClose={() => setMove(null)} onDone={() => { setMove(null); reload(); }} />}
      <DeleteRoleConfirm cid={id} role={del} onClose={() => setDel(null)} onDone={() => { setDel(null); reload(); }} />
    </>
  );
}
