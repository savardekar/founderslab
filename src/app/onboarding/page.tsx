'use client';
import { useMemo, useState } from 'react';
import { api, act, useApi } from '@/lib/client';
import { Field, Loading, Badge } from '@/components/ui';
import { STAGES, STAGE_LABEL, WORKFORCE_MODES } from '@/lib/constants';

const MODES = { ai: ['Start with AI employees', 'AI runs the roles; you review and approve. Switch to people later.'], human: ['Start with human employees', 'You are hiring (or have) a team. Roles start vacant.'], hybrid: ['Hybrid workforce', 'AI and humans share ownership of roles.'] } as const;

export default function Onboarding() {
  const tpl = useApi('/templates');
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ name: '', industry: '', businessModel: '', productService: '', targetCustomers: '', country: '', stage: 'idea', teamSize: '', budgetRange: '', description: '', website: '', objectives: ['', '', ''], workforceMode: 'hybrid', orgTemplate: 'solo' });
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const template = useMemo(() => tpl.data?.orgTemplates.find((t: any) => t.key === f.orgTemplate), [tpl.data, f.orgTemplate]);
  const names = useMemo(() => Object.fromEntries((tpl.data?.roleTemplates ?? []).map((r: any) => [r.key, r.name])), [tpl.data]);
  if (tpl.loading) return <Loading />;
  const set = (k: string) => (e: React.ChangeEvent<any>) => setF({ ...f, [k]: e.target.value });
  const canNext = step === 0 ? f.name.trim().length > 0 : true;

  async function create() {
    setBusy(true);
    const nodes = template?.nodes ?? [];
    const r = await act(() => api('POST', '/companies', {
      name: f.name, industry: f.industry, businessModel: f.businessModel, productService: f.productService, targetCustomers: f.targetCustomers, country: f.country,
      description: f.description, website: f.website, stage: f.stage, teamSize: f.teamSize === '' ? null : Number(f.teamSize), budgetRange: f.budgetRange,
      objectives: f.objectives.map((o) => o.trim()).filter(Boolean), workforceMode: f.workforceMode,
      orgTemplate: f.orgTemplate === 'custom' ? null : f.orgTemplate, includeNodeKeys: nodes.map((n: any) => n.key).filter((k: string) => !skip.has(k)),
    }));
    if (r) location.href = `/c/${r.company.id}/dashboard`; else setBusy(false);
  }
  const steps = ['Company', 'Workforce', 'Structure', 'Review'];
  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <div className="mb-6 flex items-center gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">F</div><div><h1 className="text-xl font-semibold">Set up your company</h1><p className="text-sm text-slate-500">Everything generated here is editable before and after you create the workspace.</p></div></div>
      <ol className="mb-6 flex gap-2" aria-label="Progress">{steps.map((s, i) => <li key={s} className={`flex-1 rounded-full px-3 py-1 text-center text-xs font-medium ${i === step ? 'bg-brand-600 text-white' : i < step ? 'bg-brand-100 text-brand-700' : 'bg-slate-200 text-slate-500'}`}>{i + 1}. {s}</li>)}</ol>
      <div className="card p-6">
        {step === 0 && (<div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="Company name *" id="n"><input id="n" className="input" value={f.name} onChange={set('name')} autoFocus /></Field></div>
          <Field label="Industry" id="i"><input id="i" className="input" value={f.industry} onChange={set('industry')} placeholder="e.g. Mobility, SaaS, Retail" /></Field>
          <Field label="Business model" id="bm"><input id="bm" className="input" value={f.businessModel} onChange={set('businessModel')} placeholder="e.g. B2C marketplace, subscription" /></Field>
          <div className="sm:col-span-2"><Field label="Product or service" id="ps"><input id="ps" className="input" value={f.productService} onChange={set('productService')} /></Field></div>
          <div className="sm:col-span-2"><Field label="Target customers" id="tc"><input id="tc" className="input" value={f.targetCustomers} onChange={set('targetCustomers')} /></Field></div>
          <Field label="Company stage" id="s"><select id="s" className="input" value={f.stage} onChange={set('stage')}>{STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}</select></Field>
          <Field label="Country / region" id="c"><input id="c" className="input" value={f.country} onChange={set('country')} /></Field>
          <Field label="Current team size" id="ts"><input id="ts" className="input" type="number" min={0} value={f.teamSize} onChange={set('teamSize')} /></Field>
          <Field label="Available budget" id="b"><input id="b" className="input" value={f.budgetRange} onChange={set('budgetRange')} placeholder="e.g. ₹5–10 lakh" /></Field>
          <div className="sm:col-span-2"><Field label="Business objectives" hint="Up to three goals for the next 6–12 months.">{f.objectives.map((o, i) => <input key={i} aria-label={`Objective ${i + 1}`} className="input mb-2" value={o} onChange={(e) => setF({ ...f, objectives: f.objectives.map((x, j) => (j === i ? e.target.value : x)) })} placeholder={`Objective ${i + 1}`} />)}</Field></div>
        </div>)}
        {step === 1 && (<fieldset className="space-y-3"><legend className="mb-2 font-medium">How do you want to start?</legend>
          {WORKFORCE_MODES.map((m) => <label key={m} className={`flex cursor-pointer gap-3 rounded-xl border p-4 ${f.workforceMode === m ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}><input type="radio" name="mode" checked={f.workforceMode === m} onChange={() => setF({ ...f, workforceMode: m })} className="mt-1" /><span><span className="block font-medium">{MODES[m][0]}</span><span className="text-sm text-slate-500">{MODES[m][1]}</span></span></label>)}
          <p className="text-xs text-slate-500">This sets the starting type of your roles. AI employees themselves are connected in Phase 2; you can change any role's type at any time.</p></fieldset>)}
        {step === 2 && (<div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">{tpl.data.orgTemplates.map((t: any) => <label key={t.key} className={`cursor-pointer rounded-xl border p-3 ${f.orgTemplate === t.key ? 'border-brand-500 bg-brand-50' : 'border-slate-200'}`}><input type="radio" className="sr-only" name="org" checked={f.orgTemplate === t.key} onChange={() => { setF({ ...f, orgTemplate: t.key }); setSkip(new Set()); }} /><span className="block font-medium">{t.name}</span><span className="text-xs text-slate-500">{t.description}</span></label>)}</div>
          {template?.nodes.length ? (<div><p className="mb-2 text-sm font-medium">Suggested roles — untick any you don't want:</p><ul className="space-y-1">{template.nodes.map((n: any) => { const depth = (function d(k: string | null): number { const p = template.nodes.find((x: any) => x.key === k); return p ? 1 + d(p.parent) : 0; })(n.parent); return (
            <li key={n.key} style={{ paddingLeft: depth * 24 }}><label className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-50"><input type="checkbox" checked={!skip.has(n.key)} onChange={(e) => { const s = new Set(skip); e.target.checked ? s.delete(n.key) : s.add(n.key); setSkip(s); }} /><span className="text-sm">{n.name ?? names[n.templateKey]}</span>{n.department && <Badge>{n.department}</Badge>}</label></li>); })}</ul></div>) : <p className="text-sm text-slate-500">You'll design your hierarchy from scratch in the Company Builder.</p>}
        </div>)}
        {step === 3 && (<dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-slate-500">Company</dt><dd className="font-medium">{f.name}</dd></div><div><dt className="text-slate-500">Stage</dt><dd className="font-medium">{STAGE_LABEL[f.stage as keyof typeof STAGE_LABEL]}</dd></div>
          <div><dt className="text-slate-500">Workforce</dt><dd className="font-medium">{MODES[f.workforceMode as keyof typeof MODES][0]}</dd></div><div><dt className="text-slate-500">Structure</dt><dd className="font-medium">{template?.name} — {template ? template.nodes.filter((n: any) => !skip.has(n.key)).length : 0} roles</dd></div>
          <div className="sm:col-span-2"><dt className="text-slate-500">Objectives</dt><dd>{f.objectives.filter(Boolean).join(' · ') || '—'}</dd></div>
          <p className="sm:col-span-2 rounded-lg bg-slate-50 p-3 text-slate-600">You'll be the company owner. After creation you can edit every role, responsibility, rule and permission.</p></dl>)}
      </div>
      <div className="mt-4 flex justify-between"><button className="btn-secondary" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Back</button>
        {step < 3 ? <button className="btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>Continue</button> : <button className="btn-primary" disabled={busy} onClick={create}>{busy ? 'Creating…' : 'Create company workspace'}</button>}</div>
    </main>
  );
}
