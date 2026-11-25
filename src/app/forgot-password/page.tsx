'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, act } from '@/lib/client';
import { AuthShell, Field } from '@/components/ui';

export default function Page() {
  const [email, setEmail] = useState(''); const [done, setDone] = useState<{ devLink?: string } | null>(null);
  async function submit(e: React.FormEvent) { e.preventDefault(); const r = await act(() => api('POST', '/auth/forgot-password', { email })); if (r) setDone(r); }
  return (
    <AuthShell title="Reset your password" subtitle="We'll send a reset link if the account exists">
      {done ? (
        <div className="space-y-3 text-sm"><p>If an account exists for <b>{email}</b>, a reset link has been sent.</p>
          {done.devLink && <p className="rounded-lg bg-amber-50 p-3 text-amber-900">Development mode (no email provider configured): <Link className="font-medium underline" href={done.devLink.replace(/^https?:\/\/[^/]+/, '')}>open reset link</Link></p>}
          <Link href="/login" className="text-brand-700 hover:underline">Back to sign in</Link></div>
      ) : (
        <form onSubmit={submit} className="space-y-4"><Field label="Email" id="e"><input id="e" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field><button className="btn-primary w-full">Send reset link</button><p className="text-center text-sm"><Link href="/login" className="text-brand-700 hover:underline">Back to sign in</Link></p></form>
      )}
    </AuthShell>
  );
}
