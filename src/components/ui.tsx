'use client';
import { useEffect, useState, type ReactNode } from 'react';

// ── toasts ──
type T = { id: number; msg: string; kind: 'ok' | 'error' };
let push: ((t: T) => void) | null = null;
export const toast = (msg: string, kind: 'ok' | 'error' = 'ok') => push?.({ id: Date.now() + Math.random(), msg, kind });
export function Toasts() {
  const [items, setItems] = useState<T[]>([]);
  useEffect(() => { push = (t) => { setItems((x) => [...x, t]); setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 4500); }; return () => { push = null; }; }, []);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-80 flex-col gap-2" role="status" aria-live="polite">
      {items.map((t) => (<div key={t.id} className={`pointer-events-auto rounded-lg px-4 py-3 text-sm shadow-lg ${t.kind === 'ok' ? 'bg-slate-900 text-white' : 'bg-red-600 text-white'}`}>{t.msg}</div>))}
    </div>
  );
}

export const Spinner = () => <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-label="Loading" />;
export const Loading = () => <div className="flex justify-center p-12"><Spinner /></div>;
export const ErrorBox = ({ error, retry }: { error: Error; retry?: () => void }) => (
  <div className="card border-red-200 bg-red-50 p-6 text-sm text-red-800"><p className="font-medium">Something went wrong</p><p className="mt-1">{error.message}</p>{retry && <button className="btn-secondary mt-3" onClick={retry}>Try again</button>}</div>
);
export const Empty = ({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) => (
  <div className="card flex flex-col items-center gap-2 p-10 text-center"><p className="font-medium text-slate-700">{title}</p>{hint && <p className="max-w-md text-sm text-slate-500">{hint}</p>}{action}</div>
);
export const Badge = ({ children, tone = 'slate' }: { children: ReactNode; tone?: 'slate' | 'brand' | 'green' | 'amber' | 'red' | 'violet' }) => {
  const c = { slate: 'bg-slate-100 text-slate-700', brand: 'bg-brand-50 text-brand-700', green: 'bg-emerald-50 text-emerald-700', amber: 'bg-amber-50 text-amber-800', red: 'bg-red-50 text-red-700', violet: 'bg-violet-50 text-violet-700' }[tone];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${c}`}>{children}</span>;
};
export const roleTone = (t: string) => (t === 'ai' ? 'violet' : t === 'human' ? 'green' : t === 'hybrid' ? 'brand' : 'amber') as 'violet' | 'green' | 'brand' | 'amber';

export function Field({ label, hint, children, id }: { label: string; hint?: string; children: ReactNode; id?: string }) {
  return (<div><label className="label" htmlFor={id}>{label}</label>{children}{hint && <p className="mt-1 text-xs text-slate-500">{hint}</p>}</div>);
}
export const PageHeader = ({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) => (
  <div className="mb-6 flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-2xl font-semibold tracking-tight">{title}</h1>{subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}</div><div className="flex gap-2">{actions}</div></div>
);

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEffect(() => { if (!open) return; const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h); }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/50 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`card my-8 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} p-6`}>
        <div className="mb-4 flex items-center justify-between"><h2 className="text-lg font-semibold">{title}</h2><button className="btn-ghost -mr-2 px-2" onClick={onClose} aria-label="Close">✕</button></div>
        {children}
      </div>
    </div>
  );
}
export function Confirm({ open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onClose }: { open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="text-sm text-slate-600">{message}</div>
      <div className="mt-6 flex justify-end gap-2">
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
        <button className={danger ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string }[]; value: T; onChange: (t: T) => void }) {
  return (<div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">{tabs.map((t) => (
    <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={`whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium ${value === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{t.label}</button>))}</div>);
}
export const AuthShell = ({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) => (
  <main className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 via-white to-slate-100 p-4">
    <div className="w-full max-w-md">
      <div className="mb-6 text-center"><div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-lg font-bold text-white">F</div><h1 className="text-2xl font-semibold">{title}</h1>{subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}</div>
      <div className="card p-6">{children}</div>
    </div>
  </main>
);
export const fmtDate = (d: string | Date) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export const titleCase = (s: string) => s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
