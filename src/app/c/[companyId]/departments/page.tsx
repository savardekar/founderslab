'use client';
import { useState } from 'react';
import { useCompany } from '@/components/company';
import { Confirm, Empty, ErrorBox, Field, Loading, Modal, PageHeader } from '@/components/ui';
import { act, api, useApi } from '@/lib/client';

export default function Departments() {
  const { id, can } = useCompany();
  const d = useApi(`/companies/${id}/departments`);
  const [edit, setEdit] = useState<{ id?: string; name: string; description: string } | null>(null);
  const [del, setDel] = useState<any>(null);
  if (d.loading) return <Loading />;
  if (d.error) return <ErrorBox error={d.error} retry={d.reload} />;
  const list = d.data.departments;
  return (
    <>
      <PageHeader title="Departments" subtitle="Group roles by function. Departments can be used to scope permissions." actions={can('departments.create') && <button className="btn-primary" onClick={() => setEdit({ name: '', description: '' })}>Add department</button>} />
      {list.length === 0 ? <Empty title="No departments yet" hint="Create departments such as Marketing, Operations or Finance, then place roles in them." /> : (
        <div className="card divide-y divide-slate-100">{list.map((x: any) => (
          <div key={x.id} className="flex items-center justify-between gap-4 p-4"><div><p className="font-medium">{x.name}</p><p className="text-sm text-slate-500">{x.description || 'No description'} · {x.roleCount} role{x.roleCount === 1 ? '' : 's'}</p></div>
            <div className="flex gap-2">{can('departments.edit') && <button className="btn-secondary" onClick={() => setEdit({ id: x.id, name: x.name, description: x.description ?? '' })}>Edit</button>}{can('departments.delete') && <button className="btn-ghost text-red-600" onClick={() => setDel(x)}>Delete</button>}</div></div>))}</div>)}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit department' : 'New department'}>
        {edit && <form className="space-y-4" onSubmit={async (e) => { e.preventDefault(); const body = { name: edit.name, description: edit.description }; if (await act(() => (edit.id ? api('PATCH', `/companies/${id}/departments/${edit.id}`, body) : api('POST', `/companies/${id}/departments`, body)), 'Saved')) { setEdit(null); d.reload(); } }}>
          <Field label="Name" id="dn"><input id="dn" className="input" required autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="Description" id="dd"><textarea id="dd" className="input" rows={3} value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
          <div className="flex justify-end gap-2"><button type="button" className="btn-secondary" onClick={() => setEdit(null)}>Cancel</button><button className="btn-primary">Save</button></div></form>}
      </Modal>
      <Confirm open={!!del} danger title="Delete department?" confirmLabel="Delete" onClose={() => setDel(null)} message={<>“{del?.name}” will be archived. Its {del?.roleCount} role(s) are kept and become unassigned to a department.</>} onConfirm={async () => { if (await act(() => api('DELETE', `/companies/${id}/departments/${del.id}`), 'Department archived')) { setDel(null); d.reload(); } }} />
    </>
  );
}
