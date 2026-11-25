'use client';
import Link from 'next/link';
import { useCompany } from '@/components/company';
import { Badge, ErrorBox, Loading, PageHeader, fmtDate, roleTone, titleCase } from '@/components/ui';
import { ROLE_TYPE_LABEL } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';
import { FounderPanel, MyWork } from '@/components/founder-panel';

const Stat = ({ label, value, href }: { label: string; value: React.ReactNode; href?: string }) => {
  const inner = <div className="card p-4 transition hover:border-brand-500"><p className="text-sm text-slate-500">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>;
  return href ? <Link href={href}>{inner}</Link> : inner;
};

export default function Dashboard() {
  const { id, company, can, me } = useCompany();
  const d = useApi(`/companies/${id}/dashboard`); const mine = useApi(`/companies/${id}/me/profile`);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  const x = d.data; const base = `/c/${id}`;
  const cl = x.checklist;
  const todo = cl ? [
    ...(cl.humanRolesWithoutPerson.length ? [{ t: `${cl.humanRolesWithoutPerson.length} human / hybrid role(s) have nobody assigned`, href: `${base}/employees`, items: cl.humanRolesWithoutPerson }] : []),
    ...(cl.rolesWithoutResponsibilities.length ? [{ t: `${cl.rolesWithoutResponsibilities.length} role(s) have no responsibilities defined`, href: `${base}/roles`, items: cl.rolesWithoutResponsibilities }] : []),
    ...(cl.rolesWithoutKpis.length ? [{ t: `${cl.rolesWithoutKpis.length} role(s) have no KPIs`, href: `${base}/roles`, items: cl.rolesWithoutKpis }] : []),
  ] : [];
  return (
    <>
      <PageHeader title={`${company.name}`} subtitle="Founder command center — live from your tasks, projects, KPIs and AI activity" actions={can('roles.create') && <Link className="btn-primary" href={`${base}/roles/new`}>New role</Link>} />
      <MyWork />
      {(me.accessLevel === 'owner' || can('reports.view')) && <FounderPanel />}
      {x.roles ? (
        <section className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Overview">
          <Stat label="Roles" value={x.roles.total} href={`${base}/roles`} />
          <Stat label="Departments" value={x.departments ?? '—'} href={`${base}/departments`} />
          <Stat label="People" value={x.members ?? '—'} href={`${base}/employees`} />
          <Stat label="Responsibilities" value={x.responsibilities} />
          <Stat label="AI roles" value={x.roles.ai} /><Stat label="Human roles" value={x.roles.human} /><Stat label="Hybrid roles" value={x.roles.hybrid} /><Stat label="Vacant roles" value={x.roles.vacant} />
        </section>
      ) : null}
      {mine.data?.onboarding?.length > 0 && mine.data.onboarding.some((o: any) => !o.done) && (<section className="card mt-6 p-5"><h2 className="mb-2 font-semibold">Getting started</h2><ul className="space-y-1 text-sm">{mine.data.onboarding.map((o: any) => <li key={o.id}><label className="flex items-center gap-2"><input type="checkbox" checked={o.done} onChange={async (e) => { if (await act(() => api('POST', `/companies/${id}/me/onboarding/${o.id}`, { done: e.target.checked }))) mine.reload(); }} />{o.title}</label></li>)}</ul></section>)}
      {x.myRoles.length > 0 && (<section className="mt-6"><h2 className="mb-2 font-semibold">My roles</h2><div className="grid gap-3 sm:grid-cols-2">{x.myRoles.map((r: any) => (
        <div key={r.id} className="card p-4"><div className="flex items-center justify-between"><p className="font-medium">{r.name}</p><Badge tone={roleTone(r.roleType)}>{ROLE_TYPE_LABEL[r.roleType as keyof typeof ROLE_TYPE_LABEL]}</Badge></div><MyResp companyId={id} roleId={r.id} /></div>))}</div></section>)}
      {!x.roles && x.myRoles.length === 0 && <div className="card mt-6 p-6 text-sm text-slate-600">You're a member of {company.name}. Once you're assigned a role, its responsibilities will appear here. Ask the founder or an admin for access to more.</div>}
      {cl && (<section className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="card p-5"><h2 className="mb-3 font-semibold">Setup checklist</h2>
          {cl.topLevelRoles === 0 && x.roles.total === 0 ? <p className="text-sm text-slate-600">Your organization is empty. <Link className="text-brand-700 underline" href={`${base}/builder`}>Open the Company Builder</Link> to start from a template or design your own structure.</p>
            : todo.length === 0 ? <p className="text-sm text-emerald-700">✓ Every role has responsibilities, KPIs and an owner.</p>
            : <ul className="space-y-3 text-sm">{todo.map((t) => <li key={t.t}><Link className="font-medium text-brand-700 hover:underline" href={t.href}>{t.t}</Link><p className="text-slate-500">{t.items.slice(0, 4).map((i: any) => i.name).join(', ')}{t.items.length > 4 ? '…' : ''}</p></li>)}</ul>}
        </div>
        <div className="card p-5"><h2 className="mb-3 font-semibold">Business objectives</h2>{company.objectives?.length ? <ul className="list-disc space-y-1 pl-5 text-sm">{company.objectives.map((o: string) => <li key={o}>{o}</li>)}</ul> : <p className="text-sm text-slate-500">No objectives set yet. {can('company.edit') && <Link className="text-brand-700 underline" href={`${base}/settings`}>Add objectives</Link>}</p>}</div>
      </section>)}
      {x.recentActivity && (<section className="card mt-6 p-5"><h2 className="mb-3 font-semibold">Recent activity</h2>{x.recentActivity.length === 0 ? <p className="text-sm text-slate-500">Nothing yet.</p> : <ul className="divide-y divide-slate-100 text-sm">{x.recentActivity.map((e: any) => <li key={e.id} className="flex justify-between gap-4 py-2"><span><b>{e.actor ?? 'System'}</b> · {titleCase(e.action)}{e.metadata?.name ? ` — ${e.metadata.name}` : ''}</span><span className="shrink-0 text-slate-400">{fmtDate(e.createdAt)}</span></li>)}</ul>}</section>)}
      <p className="mt-6 text-xs text-slate-400">Signed in as {me.accessLevel}.</p>
    </>
  );
}

function MyResp({ companyId, roleId }: { companyId: string; roleId: string }) {
  const r = useApi(`/companies/${companyId}/my-roles`);
  const role = r.data?.roles.find((x: any) => x.id === roleId);
  if (!role) return null;
  return <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-600">{role.responsibilities.map((x: any) => <li key={x.id}>{x.title}</li>)}</ul>;
}
