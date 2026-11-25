'use client';
import { useState } from 'react';
import { act, api } from '@/lib/client';
import { Confirm, Field, Modal } from './ui';

type RoleLite = { id: string; name: string; reportsToRoleId: string | null };

/** All role ids in the subtree of `rootId` (a role cannot report to its own descendants). */
export function subtreeIds(roles: RoleLite[], rootId: string) {
  const out = new Set<string>([rootId]); let grew = true;
  while (grew) { grew = false; for (const r of roles) if (r.reportsToRoleId && out.has(r.reportsToRoleId) && !out.has(r.id)) { out.add(r.id); grew = true; } }
  return out;
}

export function MoveRoleModal({ cid, role, roles, onClose, onDone }: { cid: string; role: RoleLite | null; roles: RoleLite[]; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState<string>('');
  const [touched, setTouched] = useState(false);
  if (!role) return null;
  const blocked = subtreeIds(roles, role.id);
  return (
    <Modal open onClose={onClose} title={`Change reporting manager — ${role.name}`}>
      <Field label="Reports to" id="rt" hint="This only changes the org chart. Access is controlled by permissions, not by who reports to whom.">
        <select id="rt" className="input" value={to || (role.reportsToRoleId ?? '')} onChange={(e) => { setTo(e.target.value); setTouched(true); }}>
          <option value="">— Top level (reports to the founder) —</option>
          {roles.filter((r) => !blocked.has(r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </Field>
      <div className="mt-5 flex justify-end gap-2"><button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={async () => { if (await act(() => api('PUT', `/companies/${cid}/roles/${role.id}/move`, { reportsToRoleId: (to === '' ? (role.reportsToRoleId && touched ? null : role.reportsToRoleId) : to) }), 'Reporting line updated')) onDone(); }}>Save</button></div>
    </Modal>
  );
}

export function DeleteRoleConfirm({ cid, role, onClose, onDone }: { cid: string; role: (RoleLite & { assignees?: any[] }) | null; onClose: () => void; onDone: () => void }) {
  return (
    <Confirm open={!!role} danger title="Delete role?" confirmLabel="Delete role" onClose={onClose}
      message={<>“{role?.name}” will be removed from the organization. Its direct reports move up to its manager, its people are unassigned, and its history stays in the audit log. This cannot be undone from the UI.</>}
      onConfirm={async () => { if (await act(() => api('DELETE', `/companies/${cid}/roles/${role!.id}`, {}), 'Role deleted')) onDone(); }} />
  );
}
