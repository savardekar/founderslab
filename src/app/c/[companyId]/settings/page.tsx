'use client';
import { useEffect, useState } from 'react';
import { useCompany } from '@/components/company';
import { Empty, ErrorBox, Field, Loading, PageHeader, Tabs, fmtDate, titleCase } from '@/components/ui';
import { STAGES, STAGE_LABEL, WORKFORCE_MODES } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

export default function Settings() {
  const { id, company, can, reload } = useCompany();
  const [tab, setTab] = useState<'general' | 'audit'>('general');
  const [f, setF] = useState<any>(null);
  useEffect(() => { setF({ ...company, objectivesText: (company.objectives ?? []).join('\n'), teamSize: company.teamSize ?? '' }); }, [company]);
  const audit = useApi(tab === 'audit' && can('audit.view') ? `/companies/${id}/audit?limit=100` : null);
  if (!f) return <Loading />;
  const ro = !can('company.edit');
  const set = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const tabs = [{ id: 'general' as const, label: 'Company' }, ...(can('audit.view') ? [{ id: 'audit' as const, label: 'Audit log' }] : [])];
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: any = {};
    for (const k of ['name', 'industry', 'businessModel', 'productService', 'targetCustomers', 'description', 'website', 'country', 'logoUrl', 'stage', 'budgetRange', 'workforceMode']) body[k] = f[k] ?? '';
    body.teamSize = f.teamSize === '' ? null : Number(f.teamSize);
    body.objectives = f.objectivesText.split('\n').map((s: string) => s.trim()).filter(Boolean);
    if (await act(() => api('PATCH', `/companies/${id}`, body), 'Company saved')) reload();
  }
  return (
    <>
      <PageHeader title="Settings" subtitle="Company profile and activity" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'general' && (
        <form onSubmit={save} className="card grid gap-4 p-6 sm:grid-cols-2">
          {ro && <p className="sm:col-span-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">You can view but not edit company settings.</p>}
          <Field label="Company name" id="n"><input id="n" className="input" required disabled={ro} value={f.name ?? ''} onChange={set('name')} /></Field>
          <Field label="Logo URL" id="l" hint="Direct image link (file upload arrives with storage integration)."><input id="l" className="input" disabled={ro} placeholder="https://…" value={f.logoUrl ?? ''} onChange={set('logoUrl')} /></Field>
          <Field label="Industry" id="i"><input id="i" className="input" disabled={ro} value={f.industry ?? ''} onChange={set('industry')} /></Field>
          <Field label="Business model" id="bm"><input id="bm" className="input" disabled={ro} value={f.businessModel ?? ''} onChange={set('businessModel')} /></Field>
          <Field label="Website" id="w"><input id="w" className="input" disabled={ro} placeholder="https://…" value={f.website ?? ''} onChange={set('website')} /></Field>
          <Field label="Country" id="c"><input id="c" className="input" disabled={ro} value={f.country ?? ''} onChange={set('country')} /></Field>
          <Field label="Stage" id="s"><select id="s" className="input" disabled={ro} value={f.stage} onChange={set('stage')}>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select></Field>
          <Field label="Workforce approach" id="wm"><select id="wm" className="input" disabled={ro} value={f.workforceMode} onChange={set('workforceMode')}>{WORKFORCE_MODES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select></Field>
          <Field label="Team size" id="ts"><input id="ts" type="number" min={0} className="input" disabled={ro} value={f.teamSize} onChange={set('teamSize')} /></Field>
          <Field label="Budget" id="b"><input id="b" className="input" disabled={ro} value={f.budgetRange ?? ''} onChange={set('budgetRange')} /></Field>
          <div className="sm:col-span-2"><Field label="Product or service" id="ps"><input id="ps" className="input" disabled={ro} value={f.productService ?? ''} onChange={set('productService')} /></Field></div>
          <div className="sm:col-span-2"><Field label="Target customers" id="tc"><input id="tc" className="input" disabled={ro} value={f.targetCustomers ?? ''} onChange={set('targetCustomers')} /></Field></div>
          <div className="sm:col-span-2"><Field label="Description" id="d"><textarea id="d" rows={3} className="input" disabled={ro} value={f.description ?? ''} onChange={set('description')} /></Field></div>
          <div className="sm:col-span-2"><Field label="Business objectives" id="o" hint="One per line."><textarea id="o" rows={4} className="input" disabled={ro} value={f.objectivesText} onChange={set('objectivesText')} /></Field></div>
          {!ro && <div className="sm:col-span-2 flex justify-end"><button className="btn-primary">Save changes</button></div>}
        </form>
      )}
      {tab === 'audit' && (audit.loading ? <Loading /> : audit.error ? <ErrorBox error={audit.error} retry={audit.reload} /> : audit.data.events.length === 0 ? <Empty title="No activity yet" /> : (
        <div className="card overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-slate-200 text-slate-500"><tr><th className="p-3">When</th><th className="p-3">Who</th><th className="p-3">Action</th><th className="p-3">Details</th></tr></thead><tbody className="divide-y divide-slate-100">
          {audit.data.events.map((e: any) => <tr key={e.id}><td className="whitespace-nowrap p-3 text-slate-500">{fmtDate(e.createdAt)}</td><td className="p-3">{e.actor ?? 'System'}</td><td className="p-3 font-medium">{titleCase(e.action)}</td><td className="max-w-md truncate p-3 text-slate-500" title={JSON.stringify(e.metadata)}>{e.metadata?.name ?? e.metadata?.email ?? Object.keys(e.metadata ?? {}).join(', ')}</td></tr>)}</tbody></table></div>))}
    </>
  );
}
