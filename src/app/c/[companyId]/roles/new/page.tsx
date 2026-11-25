'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useCompany } from '@/components/company';
import { PermissionMatrix, type Grant } from '@/components/permission-matrix';
import { ErrorBox, Field, Loading, PageHeader } from '@/components/ui';
import { ALL_PERMISSION_KEYS, FREQUENCIES, PRIORITIES, REPORTING_FREQUENCIES, ROLE_TYPES, ROLE_TYPE_LABEL, RULE_KINDS } from '@/lib/constants';
import { act, api, useApi } from '@/lib/client';

type Resp = { title: string; description: string; expectedOutcome: string; priority: string; frequency: string; requiresApproval: boolean };
const blankResp = (): Resp => ({ title: '', description: '', expectedOutcome: '', priority: 'medium', frequency: 'ongoing', requiresApproval: false });
const STEPS = ['Basics', 'Responsibilities', 'Rules', 'KPIs', 'Permissions', 'Review'];

function Wizard() {
  const { id, can, me } = useCompany();
  const tpl = useApi('/templates'); const roles = useApi(`/companies/${id}/roles`); const depts = useApi(`/companies/${id}/departments`);
  const [step, setStep] = useState(0); const [busy, setBusy] = useState(false);
  const [b, setB] = useState<any>({ name: '', description: '', departmentId: '', reportsToRoleId: '', roleType: 'vacant', reportingFrequency: 'weekly', hasApprovalAuthority: false, approvalLimit: '', templateKey: '' });
  const [resp, setResp] = useState<Resp[]>([]); const [rules, setRules] = useState<{ kind: string; text: string }[]>([]);
  const [kpis, setKpis] = useState<{ name: string; target: string; unit: string; period: string }[]>([]); const [grants, setGrants] = useState<Grant[]>([]);
  const [newDept, setNewDept] = useState('');
  const canPerms = can('permissions.configure');
  const myKeys = useMemo(() => (me.accessLevel === 'owner' ? null : new Set<string>(ALL_PERMISSION_KEYS.filter((k) => can(k)))), [me, can]);

  function applyTemplate(key: string) {
    const t = tpl.data.roleTemplates.find((x: any) => x.key === key);
    if (!t) { setB((p: any) => ({ ...p, templateKey: '' })); return; }
    const d = depts.data?.departments.find((x: any) => x.name.toLowerCase() === t.department.toLowerCase());
    setB((p: any) => ({ ...p, templateKey: key, name: t.name, description: t.description, reportingFrequency: t.reportingFrequency, hasApprovalAuthority: t.hasApprovalAuthority, departmentId: d?.id ?? p.departmentId }));
    setResp(t.responsibilities.map((r: any) => ({ ...blankResp(), ...r, description: r.description ?? '', expectedOutcome: r.expectedOutcome ?? '', requiresApproval: !!r.requiresApproval })));
    setRules(t.rules.map((r: any) => ({ ...r }))); setKpis(t.kpis.map((k: any) => ({ name: k.name, target: k.target ?? '', unit: k.unit ?? '', period: k.period ?? 'monthly' })));
    setGrants(t.permissions.map((k: string) => { const [key, scope] = k.split(':'); return { key, scope: (scope ?? 'company') as Grant['scope'] }; }));
  }
  useEffect(() => {
    if (!tpl.data || !depts.data) return;
    const q = new URLSearchParams(location.search);
    if (q.get('template')) applyTemplate(q.get('template')!);
    if (q.get('parent')) setB((p: any) => ({ ...p, reportsToRoleId: q.get('parent') }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tpl.data, depts.data]);

  if (tpl.loading || roles.loading || depts.loading) return <Loading />;
  if (tpl.error || roles.error || depts.error) return <ErrorBox error={(tpl.error ?? roles.error ?? depts.error)!} />;
  const sb = (k: string) => (e: React.ChangeEvent<any>) => setB({ ...b, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const move = <T,>(arr: T[], i: number, d: number) => { const a = [...arr]; const j = i + d; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; };

  async function create() {
    setBusy(true);
    let departmentId = b.departmentId || null;
    if (newDept.trim() && !departmentId) { const d = await act(() => api('POST', `/companies/${id}/departments`, { name: newDept.trim() })); if (!d) return setBusy(false); departmentId = d.department.id; }
    const body: any = {
      name: b.name, description: b.description, departmentId, reportsToRoleId: b.reportsToRoleId || null, roleType: b.roleType, reportingFrequency: b.reportingFrequency,
      hasApprovalAuthority: b.hasApprovalAuthority, approvalLimit: b.hasApprovalAuthority && b.approvalLimit !== '' ? Number(b.approvalLimit) : null, templateKey: b.templateKey || null,
      responsibilities: resp.filter((r) => r.title.trim()), rules: rules.filter((r) => r.text.trim()), kpis: kpis.filter((k) => k.name.trim()),
    };
    if (canPerms) body.permissions = grants;
    const r = await act(() => api('POST', `/companies/${id}/roles`, body), 'Role created');
    if (r) location.href = `/c/${id}/roles/${r.role.id}`; else setBusy(false);
  }
  const reportsTo = roles.data.roles.find((r: any) => r.id === b.reportsToRoleId)?.name;
  return (
    <>
      <PageHeader title="Create role" subtitle="Start from a template or build a custom role. You can change everything later." />
      <ol className="mb-5 flex flex-wrap gap-2" aria-label="Steps">{STEPS.map((s, i) => <li key={s}><button onClick={() => (b.name.trim() || i === 0) && setStep(i)} className={`rounded-full px-3 py-1 text-xs font-medium ${i === step ? 'bg-brand-600 text-white' : i < step ? 'bg-brand-100 text-brand-700' : 'bg-slate-200 text-slate-500'}`}>{i + 1}. {s}</button></li>)}</ol>
      <div className="card p-6">
        {step === 0 && (<div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2"><Field label="Start from a template" id="t"><select id="t" className="input" value={b.templateKey} onChange={(e) => applyTemplate(e.target.value)}><option value="">Custom role (blank)</option>{tpl.data.roleTemplates.map((t: any) => <option key={t.key} value={t.key}>{t.name}</option>)}</select></Field></div>
          <Field label="Role name *" id="n"><input id="n" className="input" required value={b.name} onChange={sb('name')} /></Field>
          <Field label="Role type" id="rty"><select id="rty" className="input" value={b.roleType} onChange={sb('roleType')}>{ROLE_TYPES.map((t) => <option key={t} value={t}>{ROLE_TYPE_LABEL[t]}</option>)}</select></Field>
          <Field label="Department" id="d"><select id="d" className="input" value={b.departmentId} onChange={sb('departmentId')}><option value="">— None —</option>{depts.data.departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          {can('departments.create') && !b.departmentId ? <Field label="…or create a new department" id="nd"><input id="nd" className="input" value={newDept} onChange={(e) => setNewDept(e.target.value)} placeholder="e.g. Customer Success" /></Field> : <div />}
          <Field label="Reports to" id="rt"><select id="rt" className="input" value={b.reportsToRoleId} onChange={sb('reportsToRoleId')}><option value="">— Founder (top level) —</option>{roles.data.roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
          <Field label="Reporting frequency" id="rf"><select id="rf" className="input" value={b.reportingFrequency} onChange={sb('reportingFrequency')}>{REPORTING_FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}</select></Field>
          <div className="sm:col-span-2"><Field label="Description" id="ds"><textarea id="ds" rows={3} className="input" value={b.description ?? ''} onChange={sb('description')} /></Field></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={b.hasApprovalAuthority} onChange={sb('hasApprovalAuthority')} /> This role has approval authority</label>
          {b.hasApprovalAuthority && <Field label="Approval limit (amount, optional)" id="al"><input id="al" type="number" min={0} className="input" value={b.approvalLimit} onChange={sb('approvalLimit')} /></Field>}
        </div>)}
        {step === 1 && (<div className="space-y-3">{resp.length === 0 && <p className="text-sm text-slate-500">No responsibilities yet. Add the outcomes this role is accountable for.</p>}
          {resp.map((r, i) => (<div key={i} className="rounded-lg border border-slate-200 p-3"><div className="grid gap-2 sm:grid-cols-2">
            <input aria-label="Responsibility title" className="input sm:col-span-2" placeholder="Responsibility title" value={r.title} onChange={(e) => setResp(resp.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
            <input aria-label="Description" className="input sm:col-span-2" placeholder="Description" value={r.description} onChange={(e) => setResp(resp.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} />
            <input aria-label="Expected outcome" className="input sm:col-span-2" placeholder="Expected outcome" value={r.expectedOutcome} onChange={(e) => setResp(resp.map((x, j) => (j === i ? { ...x, expectedOutcome: e.target.value } : x)))} />
            <select aria-label="Priority" className="input" value={r.priority} onChange={(e) => setResp(resp.map((x, j) => (j === i ? { ...x, priority: e.target.value } : x)))}>{PRIORITIES.map((p) => <option key={p}>{p}</option>)}</select>
            <select aria-label="Frequency" className="input" value={r.frequency} onChange={(e) => setResp(resp.map((x, j) => (j === i ? { ...x, frequency: e.target.value } : x)))}>{FREQUENCIES.map((p) => <option key={p}>{p}</option>)}</select></div>
            <div className="mt-2 flex items-center justify-between"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={r.requiresApproval} onChange={(e) => setResp(resp.map((x, j) => (j === i ? { ...x, requiresApproval: e.target.checked } : x)))} /> Needs approval</label>
              <div className="flex gap-1"><button className="btn-ghost px-2" aria-label="Move up" onClick={() => setResp(move(resp, i, -1))}>↑</button><button className="btn-ghost px-2" aria-label="Move down" onClick={() => setResp(move(resp, i, 1))}>↓</button><button className="btn-ghost px-2 text-red-600" onClick={() => setResp(resp.filter((_, j) => j !== i))}>Remove</button></div></div></div>))}
          <button className="btn-secondary" onClick={() => setResp([...resp, blankResp()])}>＋ Add responsibility</button></div>)}
        {step === 2 && (<div className="space-y-2"><p className="text-sm text-slate-500">Rules describe what this role may, may not, or may only do with approval.</p>
          {rules.map((r, i) => <div key={i} className="flex gap-2"><select aria-label="Rule type" className="input w-44" value={r.kind} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, kind: e.target.value } : x)))}>{RULE_KINDS.map((k) => <option key={k} value={k}>{k === 'allow' ? 'Can' : k === 'deny' ? 'Cannot' : 'Needs approval'}</option>)}</select><input aria-label="Rule text" className="input" value={r.text} onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} /><button className="btn-ghost text-red-600" onClick={() => setRules(rules.filter((_, j) => j !== i))}>✕</button></div>)}
          <button className="btn-secondary" onClick={() => setRules([...rules, { kind: 'allow', text: '' }])}>＋ Add rule</button></div>)}
        {step === 3 && (<div className="space-y-2"><p className="text-sm text-slate-500">Define how success is measured. Targets are tracked in a later phase.</p>
          {kpis.map((k, i) => <div key={i} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]"><input aria-label="KPI name" className="input" placeholder="KPI name" value={k.name} onChange={(e) => setKpis(kpis.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /><input aria-label="Target" className="input" placeholder="Target" value={k.target} onChange={(e) => setKpis(kpis.map((x, j) => (j === i ? { ...x, target: e.target.value } : x)))} /><input aria-label="Unit" className="input" placeholder="Unit" value={k.unit} onChange={(e) => setKpis(kpis.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))} /><select aria-label="Period" className="input" value={k.period} onChange={(e) => setKpis(kpis.map((x, j) => (j === i ? { ...x, period: e.target.value } : x)))}>{REPORTING_FREQUENCIES.filter((f) => f !== 'none').map((f) => <option key={f}>{f}</option>)}</select><button className="btn-ghost text-red-600" onClick={() => setKpis(kpis.filter((_, j) => j !== i))}>✕</button></div>)}
          <button className="btn-secondary" onClick={() => setKpis([...kpis, { name: '', target: '', unit: '', period: 'monthly' }])}>＋ Add KPI</button></div>)}
        {step === 4 && (<div className="space-y-3"><p className="text-sm text-slate-500">What the holder of this role can do in the system. Reporting lines never grant access by themselves.</p>
          {canPerms ? <PermissionMatrix grants={grants} onChange={setGrants} allowedKeys={myKeys} /> : <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">You don't have permission to configure permissions. The role will be created with safe defaults limited to what you hold; an owner can adjust them.</p>}</div>)}
        {step === 5 && (<dl className="grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-slate-500">Role</dt><dd className="font-medium">{b.name || '—'}</dd></div><div><dt className="text-slate-500">Type</dt><dd className="font-medium">{ROLE_TYPE_LABEL[b.roleType as keyof typeof ROLE_TYPE_LABEL]}</dd></div>
          <div><dt className="text-slate-500">Reports to</dt><dd className="font-medium">{reportsTo ?? 'Founder'}</dd></div><div><dt className="text-slate-500">Department</dt><dd className="font-medium">{depts.data.departments.find((d: any) => d.id === b.departmentId)?.name ?? (newDept || '—')}</dd></div>
          <div><dt className="text-slate-500">Responsibilities</dt><dd className="font-medium">{resp.filter((r) => r.title.trim()).length}</dd></div><div><dt className="text-slate-500">Rules / KPIs</dt><dd className="font-medium">{rules.filter((r) => r.text.trim()).length} / {kpis.filter((k) => k.name.trim()).length}</dd></div>
          <div><dt className="text-slate-500">Permissions</dt><dd className="font-medium">{canPerms ? `${grants.length} granted` : 'safe defaults'}</dd></div></dl>)}
      </div>
      <div className="mt-4 flex justify-between"><button className="btn-secondary" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Back</button>
        {step < 5 ? <button className="btn-primary" disabled={!b.name.trim()} onClick={() => setStep(step + 1)}>Continue</button> : <button className="btn-primary" disabled={busy || !b.name.trim()} onClick={create}>{busy ? 'Creating…' : 'Create role'}</button>}</div>
    </>
  );
}
export default function Page() { return <Suspense><Wizard /></Suspense>; }
