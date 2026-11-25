'use client';
import { ACTIONS, RESOURCES, type Resource } from '@/lib/constants';

export type Grant = { key: string; scope: 'company' | 'department' | 'own' };

/** Resource × action grid. `showScope` adds a per-resource scope selector (company / own department / own role). */
export function PermissionMatrix({ grants, onChange, disabled, showScope = true, allowedKeys }: { grants: Grant[]; onChange: (g: Grant[]) => void; disabled?: boolean; showScope?: boolean; allowedKeys?: Set<string> | null }) {
  const has = (k: string) => grants.find((g) => g.key === k);
  const rowScope = (r: string) => grants.find((g) => g.key.startsWith(r + '.'))?.scope ?? 'company';
  const toggle = (r: string, a: string) => {
    const k = `${r}.${a}`;
    onChange(has(k) ? grants.filter((g) => g.key !== k) : [...grants, { key: k, scope: rowScope(r) }]);
  };
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-2 text-left">Resource</th>{ACTIONS.map((a) => <th key={a} className="p-2 text-center font-medium">{a}</th>)}{showScope && <th className="p-2 text-left">Scope</th>}</tr></thead>
        <tbody className="divide-y divide-slate-100">{(Object.keys(RESOURCES) as Resource[]).map((r) => (
          <tr key={r}><th scope="row" className="whitespace-nowrap p-2 text-left font-medium">{RESOURCES[r]}</th>
            {ACTIONS.map((a) => { const k = `${r}.${a}`; const locked = allowedKeys ? !allowedKeys.has(k) && !has(k) : false; return (
              <td key={a} className="p-2 text-center"><input type="checkbox" aria-label={`${r} ${a}`} checked={!!has(k)} disabled={disabled || locked} title={locked ? 'You cannot grant a permission you do not hold' : undefined} onChange={() => toggle(r, a)} /></td>); })}
            {showScope && <td className="p-2"><select aria-label={`${r} scope`} className="input py-1 text-xs" disabled={disabled} value={rowScope(r)} onChange={(e) => onChange(grants.map((g) => (g.key.startsWith(r + '.') ? { ...g, scope: e.target.value as Grant['scope'] } : g)))}><option value="company">Whole company</option><option value="department">Own department</option><option value="own">Own role only</option></select></td>}
          </tr>))}</tbody></table>
    </div>
  );
}
