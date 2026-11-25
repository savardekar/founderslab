'use client';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { api, act } from '@/lib/client';
import { AuthShell, Field } from '@/components/ui';

function Form() {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    const ok = await act(() => api('POST', '/auth/login', { email, password }));
    if (ok) { const next = new URLSearchParams(location.search).get('next'); location.href = next && next.startsWith('/') && !next.startsWith('//') ? next : '/'; } else setBusy(false);
  }
  return (
    <AuthShell title="Welcome back" subtitle="Sign in to your FoundersLab workspace">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email" id="email"><input id="email" className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password" id="pw"><input id="pw" className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <button className="btn-primary w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="flex justify-between text-sm"><Link className="text-brand-700 hover:underline" href="/forgot-password">Forgot password?</Link><Link className="text-brand-700 hover:underline" href="/register">Create account</Link></div>
      </form>
    </AuthShell>
  );
}
export default function Page() { return <Suspense><Form /></Suspense>; }
