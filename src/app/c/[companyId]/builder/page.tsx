'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useCompany } from '@/components/company';
import { Badge, ErrorBox, Loading, Modal, PageHeader } from '@/components/ui';
import { act, api, useApi } from '@/lib/client';

export default function Builder() {
  const { id, can } = useCompany();
  const tpl = useApi('/templates'); const roles = useApi(`/companies/${id}/roles`); const depts = useApi(`/companies/${id}/departments`);
  const [apply, setApply] = useState<any>(null); const [skip, setSkip] = useState<Set<string>>(new Set());
  if (tpl.loading || roles.loading) return <Loading />;
  if (tpl.error) return <ErrorBox error={tpl.error} retry={tpl.reload} />;
  const base = `/c/${id}`; const n = roles.data?.roles.length ?? 0;
  const names = Object.fromEntries(tpl.data.roleTemplates.map((r: any) => [r.key, r.name]));
  const step = (done: boolean, title: string, text: string, href: string, label: string) => (
    <div className="card flex items-start gap-3 p-4"><span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${done ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{done ? '✓' : '•'}</span><div className="flex-1"><p className="font-medium">{title}</p><p className="text-sm text-slate-500">{text}</p></div><Link href={href} className="btn-secondary shrink-0">{label}</Link></div>);
  return (
    <>
      <PageHeader title="Company Builder" subtitle="Design your organization: departments, roles, responsibilities, rules and permissions." />
      <section className="grid gap-3 lg:grid-cols-2">
        {step((depts.data?.departments.length ?? 0) > 0, '1 · Departments', 'Group work by function.', `${base}/departments`, 'Manage')}
        {step(n > 0, '2 · Roles & hierarchy', `${n} role${n === 1 ? '' : 's'} so far. Start from a template or add custom roles.`, `${base}/roles/new`, 'Create role')}
        {step(n > 0, '3 · Arrange the org chart', 'Drag roles to change reporting lines.', `${base}/organization`, 'Open chart')}
        {step(false, '4 · Invite your team', 'Invite employees and assign them to roles.', `${base}/employees`, 'Employees')}
      </section>
      <h2 className="mb-2 mt-8 font-semibold">Organization templates</h2>
      <p className="mb-3 text-sm text-slate-500">Adds departments and roles to your existing structure. You can review and untick roles first, and edit everything afterwards.</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{tpl.data.orgTemplates.filter((t: any) => t.nodes.length).map((t: any) => (
        <div key={t.key} className="card flex flex-col p-4"><p className="font-medium">{t.name}</p><p className="mb-3 flex-1 text-sm text-slate-500">{t.description}</p><div className="mb-3 flex flex-wrap gap-1">{t.nodes.slice(0, 6).map((x: any) => <Badge key={x.key}>{x.name ?? names[x.templateKey]}</Badge>)}{t.nodes.length > 6 && <Badge>+{t.nodes.length - 6}</Badge>}</div>
          {can('roles.create') && can('departments.create') ? <button className="btn-secondary" onClick={() => { setApply(t); setSkip(new Set()); }}>Review & apply</button> : <p className="text-xs text-slate-400">You need permission to create roles and departments.</p>}</div>))}</div>
      <h2 className="mb-2 mt-8 font-semibold">Role templates</h2>
      <div className="flex flex-wrap gap-2">{tpl.data.roleTemplates.map((r: any) => <Link key={r.key} className="btn-secondary" href={`${base}/roles/new?template=${r.key}`}>{r.name}</Link>)}<Link className="btn-primary" href={`${base}/roles/new`}>Custom role</Link></div>
      <Modal open={!!apply} onClose={() => setApply(null)} title={`Apply: ${apply?.name}`}>
        <p className="mb-3 text-sm text-slate-500">Untick roles you don't want. Children of an unticked role move up to its manager.</p>
        <ul className="max-h-72 space-y-1 overflow-y-auto">{apply?.nodes.map((x: any) => <li key={x.key}><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!skip.has(x.key)} onChange={(e) => { const s = new Set(skip); e.target.checked ? s.delete(x.key) : s.add(x.key); setSkip(s); }} />{x.name ?? names[x.templateKey]}{x.parent ? <span className="text-slate-400"> ↳ under {apply.nodes.find((p: any) => p.key === x.parent)?.name ?? names[apply.nodes.find((p: any) => p.key === x.parent)?.templateKey]}</span> : null}</label></li>)}</ul>
        <div className="mt-5 flex justify-end gap-2"><button className="btn-secondary" onClick={() => setApply(null)}>Cancel</button>
          <button className="btn-primary" onClick={async () => { const r = await act(() => api('POST', `/companies/${id}/apply-org-template`, { templateKey: apply.key, includeNodeKeys: apply.nodes.map((x: any) => x.key).filter((k: string) => !skip.has(k)) })); if (r) { act(async () => 0, `${r.rolesCreated} roles created`); setApply(null); roles.reload(); depts.reload(); } }}>Create roles</button></div>
      </Modal>
    </>
  );
}
