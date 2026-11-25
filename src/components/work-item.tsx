'use client';
import { useState } from 'react';
import { act, api } from '@/lib/client';
import { Badge, fmtDate, titleCase } from './ui';

export function WorkItem({ cid, w, onDone }: { cid: string; w: any; onDone: () => void }) {
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false);
  async function review(decision: 'approve' | 'reject') { setBusy(true); const r = await act(() => api('POST', `/companies/${cid}/ai-work-items/${w.id}/review`, { decision, note }), decision === 'approve' ? 'Approved' : 'Rejected'); setBusy(false); if (r) onDone(); }
  return (
    <li className="card p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium">{w.title} <Badge tone={w.kind === 'action' ? 'amber' : w.kind === 'draft' ? 'brand' : 'slate'}>{w.kind}</Badge> <Badge tone={w.status === 'executed' || w.status === 'approved' ? 'green' : w.status === 'pending_review' ? 'amber' : 'slate'}>{titleCase(w.status)}</Badge></p><span className="text-xs text-slate-400">◉ {w.agentName} · {fmtDate(w.createdAt)}</span></div>
      <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">{w.body}</pre>
      {w.kind === 'action' && w.status === 'pending_review' && <p className="mt-2 text-xs text-amber-700">Approving will run “{w.toolKey}” with the arguments above.</p>}
      {w.result && <p className="mt-2 text-sm text-slate-600">Result: {w.result}</p>}
      {w.status === 'pending_review' && w.canReview && <div className="mt-3 flex flex-wrap gap-2"><input aria-label="Review note" className="input max-w-xs" placeholder="Optional note" value={note} onChange={(e) => setNote(e.target.value)} /><button className="btn-primary" disabled={busy} onClick={() => review('approve')}>{w.kind === 'action' ? 'Approve & run' : 'Approve'}</button><button className="btn-secondary" disabled={busy} onClick={() => review('reject')}>Reject</button></div>}</li>
  );
}

