'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, act } from '@/lib/client';
import { AuthShell, Field } from '@/components/ui';

export default function Page() {
  const [f, setF] = useState({ name: '', email: '', password: '' }); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const ok = await act(() => api('POST', '/auth/register', f));
    if (ok) { const next = new URLSearchParams(location.search).get('next'); location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'; } else setBusy(false);
  }
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <AuthShell title="Create your account" subtitle="Build your startup with AI. Scale with people.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Full name" id="n"><input id="n" className="input" required value={f.name} onChange={set('name')} autoComplete="name" /></Field>
        <Field label="Work email" id="e"><input id="e" className="input" type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></Field>
        <Field label="Password" id="p" hint="At least 8 characters, with a letter and a number."><input id="p" className="input" type="password" required minLength={8} value={f.password} onChange={set('password')} autoComplete="new-password" /></Field>
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="text-center text-sm text-slate-500">Already registered? <Link className="text-brand-700 hover:underline" href="/login">Sign in</Link></p>
      </form>
    </AuthShell>
  );
}
